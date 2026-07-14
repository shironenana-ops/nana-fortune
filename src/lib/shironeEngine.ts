export type ShironePlan = "free" | "light" | "deep";

export type ShironeEngineInput = {
  birthDate: string;
  name?: string;
  question?: string;
  today?: string;
  plan?: ShironePlan;
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

export type ShironeLengthRange = {
  min: number;
  max: number;
  label: string;
};

export type ShironeReadingSection = {
  id: string;
  title: string;
  summary: string;
  body: string;
};

export type ShironeKnowledgePayload = {
  plan: ShironePlan;
  inputSummary: {
    hasName: boolean;
    hasQuestion: boolean;
    questionTheme: string;
  };
  context: ShironeEngineContext;
  resultSummary: {
    title: string;
    todayMessage: string;
    oneStep: string;
    avoidHint: string;
  };
  tags: string[];
};

export type ShironeIconHint = {
  key: string;
  label: string;
  value: string;
  icon: string;
  tone: "gold" | "purple" | "blue" | "green" | "gray";
};

export type ShironeHistoryPayloadV2 = {
  version: "shirone-history-v2";
  plan: ShironePlan;
  createdAt: string;
  input: {
    birthDate: string;
    name?: string;
    question?: string;
    today: string;
  };
  context: ShironeEngineContext;
  result: {
    title: string;
    todayMessage: string;
    marginMessage: string;
    oneStep: string;
    avoidHint: string;
    audioScript: string;
    sections: ShironeReadingSection[];
    iconHints: ShironeIconHint[];
  };
  knowledgePayload: ShironeKnowledgePayload;
  summary: {
    displayTitle: string;
    shortSummary: string;
    primaryTag: string;
    planLabel: string;
  };
};

export type ShironeEngineResult = {
  plan: ShironePlan;
  lengthRange: ShironeLengthRange;
  title: string;
  todayMessage: string;
  marginMessage: string;
  oneStep: string;
  avoidHint: string;
  audioScript: string;
  sections: ShironeReadingSection[];
  knowledgePayload: ShironeKnowledgePayload;
  historyPayloadV2: ShironeHistoryPayloadV2;
  iconHints: ShironeIconHint[];
  context: ShironeEngineContext;
};

type DateParts = {
  year: number;
  month: number;
  day: number;
};

type WaveLevel = ShironeBiorhythmHint["physical"];

type PlanTextParams = {
  plan: ShironePlan;
  address: string;
  questionText: string;
  questionTheme: string;
  numerologyDay: number;
  dayTheme: string;
  lifeTheme: string;
  title: string;
  oneStep: string;
  avoidHint: string;
  context: ShironeEngineContext;
};

const MASTER_NUMBERS = new Set([11, 22, 33]);

const LENGTH_RANGES: Record<ShironePlan, ShironeLengthRange> = {
  free: {
    min: 300,
    max: 800,
    label: "1分ほどで読める短い鑑定"
  },
  light: {
    min: 2000,
    max: 4000,
    label: "少し深く受け取る軽めの有料鑑定"
  },
  deep: {
    min: 8000,
    max: 12000,
    label: "多面的に読み解く深掘り鑑定"
  }
};

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

function normalizePlan(plan: ShironeEngineInput["plan"]): ShironePlan {
  if (plan === "light" || plan === "deep") return plan;
  return "free";
}

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

function waveLevelLabel(level: WaveLevel): string {
  const labels: Record<WaveLevel, string> = {
    low: "静かな波",
    middle: "穏やかな波",
    high: "満ちる波"
  };

  return labels[level] ?? "穏やかな波";
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

function detectQuestionTheme(question?: string): string {
  const text = question?.trim() ?? "";

  if (!text) return "none";
  if (/恋|愛|結婚|夫婦|相性|パートナー/.test(text)) return "relationship";
  if (/仕事|転職|職場|副業|働|キャリア/.test(text)) return "work";
  if (/お金|収入|支出|投資|家計/.test(text)) return "money";
  if (/体|健康|疲|眠|休/.test(text)) return "care";
  return "daily-flow";
}

function questionThemeLabel(theme: string): string {
  const labels: Record<string, string> = {
    relationship: "人間関係",
    work: "仕事・働き方",
    money: "お金・暮らし",
    care: "からだと休息",
    "daily-flow": "日々の流れ",
    none: "日々の流れ"
  };

  return labels[theme] ?? "日々の流れ";
}

function buildFreeTodayMessage(params: PlanTextParams): string {
  const questionLine = params.questionText
    ? "相談ごとは、今日は深く掘りすぎなくて大丈夫です。\n答えより先に、今日できる一歩へ小さく寄せてみてください。"
    : "今日は、今の流れを短く受け取るだけで大丈夫です。";

  return [
    `${params.address}の今日は「${params.dayTheme}」の流れです。`,
    DAY_MESSAGES[params.numerologyDay],
    questionLine,
    `まずは「${params.oneStep}」。`,
    "今日はこれだけでも、静かに整っていきそうです。"
  ].join("\n");
}

function buildLightTodayMessage(params: PlanTextParams): string {
  const questionLine = params.questionText
    ? `相談テーマは「${questionThemeLabel(params.questionTheme)}」として受け取ります。\n今すぐ大きな結論にするより、今日の流れに重ねて、扱える大きさまで整えるとよさそうです。`
    : "具体的な相談がなくても、今日は本質と今のテーマを重ねて見ることで、次の選び方が少し見えやすくなります。";

  return [
    `${params.address}の今日は、数秘の個人日${params.context.numerology.personalDayNumber}が示す「${params.dayTheme}」の流れにいます。`,
    `ライフパスには${params.lifeTheme}の気配があり、今日はその力を強く出すより、日常の中で扱いやすい形にすることが鍵になりそうです。`,
    `${params.context.astrology.zodiacSign}の星の空気は、${ELEMENT_HINTS[params.context.astrology.element]}`,
    questionLine,
    `行動は「${params.oneStep}」くらいの小ささで十分です。`
  ].join("\n");
}

function buildDeepTodayMessage(params: PlanTextParams): string {
  const questionLine = params.questionText
    ? `相談内容は「${params.questionText}」。\nこの問いは、すぐに一つの答えへ押し込むより、「今の自分が何を守りたいのか」「何を急ぎすぎているのか」「今日できる最小の行動は何か」に分けて見ると、少し呼吸がしやすくなりそうです。`
    : "具体的な相談内容がない場合は、人生全体の流れを大きく決めつけるのではなく、今の整え方と、これから選びやすくなる方向を静かに見ていきます。";

  return [
    `${params.address}の今日の中心には、個人日${params.context.numerology.personalDayNumber}の「${params.dayTheme}」が流れています。`,
    `数秘では、ライフパス${params.context.numerology.lifePathNumber}の${params.lifeTheme}が背骨になります。これは性格を決めつけるためではなく、迷った時に戻れる軸として扱います。`,
    `${params.context.astrology.zodiacSign}の空気は、今日の読みの光になります。${ELEMENT_HINTS[params.context.astrology.element]}`,
    `心と体と思考の波では、体は${waveLevelLabel(params.context.biorhythm.physical)}、心は${waveLevelLabel(params.context.biorhythm.emotional)}、思考は${waveLevelLabel(params.context.biorhythm.intellectual)}です。これは断定ではなく、力の配分を見るための目安です。`,
    questionLine,
    `今日の行動は「${params.oneStep}」。避けたいのは「${params.avoidHint}」です。\n大きく変えるより、今日できる範囲で、余白を残した選び方にしていきましょう。`
  ].join("\n\n");
}

function buildPlanTodayMessage(params: PlanTextParams): string {
  if (params.plan === "light") return buildLightTodayMessage(params);
  if (params.plan === "deep") return buildDeepTodayMessage(params);
  return buildFreeTodayMessage(params);
}

function buildPlanMarginMessage(params: PlanTextParams): string {
  const base = biorhythmMarginMessage(params.context.biorhythm);

  if (params.plan === "free") {
    return [
      base,
      "今日は、余白を少し残せたら十分です。"
    ].join("\n");
  }

  if (params.plan === "light") {
    return [
      base,
      `体の波は${waveLevelLabel(params.context.biorhythm.physical)}、心の波は${waveLevelLabel(params.context.biorhythm.emotional)}、思考の波は${waveLevelLabel(params.context.biorhythm.intellectual)}です。`,
      "全部を同じ強さで動かそうとせず、いちばん疲れやすいところに少し余白を渡してみてください。"
    ].join("\n");
  }

  return [
    base,
    `今日の波を分けて見ると、体は${waveLevelLabel(params.context.biorhythm.physical)}、心は${waveLevelLabel(params.context.biorhythm.emotional)}、思考は${waveLevelLabel(params.context.biorhythm.intellectual)}です。`,
    "体が重い日は予定の密度を下げる。心が揺れる日は人の反応を急いで読まない。思考が沈む日は、結論よりメモを残す。",
    "このように分解して見ると、今日の不調や迷いを自分のせいにしすぎず、扱える形へ戻しやすくなります。"
  ].join("\n\n");
}

function buildPlanAudioScript(params: PlanTextParams, todayMessage: string, marginMessage: string): string {
  if (params.plan === "free") {
    return [
      params.title,
      "",
      `${params.address}の今日は、${params.dayTheme}の流れです。`,
      "無理に答えを出さなくて大丈夫です。",
      "",
      "今の余白。",
      marginMessage,
      "",
      "無理しない一歩。",
      `${params.oneStep}。`,
      "",
      "今日はこれだけでも大丈夫です。"
    ].join("\n");
  }

  if (params.plan === "light") {
    return [
      params.title,
      "",
      `数秘では、今日の流れは${params.dayTheme}。`,
      `あなたの背骨には、${params.lifeTheme}の気配があります。`,
      `${params.context.astrology.zodiacSign}の星の空気も、今日の選び方を少し照らしています。`,
      "",
      params.questionText
        ? "相談ごとは、今日できる形まで小さくすると扱いやすくなりそうです。"
        : "今日は本質と今のテーマを重ねて、次の一歩を見ていきます。",
      "",
      "今の余白。",
      marginMessage,
      "",
      `今日の一歩は、${params.oneStep}。`,
      `避けたいのは、${params.avoidHint}。`,
      "急がず、今日の分だけ受け取ってください。"
    ].join("\n");
  }

  return [
    params.title,
    "",
    "ここでは、数秘術の背骨、星の空気、今日の波を重ねて見ていきます。",
    "",
    todayMessage,
    "",
    "今の余白。",
    marginMessage,
    "",
    params.questionText
      ? "相談内容は、一つの答えへ急がず、問いを小さく分けて受け取っていきます。"
      : "具体的な相談がなくても、今の流れとこれからの整え方を静かに見ていけます。",
    "",
    `これからの行動は、${params.oneStep}。`,
    `手放す候補は、${params.avoidHint}。`,
    "今日のあなたに残せる余白を、まずひとつ守ってください。"
  ].join("\n");
}

type SectionBuildParams = {
  plan: ShironePlan;
  today: string;
  identitySeed: string;
  title: string;
  todayMessage: string;
  marginMessage: string;
  oneStep: string;
  avoidHint: string;
  context: ShironeEngineContext;
  question?: string;
};

function deterministicIndex(seed: string, salt: string, size: number): number {
  let hash = 2166136261;
  const value = `${salt}|${seed}`;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0) % size;
}

function buildFreeSections(params: SectionBuildParams): ShironeReadingSection[] {
  const { today, identitySeed, title, todayMessage, marginMessage, oneStep, avoidHint } = params;
  const dailySeed = `${identitySeed}|${today}`;
  const structureId = deterministicIndex(dailySeed, "free-structure", 3);
  const toneId = deterministicIndex(dailySeed, "free-tone", 3);
  const subthemeId = deterministicIndex(dailySeed, "free-subtheme", 3);
  const receivingClosings = [
    "すぐに答えへ変えなくても大丈夫です。\n心に残ったところだけ、今日の手元へ置いてください。",
    "全部を覚えておく必要はありません。\n今の自分に響く言葉を、ひとつだけ残してみてください。",
    "受け取り方を決めるのは、今日のあなたです。\n静かに残る感覚を大切にしてください。"
  ];
  const releasePerspectives = [
    "今日は、うまく進めることより力の入れ方を選ぶ日です。",
    "抱えたまま頑張る以外にも、選べる道は残っています。",
    "止まることと後退することは同じではありません。"
  ];
  const forwardPerspectives = [
    "可能性は、大きな決断より先に小さな選択として現れます。",
    "今日の流れは、意識を向けた場所から少しずつ形になります。",
    "まだ完成していなくても、選び直せることは前進の一部です。"
  ];

  if (structureId === 1) {
    return [
      {
        id: "margin",
        title: "今は急がなくてよいこと",
        summary: "動かす前に、力の入り方を見直します",
        body: `${marginMessage}\n${releasePerspectives[toneId]}`
      },
      {
        id: "today-line",
        title: "手放してよい力",
        summary: title,
        body: `今日は「${avoidHint}」を背負い続けなくてかまいません。\n${receivingClosings[subthemeId]}`
      },
      {
        id: "one-step",
        title: "静かに選べること",
        summary: oneStep,
        body: `今のあなたが選べるのは「${oneStep}」。\n無理に勢いをつけず、できる形にしてみてください。`
      }
    ];
  }

  if (structureId === 2) {
    return [
      {
        id: "today-line",
        title: "今日ひらく流れ",
        summary: title,
        body: todayMessage
      },
      {
        id: "one-step",
        title: "意識を向けたい場所",
        summary: forwardPerspectives[subthemeId],
        body: `${forwardPerspectives[subthemeId]}\n今すぐ結論にせず、次に動かせる場所を見つけてください。`
      },
      {
        id: "margin",
        title: "次に選ぶ一手",
        summary: oneStep,
        body: `今日の選択は「${oneStep}」。\n${receivingClosings[toneId]}`
      }
    ];
  }

  return [
    {
      id: "today-line",
      title: "今日の気配",
      summary: title,
      body: todayMessage
    },
    {
      id: "margin",
      title: "心に残しておくこと",
      summary: "今日の流れから、大切な視点を受け取ります",
      body: `${marginMessage}\n${receivingClosings[toneId]}`
    },
    {
      id: "one-step",
      title: "今日ひとつだけ",
      summary: oneStep,
      body: `今日ひとつ選ぶなら「${oneStep}」。\n${forwardPerspectives[subthemeId]}`
    }
  ];
}

function buildLightSections(params: SectionBuildParams): ShironeReadingSection[] {
  const { todayMessage, marginMessage, oneStep, avoidHint, context, question } = params;
  const lifePath = context.numerology.lifePathNumber;
  const dayNumber = cycleNumber(context.numerology.personalDayNumber);
  const lifeTheme = NUMBER_THEMES[lifePath] ?? NUMBER_THEMES[cycleNumber(lifePath)];
  const dayTheme = NUMBER_THEMES[dayNumber];
  const questionText = question?.trim();
  const questionTheme = detectQuestionTheme(question);
  const questionLabel = questionThemeLabel(questionTheme);
  const physicalTone =
    context.biorhythm.physical === "low"
      ? "体は少し余白を求めています。予定を詰めすぎず、移動や準備に小さな休みを挟むと、今日の流れを乱しにくくなります。"
      : context.biorhythm.physical === "high"
        ? "体の波は動きやすい側にあります。ただし勢いだけで押し切るより、始める前と終える前に短く整える時間を置くと、力がきれいに使えます。"
        : "体の波は大きく傾きすぎていません。いつもの動きを基準にしながら、疲れを感じたところで早めに手を緩めるくらいが合いそうです。";
  const emotionalTone =
    context.biorhythm.emotional === "low"
      ? "心は外からの言葉を重く受け取りやすいかもしれません。今日は反応を急がず、気持ちが落ち着いてから返すだけで十分です。"
      : context.biorhythm.emotional === "high"
        ? "心は動きやすく、人の表情や場の空気にもよく気づけそうです。そのぶん抱え込みすぎないよう、感じたことを一度言葉にして外へ置いてください。"
        : "心の波は比較的なだらかです。大きな感情に振り回されにくい日なので、静かな判断や関係の調整に向いています。";
  const intellectualTone =
    context.biorhythm.intellectual === "low"
      ? "思考は深く掘るより、短く整理する方が向いています。複雑な判断はメモに分け、今日決めることと後日に回すことを切り分けてください。"
      : context.biorhythm.intellectual === "high"
        ? "思考は筋道を見つけやすい波です。考えすぎて身動きが止まる前に、見えた順番を小さな手順へ落とし込むと進みやすくなります。"
        : "思考の波は中庸です。極端な結論へ寄せるより、今ある情報を並べて、足りないものだけを静かに確認する読み方が合います。";

  return [
    {
      id: "daily-flow",
      title: "今日の流れ",
      summary: `${dayTheme}の流れを読み物として整理します`,
      body: [
        todayMessage,
        `ライト鑑定では、この流れを少し日常側へ近づけて読みます。今日の個人日${context.numerology.personalDayNumber}は、あなたに大きな変化を強いるものではなく、今ある予定や人とのやり取りの中で「どこに力を入れ、どこを緩めるか」を教えてくれる小さな灯りです。`,
        `特に今日は、${dayTheme}というテーマを一日全体に広げるより、午前・午後・夜のように時間を分けて受け取ると扱いやすくなります。最初から完璧に整えようとすると、かえって自分の呼吸が浅くなるかもしれません。まずは一つの場面だけ、今日の流れに合う選び方を置いてみてください。`,
        "今日の流れは、急ぐほど見えにくくなります。やることを減らす必要がある日というより、やる順番を静かに見直す日です。先に片づけること、誰かに返すこと、少しだけ待つこと。その三つを分けるだけでも、日中の迷いは軽くなっていきます。"
      ].join("\n\n")
    },
    {
      id: "essence",
      title: "あなたの本質",
      summary: `ライフパス${lifePath}の気配`,
      body: [
        `ライフパス${lifePath}は、${lifeTheme}を人生の背骨として持ちます。これは才能を誇示するための名前ではなく、迷った時に自分の中心へ戻るための合図です。今日のあなたは、その本質を大きく見せるより、生活の小さな判断の中で静かに使う方が合っています。`,
        "本質は、いつも強く出せばよいものではありません。疲れている時には薄く、必要な時には少し濃く、場に合わせて出し入れできるようになるほど、あなたらしさは無理なく届きます。今日の鑑定では、ライフパスを性格の決めつけではなく、行動の温度を決める目安として読みます。",
        `もし今日、誰かの期待や周りの速度に引っぱられている感覚があるなら、いったん「${lifeTheme}を今の場面でやさしく使うなら何を選ぶか」と問い直してみてください。答えは大きな言葉でなくてかまいません。返事を少し待つ、予定を一つ減らす、必要な確認だけをする。そのくらいの小ささで十分です。`
      ].join("\n\n")
    },
    {
      id: "current-theme",
      title: "今のテーマ",
      summary: `${context.astrology.zodiacSign}の空気と今日の波`,
      body: [
        `${context.astrology.zodiacSign}の星の空気は、${ELEMENT_HINTS[context.astrology.element]}`,
        "ここに今日の波を重ねると、体・心・思考を同じ速度で進めるより、どこに余白を置くかを選ぶことがテーマになりそうです。すべてが整ってから動く必要はありません。ただ、どの部分が先に疲れやすいかを知っておくと、今日の選び方はかなりやさしくなります。",
        physicalTone,
        emotionalTone,
        intellectualTone,
        marginMessage
      ].join("\n\n")
    },
    {
      id: "question-hint",
      title: "あなたの問いへの手がかり",
      summary: questionText ? `${questionLabel}の相談を今日の流れに重ねます` : "相談がない時は今のテーマを中心に読みます",
      body: questionText
        ? [
            `相談内容「${questionText}」は、今日の流れでは急いで結論にするより、まず今できる行動へ近づけると扱いやすそうです。問いが大きいままだと、答えも大きく見えてしまいます。けれど今日扱うべきなのは、未来全体ではなく、今の自分が落ち着いて選べる一歩です。`,
            `テーマとしては「${questionLabel}」の気配があります。ここでは勝ち負けや正解を決めるより、関係や状況の中で自分の余白をどれくらい守れるかを見てください。相手や環境を一度に変えようとすると苦しくなりますが、自分の返し方、確認する順番、距離の置き方なら今日から少し整えられます。`,
            "問いを一段小さくして、「今日返せる言葉」「今日整えられる場所」「今日保てる距離」のように見ると、次の一手が見えやすくなります。答えを急がないことは停滞ではありません。今日のあなたが受け取れる大きさまで問いをほどくことで、明日以降に選べる道が増えていきます。"
          ].join("\n\n")
        : [
            "今は大きな相談がなくても、今日のテーマを受け取るだけで十分です。本質と波を重ねて見ることで、今の自分に合う速度が少し分かりやすくなります。",
            "相談がない日には、無理に悩みを探さなくて大丈夫です。むしろ、何も決めつけずに今日の流れを眺めることで、普段見落としている疲れや願いに気づけることがあります。白音七の読み解きは、問題を大きくするためではなく、今の自分へ静かに戻るための手がかりです。",
            "今日の中で少し気になる場面があれば、そこだけを小さく取り出して見てください。うまくいかなかったことより、なぜそこで力が入ったのか。選べなかったことより、本当は何を守りたかったのか。そのくらいの問い方が、今のあなたには合いそうです。"
          ].join("\n\n")
    },
    {
      id: "action-hint",
      title: "今日の小さな一歩",
      summary: oneStep,
      body: [
        `今日の一歩は「${oneStep}」。`,
        "ただ行動するだけでなく、始める前に一度だけ「これは今の自分にとって小さくできているか」を確認してみてください。今の流れでは、大きな宣言や一気に進める選択より、戻ってこられる範囲で試す行動が向いています。",
        "行動の目安は、終わったあとに少し呼吸が残ることです。達成感よりも、次に続けられる軽さを優先してください。もし途中で重く感じたら、そこで止めても大丈夫です。今日の行動は結果を証明するためではなく、自分の流れを確かめるための小さな灯りです。"
      ].join("\n\n")
    },
    {
      id: "avoid-hint",
      title: "気をつけたい流れ",
      summary: avoidHint,
      body: [
        `今日は「${avoidHint}」を少しだけ避けると、心の余白が残りやすくなります。`,
        "避けることは逃げではなく、自分の流れを乱しすぎないための小さな調整です。特に今日は、勢いで返す言葉や、その場の空気に合わせすぎる選択に注意してください。あとから自分だけが疲れてしまうなら、それは少し背負いすぎている合図かもしれません。",
        "気をつけたい流れに気づけたら、責める必要はありません。気づいた時点で、すでに流れは変わり始めています。今日は完璧に避けるより、途中で気づいて手を緩めることを大切にしてください。そこに、明日へ持ち越さないための静かな余白が生まれます。"
      ].join("\n\n")
    }
  ];
}

function buildDeepSections(params: SectionBuildParams): ShironeReadingSection[] {
  const { marginMessage, oneStep, avoidHint, context, question } = params;
  const lifePath = context.numerology.lifePathNumber;
  const dayNumber = cycleNumber(context.numerology.personalDayNumber);
  const lifeTheme = NUMBER_THEMES[lifePath] ?? NUMBER_THEMES[cycleNumber(lifePath)];
  const dayTheme = NUMBER_THEMES[dayNumber];
  const questionText = question?.trim();
  const questionTheme = detectQuestionTheme(question);
  const questionLabel = questionThemeLabel(questionTheme);
  const physicalTone =
    context.biorhythm.physical === "low"
      ? "身体の波は低めです。これは悪い日という意味ではなく、力を外へ使う前に、土台を守る読み方が合うということです。予定や作業を減らせない場合でも、移動前後の余白、食事や水分、画面から目を離す時間を意識すると、流れが荒れにくくなります。"
      : context.biorhythm.physical === "high"
        ? "身体の波は高めです。動く力はありますが、勢いに任せるほど細かな違和感を見落としやすくなります。今日は動ける自分を信じながらも、途中で立ち止まる合図を先に決めておくと、力を最後までやさしく使えます。"
        : "身体の波は中ほどです。無理に休みに寄せすぎる必要も、強く動かしすぎる必要もありません。普段のペースを基準にして、疲れを感じた瞬間に少し速度を下げるくらいが、今日の体には合っています。";
  const emotionalTone =
    context.biorhythm.emotional === "low"
      ? "心の波は低めです。人の言葉や反応を、いつもより重く受け取りやすいかもしれません。今日は感情をすぐに説明しようとせず、まず自分の中で名前をつける時間を置いてください。"
      : context.biorhythm.emotional === "high"
        ? "心の波は高めです。気づきや共感が増える一方で、人の気配を拾いすぎることもあります。誰かに寄り添う時ほど、自分の内側へ戻る合図を持っておくと、やさしさが負担になりにくくなります。"
        : "心の波は中ほどです。大きく揺れにくいぶん、静かな本音に気づきやすい日です。強い感情だけを手がかりにせず、ふと残る違和感や安心感を丁寧に見てください。";
  const intellectualTone =
    context.biorhythm.intellectual === "low"
      ? "思考の波は低めです。複雑な判断を一度にまとめようとすると、いつもより疲れやすいかもしれません。今日は結論よりも材料集め、決断よりも整理に向いています。"
      : context.biorhythm.intellectual === "high"
        ? "思考の波は高めです。構造や順番を見つける力があります。ただし考えられる日ほど、考え続けてしまうこともあります。見えたことは、三つ以内の手順へ落としてください。"
        : "思考の波は中ほどです。強く冴えるというより、落ち着いて確認する力があります。今日の判断は、情報を増やすより、すでに分かっていることを並べ直す方が整いやすくなります。";

  return [
    {
      id: "numerology-essence",
      title: "数秘術から見る本質",
      summary: `ライフパス${lifePath}と個人日${context.numerology.personalDayNumber}`,
      body: [
        `ライフパス${lifePath}には、${lifeTheme}という背骨があります。これは「あなたはこうでなければならない」という枠ではなく、迷った時に戻れる内側の軸として扱います。深読み鑑定では、この数字を性格のラベルではなく、人生の中で繰り返し現れやすい選び方の癖として見ていきます。`,
        `ライフパスは、得意なことだけを示すものではありません。得意だからこそ背負いやすいこと、自然にできるからこそ軽く見られやすいこと、周りから求められやすい役割も含んでいます。${lifeTheme}の気配は、あなたが何かを選ぶ時の奥で静かに鳴る音です。その音を無理に大きくする必要はありませんが、聞こえないふりを続けると、少しずつ疲れが溜まります。`,
        `今日の個人日は${context.numerology.personalDayNumber}。${dayTheme}の流れを重ねると、今は力を外へ広げるより、使う場所と量を選ぶことが大切になりそうです。個人日は一日の天気のようなものです。あなたの本質そのものを変えるわけではありませんが、どの窓を開けると風が入りやすいかを教えてくれます。`,
        `今日は、ライフパス${lifePath}の大きな流れと、個人日${context.numerology.personalDayNumber}の小さな流れが重なっています。大きな流れは人生の背骨、小さな流れは今日の足元です。背骨だけを見ると理想が大きくなり、足元だけを見ると目の前のことに追われます。二つを重ねることで、「今の自分が無理なく選べる現実的な一歩」が見えてきます。`,
        "深く読む時ほど、答えを急がないことが大切です。数字は命令ではなく、問いをほどくための糸です。今日の数字が示しているのは、あなたが自分を責めるための理由ではなく、力の使い方を少し変えるための手がかりです。",
        `ライフパス${lifePath}の力は、調子がよい時には自然に使えます。けれど疲れている時や、周りの期待が強い時には、その力が義務のように感じられることがあります。だから今日は、「本来の自分ならもっとできるはず」と押し上げるより、「今の自分がこの力を少しだけ使うなら、どの形がやさしいか」と問い直してください。`,
        `個人日${context.numerology.personalDayNumber}の${dayTheme}は、今日だけの小さな流れです。この流れは明日にはまた変わります。だから、今日うまく扱えなかったとしても、あなたの本質が損なわれるわけではありません。今日の分だけ受け取り、今日の分だけ整える。その軽さが、深い読みを現実の生活へ戻してくれます。`
      ].join("\n\n")
    },
    {
      id: "astrology-air",
      title: "星から見る今の空気",
      summary: `${context.astrology.zodiacSign} / ${context.astrology.element} / ${context.astrology.mode}`,
      body: [
        `${context.astrology.zodiacSign}の簡易ヒントでは、${ELEMENT_HINTS[context.astrology.element]}`,
        "ここでは出生時刻や出生地を使わないため、厳密な天体計算ではなく、今日の空気を読む補助線として扱います。数秘が背骨なら、星は光の角度です。何を見やすくして、何を急がせないかを教えてくれます。",
        `星座の読みは、「あなたはこの性格です」と閉じるためのものではありません。${context.astrology.zodiacSign}の空気は、あなたが世界と触れる時に出やすい反応や、安心しやすいリズムを示す小さな地図です。今日はその地図を、数秘の流れと重ねて見ます。`,
        "星の空気が外へ向く時、人は何かを始めたくなります。内へ向く時、人は整える時間を必要とします。どちらが良い悪いではなく、今日の自分がどちらに少し傾いているかを知ることで、無理に逆方向へ走らなくて済みます。",
        "この読みで大切なのは、星を理由に自分を固定しないことです。星はあなたを縛るものではなく、いま見えやすい景色を照らすものです。もし今日、周りの速度と自分の速度がずれていると感じるなら、それは遅れている合図ではなく、別の角度から状況を見る余地があるということかもしれません。",
        `${context.astrology.zodiacSign}の気配は、あなたが外の世界と触れる時の入り口にもなります。人と話す時、仕事へ向かう時、何かを決める時、最初にどんな反応が出やすいか。そこを知っておくと、必要以上に自分を責めずに済みます。反応は悪いものではありません。ただ、そのまま行動に移す前に一度だけ眺めることで、選び方に余白が生まれます。`,
        "星から見る今の空気は、遠くにある正解を探すためではなく、近くにある違和感を見失わないために使います。今日、少し気になる言葉や場面があれば、それをすぐに良い悪いへ分けず、なぜ心に残ったのかを見てください。その静かな観察が、次の判断をやさしく整えてくれます。"
      ].join("\n\n")
    },
    {
      id: "today-wave",
      title: "今日の波",
      summary: `体 ${waveLevelLabel(context.biorhythm.physical)} / 心 ${waveLevelLabel(context.biorhythm.emotional)} / 思考 ${waveLevelLabel(context.biorhythm.intellectual)}`,
      body: [
        marginMessage,
        "この波は、今日の結果を決めるものではありません。ただ、体が先に疲れているのか、心が反応を拾いやすいのか、思考がまとまりにくいのかを分けて見ると、自分を責める前に調整できる余地が生まれます。",
        physicalTone,
        emotionalTone,
        intellectualTone,
        "三つの波は、同時に同じ高さになるとは限りません。体は休みたいのに思考だけが先へ行く日もあります。心は動いているのに体がついてこない日もあります。思考は整理できているのに、感情がまだ追いついていない日もあります。そういう時に必要なのは、自分を一つの状態として決めつけることではなく、どの部分にどれくらいの余白を渡すかを選ぶことです。",
        "今日の波を見る時は、「上がっているから良い」「下がっているから悪い」と読まないでください。低い波は、守る場所を教えてくれます。高い波は、使える力の場所を教えてくれます。中ほどの波は、静かに整える余地を教えてくれます。どの波にも、今日のあなたを助ける意味があります。",
        "もし今日、体だけが重いなら、行動量を少し小さくしてください。心だけが揺れるなら、人の反応を自分の価値と結びつけないでください。思考だけがまとまりにくいなら、答えを出すより材料を並べてください。波を分けて読むことで、対処も分けられます。全部を一度に整えなくてよくなります。",
        "一日の中でも波は感じ方が変わります。朝は重くても、昼に少し動けることがあります。昼に動けても、夜には感情が追いついてくることがあります。だから今日の波は、固定された判定ではなく、こまめに自分へ戻るための目印として使ってください。"
      ].join("\n\n")
    },
    {
      id: "question-layer",
      title: "相談内容との重ね読み",
      summary: questionText ? `${questionLabel}の相談を分解して重ねます` : "相談内容がない場合は人生の流れと今の整え方を中心に読みます",
      body: questionText
        ? [
            `相談内容「${questionText}」は、すぐに一つの答えへまとめなくても大丈夫です。深い鑑定では、問いを急いで解決するより、問いの中に混ざっている層を分けて見ます。そこには、現実の問題、感情の揺れ、過去の経験、まだ言葉になっていない願いが重なっていることがあります。`,
            `今回の相談は「${questionLabel}」のテーマとして受け取ります。ただし、テーマ名は分類のための仮の器です。実際には、仕事の相談の中に人間関係があり、人間関係の相談の中に生活の疲れがあり、お金の相談の中に安心したい気持ちがあることもあります。白音七では、その重なりを無理に切り捨てず、今日扱える大きさへ整えていきます。`,
            `まず、「本当は何を知りたいのか」「何が不安を大きくしているのか」「今日できる範囲はどこまでか」に分けて見てみます。数秘の${dayTheme}は、問いを扱える大きさへ整えることを促します。星の空気は、見落としていた感覚に光を当てます。波は、今日どれくらい踏み込むと疲れすぎるかを教えてくれます。`,
            "大切なのは、今日ひとつの正解を出すことではありません。むしろ、正解を急ぐほど見えなくなる本音があります。今すぐ変えられること、少し時間が必要なこと、自分だけでは抱えなくてよいこと。その三つを分けるだけでも、相談は少し軽くなります。",
            "もし今、焦りが強いなら、焦りそのものを否定しなくて大丈夫です。焦りは、あなたが真剣に向き合っている証でもあります。ただ、その焦りにすべてを任せると、必要以上に自分を追い込んでしまいます。今日は、焦りを行動の燃料にする前に、灯りの近くへ置いて眺めるくらいの距離が合っています。",
            "相談を深く読む時、現実的にできることと、心が納得するまで時間がかかることは別に扱います。現実だけを急いで動かすと、心が置いていかれることがあります。心だけを見つめ続けると、現実の一歩が重くなることがあります。今日はその間に、小さな橋をかける日です。",
            `その橋になるのが「${oneStep}」です。これは最終回答ではなく、今日の問いを明日へつなぐための小さな動きです。動いたあとに状況がすぐ変わらなくても、あなたの中で「選べた」という感覚が残れば、それは十分に意味のある変化です。`
          ].join("\n\n")
        : [
            "今日は具体的な相談内容がなくても、人生全体を急いで決める必要はありません。今は、これまでの流れの中で何を持ち続け、何を少し緩めるかを見る時間です。心に残る一文だけを受け取る形でも、今日の鑑定としては十分です。",
            "相談がない時の深読みは、問題を探すためのものではありません。むしろ、問題になる前の小さな違和感や、まだ育ちきっていない願いに気づくための時間です。いつもは流してしまう感覚を、今日は少しだけ丁寧に見てください。",
            "大きな悩みがない日にも、人は選び続けています。どの言葉を返すか、どこまで引き受けるか、何を後回しにするか。そうした小さな選択の中に、これからの流れを変える種があります。今日の鑑定は、その種を見つけるための静かな読み解きです。"
          ].join("\n\n")
    },
    {
      id: "release",
      title: "手放すこと",
      summary: avoidHint,
      body: [
        `手放す候補は「${avoidHint}」。`,
        "手放す、という言葉は大きく聞こえるかもしれませんが、今日の白音七では「少し距離を置く」くらいの意味で受け取ってください。完全にやめる必要はありません。気づいた時に一呼吸置くことで、反応ではなく選択に戻りやすくなります。",
        "人は、必要だったものを急に手放すことはできません。過去の自分を守ってくれた考え方や、場を保つために身につけた反応は、簡単には消えません。だからこそ、手放す時には責めるより先に、これまで支えてくれたことを認める方が自然です。",
        "今日手放すのは、あなた自身ではありません。あなたを狭くしている見方、急がせすぎる声、少し古くなった守り方です。完全に捨てるのではなく、今の自分に合う距離へ置き直す。そう読むと、手放しは怖いものではなく、余白を取り戻すための小さな整えになります。",
        "もし同じ反応を繰り返してしまっても、それで失敗ではありません。気づくたびに少し戻る。戻るたびに、次はほんの少し早く気づける。今日の手放しは、その始まりくらいで十分です。",
        `特に「${avoidHint}」は、無意識のうちに出やすい反応かもしれません。出てきた瞬間に止められなくても大丈夫です。あとから「あれは少し強かったかもしれない」と気づけたなら、その気づきが次の余白になります。手放しは一度で終わるものではなく、少しずつ手の力を緩めていく過程です。`
      ].join("\n\n")
    },
    {
      id: "next-action",
      title: "これからの行動",
      summary: oneStep,
      body: [
        `これからの一歩は「${oneStep}」。`,
        "この行動は、何かを大きく変えるためではなく、今日の自分に主導権を少し戻すためのものです。うまくできたかどうかより、「自分のペースで選べたか」を見てあげてください。",
        "深い鑑定で受け取る小さな一歩は、派手な突破口ではなく、明日も続けられる小さな設計として受け取るのが合っています。行動を大きくしすぎると、できなかった時に自分を責めやすくなります。けれど小さくほどいた一歩なら、途中で止まっても、また戻ってこられます。",
        "今日の一歩を実行する時は、時間・場所・相手をできるだけ具体的にしてください。いつかやる、ではなく、今日のどこかで一度だけ試す。全部変える、ではなく、ひとつだけ順番を変える。そのくらいの現実感が、鑑定を読み物で終わらせず、生活の中へ静かに置いてくれます。",
        "そして、行動した後には短く振り返ってください。何が軽くなったか。どこで力が入りすぎたか。次に同じ場面が来たら、何を少し減らせそうか。そこまで見られたら、今日の行動は十分に実を結んでいます。",
        "行動は、気持ちが整ってから始めるものとは限りません。小さく動くことで、気持ちがあとから整うこともあります。だから今日の一歩は、勇気を証明するためではなく、流れを少し確かめるために置いてください。確かめるだけなら、失敗という言葉は少し遠くなります。"
      ].join("\n\n")
    },
    {
      id: "relationship-and-work",
      title: "仕事と人間関係の整え方",
      summary: "外側の役割と内側の余白を分けて見ます",
      body: [
        "今日の読みでは、仕事や人間関係をひとつの大きな問題として抱えるより、役割と本音を分けて見ることが助けになります。仕事では、期待されている役割があります。人間関係では、相手との距離や流れがあります。けれどその中に、あなた自身の余白がなくなってしまうと、どれだけうまく進んでいても疲れが残ります。",
        `ライフパス${lifePath}の${lifeTheme}は、周りの状況に対して自然に反応し、何かを整えようとする力として出ることがあります。その力は大切ですが、いつも全部を引き受ける必要はありません。今日の個人日${context.numerology.personalDayNumber}は、引き受けるものと置いておくものを分けることを促しています。`,
        "仕事では、すぐに成果へつながる行動だけでなく、後で迷わないための確認も価値があります。誰かに伝える前に一度整理する。期限や範囲を短く確認する。自分だけで抱えないために、早めに共有する。そうした地味な一手が、今日の流れを静かに支えます。",
        "人間関係では、相手の気持ちを読みすぎないことも大切です。察する力がある人ほど、言われていないことまで背負ってしまいます。今日は、相手の反応をすべて自分の責任にしないでください。必要なことは丁寧に聞く。分からないことは分からないまま置く。その余白が、関係を長く保つ力になります。",
        "また、今日の仕事運や対人運は、目立つ成果よりも「摩擦を小さくする工夫」に出やすいかもしれません。言葉を一つやわらかくする。確認を一つ早める。相手の都合と自分の限界を同時に見る。そうした静かな調整は、すぐには評価されにくくても、後から効いてくる力です。",
        "あなたが周りに合わせることと、自分を消すことは違います。合わせる時にも、自分の中心を残しておくことはできます。今日の深読みでは、その中心を小さく守ることが、仕事にも関係にも共通する鍵になっています。"
      ].join("\n\n")
    },
    {
      id: "life-rhythm",
      title: "生活の中で整えること",
      summary: "鑑定を日常へ戻すための小さな手入れ",
      body: [
        "深く読んだ内容も、生活の中で使えなければ重くなってしまいます。今日の鑑定は、特別な儀式のように扱わなくて大丈夫です。むしろ、いつもの机、いつもの移動、いつもの食事、いつもの眠る前の時間に、ほんの少しだけ置ける形にすると、読み解きはあなたの中に自然に残ります。",
        "生活を整える時は、何かを増やすより、ひとつ減らす方が合う場合があります。通知を見る回数を減らす。夜に考えることをひとつだけ明日に渡す。返事を急ぐ前に水を飲む。小さすぎるように見える行動ほど、疲れている日に守りやすい灯りになります。",
        `今日の波では、体が${waveLevelLabel(context.biorhythm.physical)}、心が${waveLevelLabel(context.biorhythm.emotional)}、思考が${waveLevelLabel(context.biorhythm.intellectual)}です。この三つを生活に戻すなら、体には休む余白、心には反応しない余白、思考には決めきらない余白を渡してください。どれも大きな変化ではありませんが、今日を荒らさずに終える助けになります。`,
        "一日の終わりには、できなかったことを数えるより、守れた余白を一つだけ見つけてください。返事を急がなかった。言いすぎなかった。少し休んだ。ひとつ片づけた。それだけで、今日の鑑定は生活の中でちゃんと使われています。",
        "深い鑑定を受けた日ほど、何か特別なことをしなければと思うかもしれません。けれど、生活は大きな決意より小さな反復で変わります。今日のあなたに必要なのは、劇的な切り替えではなく、明日も自分に戻りやすくするための小さな置き場所です。",
        "眠る前に、今日の言葉を全部読み返す必要はありません。一つだけ残った言葉を選び、明日の自分へ渡してください。その言葉が、朝のあなたを少しだけやさしく迎えてくれます。"
      ].join("\n\n")
    },
    {
      id: "seven-day-integration",
      title: "これから七日間の受け取り方",
      summary: "今日の読み解きを少し長い流れへ置き直します",
      body: [
        "今日の鑑定は、今日だけで使い切らなくても大丈夫です。深読みで受け取った言葉は、その日のうちに全部理解しようとすると少し重くなることがあります。むしろ、これから七日間くらいの小さな流れへ置いて、何度か読み返しながら少しずつ馴染ませる方が自然です。",
        "一日目は、印象に残った言葉を一つだけ選んでください。長い本文の全部ではなく、今の自分が反応した一文だけで十分です。その一文に、安心したのか、少し痛かったのか、よく分からないけれど気になったのかを見てください。反応そのものが、今のあなたの入口になります。",
        "二日目から三日目は、行動より観察を大切にします。昨日選んだ言葉が、どんな場面で思い出されるかを見てください。仕事の途中、人との会話のあと、眠る前、移動中。ふいに浮かぶ場所には、その言葉が生活へつながるための小さな手がかりがあります。",
        `四日目から五日目は、「${oneStep}」を少しだけ試す時期です。大きく実行する必要はありません。五分だけ、ひとつだけ、一度だけ。そういう小さな単位で十分です。行動したあとに少し軽くなったなら、その方向は今のあなたに合っています。重くなったなら、行動の大きさをさらに小さくしてください。`,
        `六日目には、「${avoidHint}」がどんな場面で出やすかったかを見返します。避けられたかどうかではなく、気づけたかどうかを見てください。気づけた場面が一つでもあるなら、それはもう変化の入口です。人は気づけないものを選び直すことはできません。気づけた時点で、次の選択肢は少し増えています。`,
        "七日目には、今日の鑑定をもう一度読み返してみてください。最初に読んだ時とは、目に入る言葉が変わっているかもしれません。変わっていたなら、それはあなたの中で流れが動いた証です。同じ言葉が残っていたなら、それはまだ大切に扱うテーマです。どちらでも大丈夫です。",
        "この七日間の受け取り方は、予定表のようにきっちり守るものではありません。忘れた日があっても、途中で止まっても、また戻れば大丈夫です。白音七の鑑定は、あなたを急がせるためではなく、戻ってこられる場所をつくるためのものです。"
      ].join("\n\n")
    },
    {
      id: "audio-summary",
      title: "耳で受け取る結び",
      summary: "深掘り鑑定の最後に置ける形へ整えます",
      body: [
        `今日の灯りは${dayTheme}。数秘は、あなたの背骨に${lifeTheme}を映しています。星は、今見やすい方向を静かに照らしています。波は、力の入れどころと休ませどころを分けて教えてくれます。`,
        "この鑑定を音声で受け取るなら、すべてを覚えようとしなくて大丈夫です。心に残った一文、少し呼吸が深くなった場所、今はまだ受け取りきれないけれど気になる言葉。そのどれか一つが残れば十分です。",
        `今日の行動は「${oneStep}」。手放す候補は「${avoidHint}」。この二つを強い約束にする必要はありません。今日のあなたが自分へ戻るための、小さな目印として置いてください。`,
        "深く読むほど、未来を決めつけたくなることがあります。けれど白音七の読み解きは、未来を固定するためではなく、今日のあなたが少し選びやすくなるためのものです。迷う日も、疲れた日も、次の一歩をそっと照らす。それくらいの灯りとして、今日の鑑定を受け取ってください。",
        "最後に残すなら、今日のあなたは急がなくて大丈夫です。変わることを急がず、でも何も見ないふりもしない。その間にある静かな場所で、あなたはもう次の一歩を選び始めています。",
        "読み終えたあと、すぐに元気にならなくてもかまいません。深い鑑定は、気持ちを一瞬で切り替えるためのものではなく、自分の中にある小さな声を聞き取りやすくするためのものです。今日のどこかで、少しだけ呼吸が戻る瞬間があれば、それで十分です。灯りは小さくても、戻る場所になります。",
        "明日になって、今日の言葉の意味が少し変わって見えることもあります。それは読みがぶれたのではなく、あなたの受け取り方が動いたということです。必要な言葉は、必要な速度で近づいてきます。"
      ].join("\n\n")
    }
  ];
}

function buildSections(params: SectionBuildParams): ShironeReadingSection[] {
  if (params.plan === "light") return buildLightSections(params);
  if (params.plan === "deep") return buildDeepSections(params);
  return buildFreeSections(params);
}

function buildIconHints(context: ShironeEngineContext): ShironeIconHint[] {
  const biorhythmFocus =
    context.biorhythm.emotional !== "middle"
      ? `感情 ${waveLevelLabel(context.biorhythm.emotional)}`
      : `思考 ${waveLevelLabel(context.biorhythm.intellectual)}`;

  return [
    {
      key: "numerology",
      label: "数秘",
      value: `ライフパス${context.numerology.lifePathNumber}`,
      icon: "月",
      tone: "gold"
    },
    {
      key: "astrology",
      label: "星",
      value: context.astrology.zodiacSign,
      icon: "星",
      tone: "purple"
    },
    {
      key: "biorhythm",
      label: "波",
      value: biorhythmFocus,
      icon: "波",
      tone: "blue"
    }
  ];
}

function buildKnowledgePayload(params: {
  plan: ShironePlan;
  input: ShironeEngineInput;
  context: ShironeEngineContext;
  title: string;
  todayMessage: string;
  oneStep: string;
  avoidHint: string;
}): ShironeKnowledgePayload {
  const { plan, input, context, title, todayMessage, oneStep, avoidHint } = params;
  const questionTheme = detectQuestionTheme(input.question);

  return {
    plan,
    inputSummary: {
      hasName: Boolean(input.name?.trim()),
      hasQuestion: Boolean(input.question?.trim()),
      questionTheme
    },
    context,
    resultSummary: {
      title,
      todayMessage,
      oneStep,
      avoidHint
    },
    tags: [
      `plan:${plan}`,
      `question:${questionTheme}`,
      `lifePath:${context.numerology.lifePathNumber}`,
      `personalDay:${context.numerology.personalDayNumber}`,
      `zodiac:${context.astrology.zodiacSign}`,
      `element:${context.astrology.element}`,
      `bio:physical:${context.biorhythm.physical}`,
      `bio:emotional:${context.biorhythm.emotional}`,
      `bio:intellectual:${context.biorhythm.intellectual}`
    ]
  };
}

function planLabel(plan: ShironePlan): string {
  const labels: Record<ShironePlan, string> = {
    free: "無料鑑定",
    light: "軽め鑑定",
    deep: "深掘り鑑定"
  };

  return labels[plan];
}

function buildShortSummary(message: string): string {
  const normalized = message.replace(/\s+/g, " ").trim();
  const limit = 110;

  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit)}...`;
}

function buildCreatedAtFromToday(today: string): string {
  return `${today}T00:00:00.000Z`;
}

function buildHistoryPayloadV2(params: {
  input: ShironeEngineInput;
  resolvedToday: string;
  plan: ShironePlan;
  context: ShironeEngineContext;
  title: string;
  todayMessage: string;
  marginMessage: string;
  oneStep: string;
  avoidHint: string;
  audioScript: string;
  sections: ShironeReadingSection[];
  iconHints: ShironeIconHint[];
  knowledgePayload: ShironeKnowledgePayload;
}): ShironeHistoryPayloadV2 {
  const {
    input,
    resolvedToday,
    plan,
    context,
    title,
    todayMessage,
    marginMessage,
    oneStep,
    avoidHint,
    audioScript,
    sections,
    iconHints,
    knowledgePayload
  } = params;
  const name = input.name?.trim();
  const question = input.question?.trim();

  return {
    version: "shirone-history-v2",
    plan,
    createdAt: buildCreatedAtFromToday(resolvedToday),
    input: {
      birthDate: input.birthDate,
      ...(name ? { name } : {}),
      ...(question ? { question } : {}),
      today: resolvedToday
    },
    context,
    result: {
      title,
      todayMessage,
      marginMessage,
      oneStep,
      avoidHint,
      audioScript,
      sections,
      iconHints
    },
    knowledgePayload,
    summary: {
      displayTitle: title,
      shortSummary: buildShortSummary(todayMessage),
      primaryTag: knowledgePayload.tags[0] ?? `plan:${plan}`,
      planLabel: planLabel(plan)
    }
  };
}

function buildResult(input: ShironeEngineInput, context: ShironeEngineContext, resolvedToday: string): ShironeEngineResult {
  const plan = normalizePlan(input.plan);
  const name = input.name?.trim();
  const questionText = input.question?.trim() ?? "";
  const questionTheme = detectQuestionTheme(input.question);
  const numerologyDay = cycleNumber(context.numerology.personalDayNumber);
  const lifeTheme = NUMBER_THEMES[context.numerology.lifePathNumber] ?? NUMBER_THEMES[cycleNumber(context.numerology.lifePathNumber)];
  const dayTheme = NUMBER_THEMES[numerologyDay];
  const address = name ? `${name}さん` : "あなた";
  const title = `今日の灯りは「${dayTheme}」`;
  const oneStep = STEP_MESSAGES[numerologyDay];
  const avoidHint = AVOID_MESSAGES[numerologyDay];
  const textParams: PlanTextParams = {
    plan,
    address,
    questionText,
    questionTheme,
    numerologyDay,
    dayTheme,
    lifeTheme,
    title,
    oneStep,
    avoidHint,
    context
  };
  const todayMessage = buildPlanTodayMessage(textParams);
  const marginMessage = buildPlanMarginMessage(textParams);
  const audioScript = buildPlanAudioScript(textParams, todayMessage, marginMessage);
  const sections = buildSections({
    plan,
    today: resolvedToday,
    identitySeed: `${input.name?.trim() ?? ""}|${input.birthDate}`,
    title,
    todayMessage,
    marginMessage,
    oneStep,
    avoidHint,
    context,
    question: input.question
  });
  const knowledgePayload = buildKnowledgePayload({
    plan,
    input,
    context,
    title,
    todayMessage,
    oneStep,
    avoidHint
  });
  const iconHints = buildIconHints(context);
  const historyPayloadV2 = buildHistoryPayloadV2({
    input,
    resolvedToday,
    plan,
    context,
    title,
    todayMessage,
    marginMessage,
    oneStep,
    avoidHint,
    audioScript,
    sections,
    iconHints,
    knowledgePayload
  });

  return {
    plan,
    lengthRange: LENGTH_RANGES[plan],
    title,
    todayMessage,
    marginMessage,
    oneStep,
    avoidHint,
    audioScript,
    sections,
    knowledgePayload,
    historyPayloadV2,
    iconHints,
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

  return buildResult(input, context, today);
}
