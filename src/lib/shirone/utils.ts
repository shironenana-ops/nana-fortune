// 各種ユーティリティ（桁和・縮約・シード乱数など）
export const MASTER = new Set([11, 22, 33]);

export function sumDigits(n: number | string): number {
  return String(n).replace(/\D/g, "").split("").reduce((a, b) => a + Number(b), 0);
}

export function reduceNumber(n: number): number {
  while (n > 9 && !MASTER.has(n)) {
    n = sumDigits(n);
  }
  return n;
}

export function lifePath(dateISO: string): number {
  // "YYYY-MM-DD"
  const compact = dateISO.replace(/-/g, "");
  return reduceNumber(sumDigits(compact));
}

export function personalYear(dateISO: string, now = new Date()): number {
  const [, m, d] = dateISO.split("-").map(Number);
  const y = now.getFullYear();
  return reduceNumber(sumDigits(`${y}${m}${d}`));
}

export function personalMonth(dateISO: string, now = new Date()): number {
  const py = personalYear(dateISO, now);
  const pm = now.getMonth() + 1;
  return reduceNumber(py + pm);
}

export function personalDay(dateISO: string, now = new Date()): number {
  return reduceNumber(personalMonth(dateISO, now) + now.getDate());
}

// 文字列シードの簡易PRNG（同じ日×同じ名前で一定）
export function seededRandom(seedStr: string): () => number {
  let seed = 0;
  for (let i = 0; i < seedStr.length; i++) seed = (seed * 31 + seedStr.charCodeAt(i)) >>> 0;
  return () => {
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >>> 17; seed >>>= 0;
    seed ^= seed << 5;  seed >>>= 0;
    return (seed >>> 0) / 2 ** 32;
  };
}
