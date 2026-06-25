export type ShironeEngineInput = {
  birthDate: string;
  name?: string;
  question?: string;
  today?: string;
};

export type ShironeNumerologyResult = {
  lifePathNumber: number;
  birthdayNumber: number;
  personalYearNumber: number;
  personalMonthNumber: number;
  personalDayNumber: number;
};

export type ShironeAstrologyHint = {
  zodiacSign: string;
  element: "fire" | "earth" | "air" | "water" | "unknown";
  mode: "cardinal" | "fixed" | "mutable" | "unknown";
};

export type ShironeBiorhythmHint = {
  physical: "high" | "middle" | "low";
  emotional: "high" | "middle" | "low";
  intellectual: "high" | "middle" | "low";
};

export type ShironeEngineContext = {
  numerology: ShironeNumerologyResult;
  astrology: ShironeAstrologyHint;
  biorhythm: ShironeBiorhythmHint;
};

export type ShironeEngineResult = {
  title: string;
  todayMessage: string;
  marginMessage: string;
  oneStep: string;
  avoidHint: string;
  audioScript: string;
  context: ShironeEngineContext;
};

type DateParts = {
  year: number;
  month: number;
  day: number;
};

type WaveLevel = ShironeBiorhythmHint["physical"];

const MASTER_NUMBERS = new Set([11, 22, 33]);

const NUMBER_THEMES: Record<number, string> = {
  1: "小さな始まり",
  2: "やさしい調整",
  3: "言葉にすること",
  4: "足元を整えること",
  5: "風を入れること",
  6: "大切なものを守ること",
  7: "静かに見つめること",
  8: "現実へ移すこと",
  9: "手放して余白を作ること",
  11: "直感の灯り",
  22: "大きな流れを形にすること",
  33: "やさしさを広く渡すこと"
};

const DAY_MESSAGES: Record<number, string> = {
  1: "今日は、小さく始める力が戻りやすい日です。\n大きく変えようとしなくても、最初の一手を選ぶだけで流れが動きそうです。",
  2: "今日は、人との間合いを静かに整えたい日です。\n急いで答えを出すより、少し受け止めてから返す方が心に余白が残りそうです。",
  3: "今日は、言葉にすることで気持ちが軽くなりやすい日です。\nうまくまとめなくても、今ある思いを短く外へ出すだけで十分です。",
  4: "今日は、足元を整えるほど安心が戻りやすい日です。\n派手な変化より、ひとつ片づけることが次の流れを呼びそうです。",
  5: "今日は、少し風を入れると流れが変わりやすい日です。\n予定を固めすぎず、選び直せる余白を残しておくとよさそうです。",
  6: "今日は、大切な人や居場所へ意識が向きやすい日です。\n誰かにやさしくする分、自分にも同じだけやさしくしてあげてください。",
  7: "今日は、静かな時間が答えを近づけてくれそうです。\n外へ急いで広げるより、自分の内側の声を少し聞いてみてください。",
  8: "今日は、現実をひとつ動かす力が出やすい日です。\n全部を背負わず、形にしたいことをひとつだけ選ぶと進みやすくなります。",
  9: "今日は、抱えすぎたものを少し下ろしたい日です。\n終わったことを責めずに、次の余白を作る方へ意識を向けてみてください。"
};

const STEP_MESSAGES: Record<number, string> = {
  1: "今日やることをひとつだけ決める",
  2: "返事を急がず、一度深呼吸してから読む",
  3: "思っていることを短い言葉でメモする",
  4: "机やバッグの中を一か所だけ整える",
  5: "いつもと違う道や順番をひとつ選ぶ",
  6: "自分にもやさしい言葉をひとつかける",
  7: "静かな時間を十分だけ作る",
  8: "先に進めたいことを一つだけ形にする",
  9: "もう持たなくていいものを一つ手放す"
};

const AVOID_MESSAGES: Record<number, string> = {
  1: "勢いだけで決め切ろうとすること",
  2: "相手に合わせすぎて、自分の感覚を置いていくこと",
  3: "言葉を増やしすぎて、本音を見失うこと",
  4: "完璧に整うまで動けないと思うこと",
  5: "刺激を求めすぎて、疲れを見落とすこと",
  6: "やさしさを義務にして、背負いすぎること",
  7: "考えすぎて、一人で抱え込むこと",
  8: "結果だけで今日の自分を測ること",
  9: "過ぎたことを何度も責め直すこと"
};

