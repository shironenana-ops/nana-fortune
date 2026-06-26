import {
  lifePath,
  personalYear,
  personalMonth,
  personalDay,
  seededRandom,
} from "./utils";

import {
  LIFE_MEANING,
  PERSONAL_DAY,
  LUCKY_COLORS,
  LUCKY_ITEMS,
  LIFE_PROFILE_LONG,
  WEEK_THEME_BY_PD,
  DETAIL_BY_PD,
  type Focus,
} from "./rules";

// 1〜9 の数値を型で表す（個人日/個人月/個人年の添字用）
type Digit1to9 = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

export interface Input {
  birthISO: string;
  name?: string;
  focus?: Focus;
  now?: Date;
  detail?: boolean; // true なら詳細セクションも返す
}

export interface Output {
  lifeNumber: number;
  lifeMeaning: string;
  personalYear: number;
  personalMonth: number;
  personalDay: number;
  todayAdvice: string;
  luckyColor: string;
  luckyItem: string;
  focusTips?: string;
  seedNote: string;

  // detail=true のとき追加
  profileLong?: string;
  weekTheme?: string;
  sections?: { title: string; body: string }[];
}

function isFocus(value: unknown): value is Focus {
  return typeof value === "string" && value in DETAIL_BY_PD;
}

export function evaluate(
  { birthISO, name = "", focus, now = new Date(), detail = true }: Input
): Output {
  const life = lifePath(birthISO);

  // 1..9 として扱う（personalX は reduce 済の想定だが、型を明示）
  const py = personalYear(birthISO, now) as Digit1to9;
  const pm = personalMonth(birthISO, now) as Digit1to9;
  const pd = personalDay(birthISO, now) as Digit1to9;

  // 日付＋名前にひも付く軽い乱数（毎日変わる）
  const rand = seededRandom(`${name}|${birthISO}|${now.toDateString()}`);
  const color = LUCKY_COLORS[Math.floor(rand() * LUCKY_COLORS.length)];
  const item  = LUCKY_ITEMS[Math.floor(rand() * LUCKY_ITEMS.length)];
  const focusTips = isFocus(focus) ? DETAIL_BY_PD[focus][pd] : undefined;

  const out: Output = {
    lifeNumber: life,
    lifeMeaning: LIFE_MEANING[life],
    personalYear: py,
    personalMonth: pm,
    personalDay: pd,
    todayAdvice: PERSONAL_DAY[pd],
    luckyColor: color,
    luckyItem: item,
    focusTips,
    seedNote: "※名前と日付に基づく軽い変動。日付が変わると内容も少しだけ変わります。",
  };

  if (detail) {
    out.profileLong = LIFE_PROFILE_LONG[life];
    out.weekTheme   = WEEK_THEME_BY_PD[pd];
    out.sections = [
      { title: "仕事",  body: DETAIL_BY_PD.work[pd]   },
      { title: "恋愛",  body: DETAIL_BY_PD.love[pd]   },
      { title: "健康",  body: DETAIL_BY_PD.health[pd] },
    ];
  }

  return out;
}
