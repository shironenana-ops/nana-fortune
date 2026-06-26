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
    min: 10000,
    max: 30000,
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
    `バイオリズムでは、体は${params.context.biorhythm.physical}、心は${params.context.biorhythm.emotional}、思考は${params.context.biorhythm.intellectual}の波です。これは断定ではなく、力の配分を見るための目安です。`,
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
      `体の波は${params.context.biorhythm.physical}、心の波は${params.context.biorhythm.emotional}、思考の波は${params.context.biorhythm.intellectual}です。`,
      "全部を同じ強さで動かそうとせず、いちばん疲れやすいところに少し余白を渡してみてください。"
    ].join("\n");
  }

  return [
    base,
    `今日の波を分けて見ると、体は${params.context.biorhythm.physical}、心は${params.context.biorhythm.emotional}、思考は${params.context.biorhythm.intellectual}です。`,
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
  title: string;
  todayMessage: string;
  marginMessage: string;
  oneStep: string;
  avoidHint: string;
  context: ShironeEngineContext;
  question?: string;
};

function buildFreeSections(params: SectionBuildParams): ShironeReadingSection[] {
  const { title, todayMessage, marginMessage, oneStep } = params;

  return [
    {
      id: "today-line",
      title: "今日の一文",
      summary: title,
      body: todayMessage
    },
    {
      id: "margin",
      title: "今の余白",
      summary: "休む幅を少しだけ残します",
      body: marginMessage
    },
    {
      id: "one-step",
      title: "無理しない一歩",
      summary: oneStep,
      body: `今日できることは「${oneStep}」。\nここまでで大丈夫です。\n続きは、気力が戻った時に少しずつでかまいません。`
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

  return [
    {
      id: "daily-flow",
      title: "今日の流れ",
      summary: `${dayTheme}の流れを読み物として整理します`,
      body: todayMessage
    },
    {
      id: "essence",
      title: "あなたの本質",
      summary: `ライフパス${lifePath}の気配`,
      body: `ライフパス${lifePath}は、${lifeTheme}を人生の背骨として持ちます。\n今日それを強く証明しようとしなくても大丈夫です。むしろ、日常の小さな選択に落とし込むことで、その本質はやさしく使いやすくなります。`
    },
    {
      id: "current-theme",
      title: "今のテーマ",
      summary: `${context.astrology.zodiacSign}の空気と今日の波`,
      body: `${context.astrology.zodiacSign}の星の空気は、${ELEMENT_HINTS[context.astrology.element]}\nそこに今日の波を重ねると、体・心・思考を同じ速度で進めるより、どこに余白を置くかを選ぶことがテーマになりそうです。\n${marginMessage}`
    },
    {
      id: "question-hint",
      title: "相談内容へのヒント",
      summary: questionText ? `${questionLabel}の相談を今日の流れに重ねます` : "相談がない時は今のテーマを中心に読みます",
      body: questionText
        ? `相談内容「${questionText}」は、今日の流れでは急いで結論にするより、まず今できる行動へ近づけると扱いやすそうです。\n問いを一段小さくして、「今日返せる言葉」「今日整えられる場所」「今日保てる距離」のように見ると、次の一手が見えやすくなります。`
        : "今は大きな相談がなくても、今日のテーマを受け取るだけで十分です。本質と波を重ねて見ることで、今の自分に合う速度が少し分かりやすくなります。"
    },
    {
      id: "action-hint",
      title: "行動ヒント",
      summary: oneStep,
      body: `今日の一歩は「${oneStep}」。\nただ行動するだけでなく、始める前に一度だけ「これは今の自分にとって小さくできているか」を確認してみてください。`
    },
    {
      id: "avoid-hint",
      title: "避けたいこと",
      summary: avoidHint,
      body: `今日は「${avoidHint}」を少しだけ避けると、心の余白が残りやすくなります。\n避けることは逃げではなく、自分の流れを乱しすぎないための小さな調整です。`
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

  return [
    {
      id: "numerology-essence",
      title: "数秘術から見る本質",
      summary: `ライフパス${lifePath}と個人日${context.numerology.personalDayNumber}`,
      body: `ライフパス${lifePath}には、${lifeTheme}という背骨があります。\nこれは「あなたはこうでなければならない」という枠ではなく、迷った時に戻れる内側の軸として扱います。\n\n今日の個人日は${context.numerology.personalDayNumber}。${dayTheme}の流れを重ねると、今は力を外へ広げるより、使う場所と量を選ぶことが大切になりそうです。`
    },
    {
      id: "astrology-air",
      title: "星から見る今の空気",
      summary: `${context.astrology.zodiacSign} / ${context.astrology.element} / ${context.astrology.mode}`,
      body: `${context.astrology.zodiacSign}の簡易ヒントでは、${ELEMENT_HINTS[context.astrology.element]}\n\nここでは出生時刻や出生地を使わないため、厳密な天体計算ではなく、今日の空気を読む補助線として扱います。\n数秘が背骨なら、星は光の角度です。何を見やすくして、何を急がせないかを教えてくれます。`
    },
    {
      id: "today-wave",
      title: "今日の波",
      summary: `体 ${context.biorhythm.physical} / 心 ${context.biorhythm.emotional} / 思考 ${context.biorhythm.intellectual}`,
      body: `${marginMessage}\n\nこの波は、今日の結果を決めるものではありません。\nただ、体が先に疲れているのか、心が反応を拾いやすいのか、思考がまとまりにくいのかを分けて見ると、自分を責める前に調整できる余地が生まれます。`
    },
    {
      id: "question-layer",
      title: "相談内容との重ね読み",
      summary: questionText ? `${questionLabel}の相談を分解して重ねます` : "相談内容がない場合は人生の流れと今の整え方を中心に読みます",
      body: questionText
        ? `相談内容「${questionText}」は、すぐに一つの答えへまとめなくても大丈夫です。\n\nまず、「本当は何を知りたいのか」「何が不安を大きくしているのか」「今日できる範囲はどこまでか」に分けて見てみます。\n数秘の${dayTheme}は、問いを扱える大きさへ整えることを促します。星の空気は、見落としていた感覚に光を当てます。波は、今日どれくらい踏み込むと疲れすぎるかを教えてくれます。`
        : "今日は具体的な相談内容がなくても、人生全体を急いで決める必要はありません。\n今は、これまでの流れの中で何を持ち続け、何を少し緩めるかを見る時間です。\n心に残る一文だけを受け取る形でも、今日の鑑定としては十分です。"
    },
    {
      id: "release",
      title: "手放すこと",
      summary: avoidHint,
      body: `手放す候補は「${avoidHint}」。\n\n手放す、という言葉は大きく聞こえるかもしれませんが、今日の白音七では「少し距離を置く」くらいの意味で受け取ってください。\n完全にやめる必要はありません。気づいた時に一呼吸置くことで、反応ではなく選択に戻りやすくなります。`
    },
    {
      id: "next-action",
      title: "これからの行動",
      summary: oneStep,
      body: `これからの一歩は「${oneStep}」。\n\nこの行動は、何かを大きく変えるためではなく、今日の自分に主導権を少し戻すためのものです。\nうまくできたかどうかより、「自分のペースで選べたか」を見てあげてください。`
    },
    {
      id: "audio-summary",
      title: "音声で受け取るためのまとめ",
      summary: "深掘り鑑定の最後に置ける形へ整えます",
      body: `今日の灯りは${dayTheme}。\n数秘は、あなたの背骨に${lifeTheme}を映しています。\n星は、今見やすい方向を静かに照らしています。\n波は、力の入れどころと休ませどころを分けて教えてくれます。\n\n余白を残しながら、${oneStep}。\nあなたのペースで大丈夫です。`
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
      ? `感情 ${context.biorhythm.emotional}`
      : `思考 ${context.biorhythm.intellectual}`;

  return [
    {
      key: "numerology",
      label: "数秘",
      value: `LP${context.numerology.lifePathNumber}`,
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

function buildResult(input: ShironeEngineInput, context: ShironeEngineContext): ShironeEngineResult {
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

  return buildResult(input, context);
}