const ZODIAC_TABLE: Array<{
  sign: string;
  start: [number, number];
  end: [number, number];
  element: ShironeAstrologyHint["element"];
  mode: ShironeAstrologyHint["mode"];
}> = [
  { sign: "牡羊座", start: [3, 21], end: [4, 19], element: "fire", mode: "cardinal" },
  { sign: "牡牛座", start: [4, 20], end: [5, 20], element: "earth", mode: "fixed" },
  { sign: "双子座", start: [5, 21], end: [6, 21], element: "air", mode: "mutable" },
  { sign: "蟹座", start: [6, 22], end: [7, 22], element: "water", mode: "cardinal" },
  { sign: "獅子座", start: [7, 23], end: [8, 22], element: "fire", mode: "fixed" },
  { sign: "乙女座", start: [8, 23], end: [9, 22], element: "earth", mode: "mutable" },
  { sign: "天秤座", start: [9, 23], end: [10, 23], element: "air", mode: "cardinal" },
  { sign: "蠍座", start: [10, 24], end: [11, 22], element: "water", mode: "fixed" },
  { sign: "射手座", start: [11, 23], end: [12, 21], element: "fire", mode: "mutable" },
  { sign: "山羊座", start: [12, 22], end: [1, 19], element: "earth", mode: "cardinal" },
  { sign: "水瓶座", start: [1, 20], end: [2, 18], element: "air", mode: "fixed" },
  { sign: "魚座", start: [2, 19], end: [3, 20], element: "water", mode: "mutable" }
];

const ELEMENT_HINTS: Record<ShironeAstrologyHint["element"], string> = {
  fire: "心の火を少しだけ外へ向けると整いやすい空気です",
  earth: "足元の感覚を確かめるほど安心が戻りやすい空気です",
  air: "考えや言葉に風を通すほど軽くなりやすい空気です",
  water: "感情を急がせず、静かに受け止めると整いやすい空気です",
  unknown: "今日は自分の感覚をゆっくり確かめるとよさそうです"
};

function assertValidDate(value: string, fieldName: string): DateParts {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);

  if (!match) {
    throw new Error(`${fieldName}はYYYY-MM-DD形式で入力してください。`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`${fieldName}の日付を確認してください。`);
  }

  return { year, month, day };
}

function formatToday(): string {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function sumDigits(value: number | string): number {
  return String(value)
    .replace(/\D/g, "")
    .split("")
    .reduce((sum, digit) => sum + Number(digit), 0);
}

function reduceNumber(value: number, keepMaster = true): number {
  let current = Math.abs(Math.floor(value));

  while (current > 9) {
    if (keepMaster && MASTER_NUMBERS.has(current)) return current;
    current = sumDigits(current);
  }

  return current || 1;
}

function cycleNumber(value: number): number {
  const reduced = reduceNumber(value, false);
  return reduced >= 1 && reduced <= 9 ? reduced : 1;
}

function calculateNumerology(birthDate: string, today: string): ShironeNumerologyResult {
  const birth = assertValidDate(birthDate, "birthDate");
  const current = assertValidDate(today, "today");
  const universalYear = sumDigits(current.year);
  const lifePathNumber = reduceNumber(sumDigits(birthDate), true);
  const birthdayNumber = reduceNumber(birth.day, true);
  const personalYearNumber = reduceNumber(birth.month + birth.day + universalYear, true);
  const personalMonthNumber = reduceNumber(personalYearNumber + current.month, true);
  const personalDayNumber = reduceNumber(personalMonthNumber + current.day, true);

  return {
    lifePathNumber,
    birthdayNumber,
    personalYearNumber,
    personalMonthNumber,
    personalDayNumber
  };
}

function isDateInRange(month: number, day: number, start: [number, number], end: [number, number]): boolean {
  const value = month * 100 + day;
  const startValue = start[0] * 100 + start[1];
  const endValue = end[0] * 100 + end[1];

  if (startValue <= endValue) {
    return value >= startValue && value <= endValue;
  }

  return value >= startValue || value <= endValue;
}

function calculateAstrology(birthDate: string): ShironeAstrologyHint {
  const birth = assertValidDate(birthDate, "birthDate");
  const zodiac = ZODIAC_TABLE.find((item) => isDateInRange(birth.month, birth.day, item.start, item.end));

  if (!zodiac) {
    return {
      zodiacSign: "不明",
      element: "unknown",
      mode: "unknown"
    };
  }

  return {
    zodiacSign: zodiac.sign,
    element: zodiac.element,
    mode: zodiac.mode
  };
}

function dateToUtcDay(parts: DateParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day) / 86_400_000;
}

