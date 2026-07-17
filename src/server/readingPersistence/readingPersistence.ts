import type { PublicReadingResponse } from "../readingApi/readingApiTypes";

export type StoredReading = Omit<PublicReadingResponse, "request_id"> & { history_id: string; created_at: string };
export type Reservation = { requestRef: string; fingerprint: string; ownerToken: string; historyId: string; readingDate: string; resolvedMode: "free"|"light"|"deep"; createdAt: string };
export type BeginResult =
  | { kind: "acquired"; reservation: Reservation; takeover: boolean }
  | { kind: "replay"; history: StoredReading }
  | { kind: "in_progress" }
  | { kind: "conflict" };
export interface ReadingPersistence {
  begin(params: { requestRef: string; fingerprint: string; userId: string; resolvedMode: Reservation["resolvedMode"]; readingDate: string; now: Date }): Promise<BeginResult>;
  complete(params: { reservation: Reservation; userId: string; response: PublicReadingResponse; now: Date }): Promise<StoredReading>;
  fail(params: { reservation: Reservation; now: Date; category: string }): Promise<void>;
}
