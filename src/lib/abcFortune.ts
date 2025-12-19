import { jstDateKey, hashSeed, mulberry32, pick } from "./seed";
import { THEMES, LINES, ACTIONS } from "../data/fortune";

export type AbcPick = "A" | "B" | "C";
export type AbcFortune = { dateKey: string; pick: AbcPick; theme: string; line: string; action: string; reason: string };

function safePick<T>(arr: T[] | undefined, rnd: () => number, fallback: T): T {
  if (!arr || arr.length === 0) {
    return fallback;
  }
  return pick(arr, rnd);
}

const REASONS: Record<AbcPick, string[]> = {
  A: ["今は「整える」を選びやすい流れ。まずは小さく整えると楽になるよ。", "静かに立て直す日。焦らず“順番”を戻していこう。"],
  B: ["「休む」を選びやすい日。頑張りすぎないのが正解だよ。", "力を溜める流れ。今日は“減らす”が吉。"],
  C: ["「進む」を選びやすい日。小さく一歩で十分。", "流れが前へ。完璧より“着手”が勝つよ。"],
};

export function buildAbcFortune(pickABC: AbcPick, date = new Date()): AbcFortune {
  const dateKey = jstDateKey(date);
  const seed = hashSeed(`${dateKey}:ABC:${pickABC}`);
  const rnd = mulberry32(seed);

return {
  dateKey,
  pick: pickABC,
  theme: safePick(THEMES, rnd, "整える"),
  line: safePick(LINES, rnd, "今日は無理をしなくて大丈夫。"),
  action: safePick(ACTIONS, rnd, "深呼吸を3回してみよう。"),
  reason: safePick(
    REASONS[pickABC],
    rnd,
    "今は流れを信じて、静かに進めば大丈夫。"
  ),
};


}
