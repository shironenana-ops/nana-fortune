export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

const TOKYO_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function getServerReadingDate(clock: Clock = systemClock): string {
  const now = clock.now();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError("Clock returned an invalid date");
  }
  const parts = Object.fromEntries(
    TOKYO_DATE_FORMATTER.formatToParts(now).map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}
