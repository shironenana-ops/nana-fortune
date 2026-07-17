import assert from "node:assert/strict";
import test from "node:test";
import { buildReadingFoundation } from "../scripts/build-reading-foundation.mjs";

await buildReadingFoundation();
const api=await import(`${new URL("../dist/reading-server-foundation/index.mjs",import.meta.url).href}?p=${Date.now()}`);
const SECRET="fixture-only-idempotency-secret-32-characters-minimum";
const KEY="550e8400-e29b-41d4-a716-446655440000";
const config={idempotencyTable:"fixture-idempotency",historyTable:"fixture-history",hashSecret:SECRET,leaseSeconds:120,ttlSeconds:604800};
const request={name:"架空 花子",birthDate:"1984-12-29",question:"架空相談",requestedMode:"light"};

test("request_refとfingerprintは専用HMACで決定的かつ入力差を区別する",()=>{
  const a=api.createReadingRequestRef({userId:"fixture-user-a",idempotencyKey:KEY,secret:SECRET});
  assert.equal(a,api.createReadingRequestRef({userId:"fixture-user-a",idempotencyKey:KEY,secret:SECRET}));
  assert.notEqual(a,api.createReadingRequestRef({userId:"fixture-user-b",idempotencyKey:KEY,secret:SECRET}));
  const f=api.createReadingRequestFingerprint({request,secret:SECRET});
  assert.equal(f,api.createReadingRequestFingerprint({request:{...request},secret:SECRET}));
  for(const change of [{name:"別名"},{birthDate:"1984-12-30"},{question:"別相談"},{requestedMode:"free"}]) assert.notEqual(f,api.createReadingRequestFingerprint({request:{...request,...change},secret:SECRET}));
  assert.equal(a.length,64); assert.equal(f.length,64); assert.doesNotMatch(a+f,/架空|550e8400|fixture-user/);
  assert.throws(()=>api.createReadingRequestRef({userId:"x",idempotencyKey:KEY,secret:"short"}),/PERSISTENCE_NOT_CONFIGURED/);
});

test("persistence設定は専用table/secretと厳格なlease/TTLだけを受理する",()=>{
  assert.deepEqual(api.readReadingPersistenceConfig({READING_IDEMPOTENCY_TABLE_NAME:"idem",READING_HISTORY_TABLE_NAME:"history",READING_IDEMPOTENCY_HASH_SECRET:SECRET}),{idempotencyTable:"idem",historyTable:"history",hashSecret:SECRET,leaseSeconds:120,ttlSeconds:604800});
  for(const value of [""," ","89","901","1.5","1e2","-1"]) assert.throws(()=>api.readReadingPersistenceConfig({READING_IDEMPOTENCY_TABLE_NAME:"i",READING_HISTORY_TABLE_NAME:"h",READING_IDEMPOTENCY_HASH_SECRET:SECRET,READING_IDEMPOTENCY_LEASE_SECONDS:value}));
  assert.throws(()=>api.readReadingPersistenceConfig({}));
});

test("新規予約はconditional PutでPIIと生keyを保存しない",async()=>{
  const commands=[]; const sender={send:async command=>{commands.push(command);return {};}};
  const repo=new api.DynamoReadingPersistence(sender,config,()=>commands.length===0?"fixture-owner":"fixture-history-id");
  const result=await repo.begin({requestRef:"a".repeat(64),fingerprint:"b".repeat(64),userId:"fixture-user",resolvedMode:"light",readingDate:"2026-07-18",now:new Date("2026-07-18T00:00:00Z")});
  assert.equal(result.kind,"acquired"); assert.equal(commands.length,1);
  assert.equal(commands[0].input.ConditionExpression,"attribute_not_exists(request_ref)");
  const serialized=JSON.stringify(commands[0].input);
  assert.doesNotMatch(serialized,/fixture-user|550e8400|架空|birth|question|name/);
  assert.match(serialized,/IN_PROGRESS|lease_expires_at|expires_at/);
});

test("COMPLETED再送はstrong readした保存済み履歴を返し生成しない",async()=>{
  const conditional=Object.assign(new Error("hidden aws"),{name:"ConditionalCheckFailedException"}); let step=0;
  const publicResult={resolved_mode:"light",status:"completed",rendering_status:"rendered",result:{title:"保存済み",sections:[],one_step:"一歩",avoid_hint:"注意"}};
  const sender={send:async()=>{step++; if(step===1)throw conditional; if(step===2)return{Item:{fingerprint:{S:"b".repeat(64)},state:{S:"COMPLETED"},history_id:{S:"history-1"}}}; return{Item:{user_id:{S:"fixture-user"},history_id:{S:"history-1"},schema_version:{S:"shirone-reading-history-v1"},status:{S:"completed"},resolved_mode:{S:"light"},created_at:{S:"2026-07-18T00:00:00Z"},public_result:{S:JSON.stringify(publicResult)}}};}};
  const repo=new api.DynamoReadingPersistence(sender,config,()=>"unused");
  const result=await repo.begin({requestRef:"a".repeat(64),fingerprint:"b".repeat(64),userId:"fixture-user",resolvedMode:"light",readingDate:"2026-07-18",now:new Date("2026-07-18T00:00:00Z")});
  assert.equal(result.kind,"replay"); assert.equal(result.history.history_id,"history-1"); assert.equal(result.history.result.title,"保存済み"); assert.equal(step,3);
});

test("完了はhistory Putとidempotency Updateを同一transactionで条件付き確定する",async()=>{
  let command; const sender={send:async value=>{command=value;return {};}};
  const repo=new api.DynamoReadingPersistence(sender,config,()=>"unused");
  const reservation={requestRef:"a".repeat(64),fingerprint:"b".repeat(64),ownerToken:"owner",historyId:"history",readingDate:"2026-07-18",resolvedMode:"free",createdAt:"2026-07-18T00:00:00Z"};
  await repo.complete({reservation,userId:"fixture-user",response:{request_id:"new-request",resolved_mode:"free",status:"completed",rendering_status:"canonical",result:{title:"結果",sections:[],one_step:"一歩",avoid_hint:"注意"}},now:new Date("2026-07-18T00:00:01Z")});
  assert.equal(command.input.TransactItems.length,2);
  assert.match(command.input.TransactItems[0].Put.ConditionExpression,/attribute_not_exists/);
  assert.match(command.input.TransactItems[1].Update.ConditionExpression,/owner_token|fingerprint|history_id/);
  const serialized=JSON.stringify(command.input);
  assert.doesNotMatch(serialized,/new-request|owner_token.*owner.*public_result/);
});
