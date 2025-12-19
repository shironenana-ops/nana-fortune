import { THEMES, LINES, ACTIONS } from "../data/fortune.ts";

function jstDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  const d = parts.find((p) => p.type === "day")!.value;
  return `${y}-${m}-${d}`;
}

function hashToInt(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

export function buildTodayFortune(now = new Date()) {
  const themes = Array.isArray(THEMES) ? THEMES : [];
  const lines = Array.isArray(LINES) ? LINES : [];
  const actions = Array.isArray(ACTIONS) ? ACTIONS : [];

  if (!themes.length || !lines.length || !actions.length) {
    return {
      key: "fallback",
      theme: "整える",
      line: "今日は、無理をしなくて大丈夫。",
      action: "深呼吸をゆっくり3回。",
    };
  }

  const key = jstDateKey(now);
  const h = hashToInt(key);

  return {
    key,
    theme: themes[h % themes.length],
    line: lines[(h >>> 8) % lines.length],
    action: actions[(h >>> 16) % actions.length],
  };
}
