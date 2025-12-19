import { lifePath, reduceNumber } from "./utils";

export interface PairInput {
  a: { birthISO: string; name?: string };
  b: { birthISO: string; name?: string };
}
export interface PairOutput {
  aLife: number;
  bLife: number;
  pairNum: number; // 合算縮約（関係テーマ）
  score: number;   // 0-100
  summary: string;
  tips: string[];
}

const PAIR_THEMES: Record<number, string> = {
  1:"勢い/主導/スタート。どちらかが旗振り役に。",
  2:"協調/受容/つながり。聞く力で前進。",
  3:"交流/発信/楽しさ。笑顔が潤滑油。",
  4:"安定/ルール/成長。仕組みが関係を守る。",
  5:"自由/変化/旅。縛りすぎず風通しを。",
  6:"ケア/家族/チーム。温かさで結束。",
  7:"洞察/学び/静けさ。言語化が鍵。",
  8:"成果/責任/器。目的を共有すると強い。",
  9:"手放し/俯瞰/成熟。執着を緩めて循環へ。",
};

export function compat({ a, b }: PairInput): PairOutput {
  const aLife = lifePath(a.birthISO);
  const bLife = lifePath(b.birthISO);
  const pairNum = reduceNumber(aLife + bLife);

  const diff = Math.abs(aLife - bLife);
  let score = Math.max(40, 100 - diff * 8);
  const bonus = new Set(["1-5","5-1","3-5","5-3","2-6","6-2","4-8","8-4"]);
  if (bonus.has(`${aLife}-${bLife}`)) score += 6;
  score = Math.min(100, Math.max(0, Math.round(score)));

  const summary = `関係テーマは「${pairNum}」— ${PAIR_THEMES[pairNum]}（スコア${score}）`;
  const tips = [
    "役割分担を言語化してから動く",
    "週1回、5分の率直なふりかえり",
    "“相手がやりやすくなる一言”を先に足す"
  ];
  return { aLife, bLife, pairNum, score, summary, tips };
}