function waveToLevel(value: number): WaveLevel {
  if (value > 0.35) return "high";
  if (value < -0.35) return "low";
  return "middle";
}

function calculateBiorhythm(birthDate: string, today: string): ShironeBiorhythmHint {
  const birth = assertValidDate(birthDate, "birthDate");
  const current = assertValidDate(today, "today");
  const elapsedDays = Math.max(0, Math.floor(dateToUtcDay(current) - dateToUtcDay(birth)));
  const wave = (period: number) => Math.sin((2 * Math.PI * elapsedDays) / period);

  return {
    physical: waveToLevel(wave(23)),
    emotional: waveToLevel(wave(28)),
    intellectual: waveToLevel(wave(33))
  };
}

function biorhythmMarginMessage(biorhythm: ShironeBiorhythmHint): string {
  const lowCount = [biorhythm.physical, biorhythm.emotional, biorhythm.intellectual].filter((level) => level === "low").length;
  const highCount = [biorhythm.physical, biorhythm.emotional, biorhythm.intellectual].filter((level) => level === "high").length;

  if (lowCount >= 2) {
    return "今の余白は、少し多めに取ってよさそうです。\n進める日というより、整えながら戻る日として扱ってみてください。";
  }

  if (highCount >= 2) {
    return "今の余白は、動いたあとに少し休む形が合いそうです。\n流れがある日ほど、途中で息を入れるとやさしく進めます。";
  }

  return "今の余白は、広すぎなくても大丈夫です。\n短い休憩や、ひと呼吸を置く時間が今日のあなたを支えてくれます。";
}

function buildResult(input: ShironeEngineInput, context: ShironeEngineContext): ShironeEngineResult {
  const name = input.name?.trim();
  const numerologyDay = cycleNumber(context.numerology.personalDayNumber);
  const lifeTheme = NUMBER_THEMES[context.numerology.lifePathNumber] ?? NUMBER_THEMES[cycleNumber(context.numerology.lifePathNumber)];
  const dayTheme = NUMBER_THEMES[numerologyDay];
  const address = name ? `${name}さん` : "あなた";
  const questionLine = input.question?.trim()
    ? `相談ごとは、急いで結論にしなくても大丈夫です。\nまずは今日できる形まで小さくしてみてください。`
    : ELEMENT_HINTS[context.astrology.element];
  const title = `今日の灯りは「${dayTheme}」`;
  const todayMessage = `${address}の今日には、${dayTheme}の流れが静かに重なっています。\n${DAY_MESSAGES[numerologyDay]}\n生まれ持つ${lifeTheme}を、無理に大きく使わなくても大丈夫です。\n${questionLine}`;
  const marginMessage = biorhythmMarginMessage(context.biorhythm);
  const oneStep = STEP_MESSAGES[numerologyDay];
  const avoidHint = AVOID_MESSAGES[numerologyDay];
  const audioScript = [
    title,
    "",
    todayMessage,
    "",
    "今の余白。",
    marginMessage,
    "",
    "無理しない一歩。",
    `${oneStep}。`,
    "",
    `今日は、${avoidHint}を少しだけ避けてみてください。`,
    "あなたのペースで大丈夫です。"
  ].join("\n");

  return {
    title,
    todayMessage,
    marginMessage,
    oneStep,
    avoidHint,
    audioScript,
    context
  };
}

export function runShironeEngine(input: ShironeEngineInput): ShironeEngineResult {
  const today = input.today ?? formatToday();
  const context: ShironeEngineContext = {
    numerology: calculateNumerology(input.birthDate, today),
    astrology: calculateAstrology(input.birthDate),
    biorhythm: calculateBiorhythm(input.birthDate, today)
  };

  return buildResult(input, context);
}
