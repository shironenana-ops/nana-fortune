import { randomUUID } from "node:crypto";
import { DynamoDBClient, GetItemCommand, PutItemCommand, TransactWriteItemsCommand, UpdateItemCommand, type AttributeValue } from "@aws-sdk/client-dynamodb";
import { ServerFoundationError } from "../http/errors";
import { fingerprintsEqual } from "./requestFingerprint";
import type { BeginResult, ReadingPersistence, Reservation, StoredReading } from "./readingPersistence";
import type { ReadingPersistenceConfig } from "./persistenceConfig";

type Sender = { send(command: GetItemCommand|PutItemCommand|UpdateItemCommand|TransactWriteItemsCommand): Promise<any> };
const S = (value: string): AttributeValue => ({ S: value });
const N = (value: number): AttributeValue => ({ N: String(value) });
function conditional(error: unknown): boolean { return !!error && typeof error === "object" && (error as {name?:string}).name === "ConditionalCheckFailedException"; }
function text(item: Record<string, AttributeValue>, key: string): string { const value=item[key]; return value && "S" in value ? value.S ?? "" : ""; }
function number(item: Record<string, AttributeValue>, key: string): number { const value=item[key]; return value && "N" in value ? Number(value.N) : NaN; }
function safeStored(item?: Record<string, AttributeValue>): StoredReading {
  if (!item || text(item,"schema_version") !== "shirone-reading-history-v1" || text(item,"status") !== "completed") throw new ServerFoundationError("HISTORY_UNAVAILABLE");
  let parsed: unknown; try { parsed=JSON.parse(text(item,"public_result")); } catch { throw new ServerFoundationError("HISTORY_UNAVAILABLE"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ServerFoundationError("HISTORY_UNAVAILABLE");
  const value=parsed as Record<string,unknown>;
  if (value.status !== "completed" || !value.result || typeof value.result !== "object") throw new ServerFoundationError("HISTORY_UNAVAILABLE");
  return { history_id:text(item,"history_id"), created_at:text(item,"created_at"), resolved_mode:text(item,"resolved_mode") as StoredReading["resolved_mode"], status:"completed", rendering_status:value.rendering_status as StoredReading["rendering_status"], result:value.result as StoredReading["result"] };
}

export class DynamoReadingPersistence implements ReadingPersistence {
  constructor(private readonly sender: Sender, private readonly config: ReadingPersistenceConfig, private readonly uuid:()=>string=randomUUID) {}
  private reservation(params:{requestRef:string;fingerprint:string;resolvedMode:Reservation["resolvedMode"];readingDate:string;now:Date}):Reservation {
    return { requestRef:params.requestRef, fingerprint:params.fingerprint, ownerToken:this.uuid(), historyId:this.uuid(), readingDate:params.readingDate, resolvedMode:params.resolvedMode, createdAt:params.now.toISOString() };
  }
  async begin(params:{requestRef:string;fingerprint:string;userId:string;resolvedMode:Reservation["resolvedMode"];readingDate:string;now:Date}):Promise<BeginResult> {
    const reservation=this.reservation(params); const now=Math.floor(params.now.getTime()/1000);
    const item={ request_ref:S(params.requestRef), schema_version:S("shirone-reading-idempotency-v1"), fingerprint:S(params.fingerprint), state:S("IN_PROGRESS"), owner_token:S(reservation.ownerToken), history_id:S(reservation.historyId), resolved_mode:S(params.resolvedMode), reading_date:S(params.readingDate), created_at:S(reservation.createdAt), updated_at:S(reservation.createdAt), lease_expires_at:N(now+this.config.leaseSeconds), expires_at:N(now+this.config.ttlSeconds) };
    try { await this.sender.send(new PutItemCommand({TableName:this.config.idempotencyTable,Item:item,ConditionExpression:"attribute_not_exists(request_ref)"})); return {kind:"acquired",reservation,takeover:false}; }
    catch(error) { if(!conditional(error)) throw new ServerFoundationError("PERSISTENCE_UNAVAILABLE",{cause:error}); }
    let existing:Record<string,AttributeValue>|undefined;
    try { existing=(await this.sender.send(new GetItemCommand({TableName:this.config.idempotencyTable,Key:{request_ref:S(params.requestRef)},ConsistentRead:true}))).Item; }
    catch(error){ throw new ServerFoundationError("PERSISTENCE_UNAVAILABLE",{cause:error}); }
    if(!existing) throw new ServerFoundationError("PERSISTENCE_UNAVAILABLE");
    if(!fingerprintsEqual(text(existing,"fingerprint"),params.fingerprint)) return {kind:"conflict"};
    if(text(existing,"state") === "COMPLETED") {
      try { const result=await this.sender.send(new GetItemCommand({TableName:this.config.historyTable,Key:{user_id:S(params.userId),history_id:S(text(existing,"history_id"))},ConsistentRead:true})); return {kind:"replay",history:safeStored(result.Item)}; }
      catch(error){ if(error instanceof ServerFoundationError) throw error; throw new ServerFoundationError("HISTORY_UNAVAILABLE",{cause:error}); }
    }
    const reclaim = text(existing,"state") === "FAILED" || number(existing,"lease_expires_at") <= now || number(existing,"expires_at") <= now;
    if(!reclaim) return {kind:"in_progress"};
    const takeover={...reservation,historyId:text(existing,"history_id")||reservation.historyId,createdAt:text(existing,"created_at")||reservation.createdAt};
    try { await this.sender.send(new UpdateItemCommand({TableName:this.config.idempotencyTable,Key:{request_ref:S(params.requestRef)},UpdateExpression:"SET #state=:progress, owner_token=:owner, updated_at=:updated, lease_expires_at=:lease, expires_at=:ttl REMOVE failure_category",ConditionExpression:"fingerprint=:fingerprint AND (#state=:failed OR lease_expires_at<=:now OR expires_at<=:now)",ExpressionAttributeNames:{"#state":"state"},ExpressionAttributeValues:{":progress":S("IN_PROGRESS"),":failed":S("FAILED"),":owner":S(takeover.ownerToken),":updated":S(params.now.toISOString()),":lease":N(now+this.config.leaseSeconds),":ttl":N(now+this.config.ttlSeconds),":now":N(now),":fingerprint":S(params.fingerprint)}})); return {kind:"acquired",reservation:takeover,takeover:true}; }
    catch(error){ if(conditional(error)) return {kind:"in_progress"}; throw new ServerFoundationError("PERSISTENCE_UNAVAILABLE",{cause:error}); }
  }
  async complete(params:{reservation:Reservation;userId:string;response:any;now:Date}):Promise<StoredReading> {
    const stored:StoredReading={history_id:params.reservation.historyId,created_at:params.reservation.createdAt,resolved_mode:params.response.resolved_mode,status:"completed",rendering_status:params.response.rendering_status,result:params.response.result};
    const json=JSON.stringify({resolved_mode:stored.resolved_mode,status:stored.status,rendering_status:stored.rendering_status,result:stored.result});
    if(Buffer.byteLength(json,"utf8")>300_000) throw new ServerFoundationError("PERSISTENCE_UNAVAILABLE");
    const history={user_id:S(params.userId),history_id:S(stored.history_id),schema_version:S("shirone-reading-history-v1"),status:S("completed"),resolved_mode:S(stored.resolved_mode),reading_date:S(params.reservation.readingDate),created_at:S(stored.created_at),updated_at:S(params.now.toISOString()),source:S("server_reading_api_v1"),public_result:S(json)};
    try { await this.sender.send(new TransactWriteItemsCommand({TransactItems:[{Put:{TableName:this.config.historyTable,Item:history,ConditionExpression:"attribute_not_exists(user_id) AND attribute_not_exists(history_id)"}},{Update:{TableName:this.config.idempotencyTable,Key:{request_ref:S(params.reservation.requestRef)},UpdateExpression:"SET #state=:completed, completed_at=:now, updated_at=:now REMOVE owner_token",ConditionExpression:"#state=:progress AND fingerprint=:fingerprint AND owner_token=:owner AND history_id=:history",ExpressionAttributeNames:{"#state":"state"},ExpressionAttributeValues:{":completed":S("COMPLETED"),":progress":S("IN_PROGRESS"),":now":S(params.now.toISOString()),":fingerprint":S(params.reservation.fingerprint),":owner":S(params.reservation.ownerToken),":history":S(params.reservation.historyId)}}}]})); return stored; }
    catch(error){ throw new ServerFoundationError("PERSISTENCE_UNAVAILABLE",{cause:error}); }
  }
  async fail(params:{reservation:Reservation;now:Date;category:string}):Promise<void> {
    try { await this.sender.send(new UpdateItemCommand({TableName:this.config.idempotencyTable,Key:{request_ref:S(params.reservation.requestRef)},UpdateExpression:"SET #state=:failed, failure_category=:category, updated_at=:now REMOVE owner_token",ConditionExpression:"#state=:progress AND owner_token=:owner",ExpressionAttributeNames:{"#state":"state"},ExpressionAttributeValues:{":failed":S("FAILED"),":progress":S("IN_PROGRESS"),":category":S(params.category.slice(0,32)),":now":S(params.now.toISOString()),":owner":S(params.reservation.ownerToken)}})); }
    catch { /* lease expiry remains the recovery path */ }
  }
}
export function createDynamoReadingPersistence(config:ReadingPersistenceConfig):ReadingPersistence { return new DynamoReadingPersistence(new DynamoDBClient({maxAttempts:1}),config); }
