export type GenderValue = "" | "male" | "female" | string;

export type DailyFortuneInput = {
  name: string;
  birthday: string;
  gender?: GenderValue;
};

export type DailyFortuneResult = {
  engineVersion: string;
  fortuneDate: string;
  displayName: string;
  zodiac: string;
  lifePathNumber: number;
  personalDayNumber: number;
  nameNumber: number;
  theme: string;
  summary: string;
  flow: string;
  mind: string;
  outer: string;
  action: string;
  caution: string;
  keyword: string;
  luckyAction: string;
};

const ENGINE_VERSION = "shirone7-daily-v1";

const LIFE_PATH_THEMES: Record<number, string> = {
  1: "自分の意志を立てる人",
  2: "人との間に流れを作る人",
  3: "言葉と表現で場を明るくする人",
  4: "積み重ねで信頼を作る人",
  5: "変化の中で道を見つける人",
  6: "大切なものを守り育てる人",
  7: "深く見つめ本質を探る人",
  8: "現実を動かし形にする人",
  9: "広い視点で受け止める人",
  11: "直感で光を受け取る人",
  22: "大きな理想を現実へ落とす人",
  33: "やさしさを広く渡す人"
};

const DAY_THEMES: Record<number, string> = {
  1: "始まり",
  2: "調整",
  3: "表現",
  4: "整備",
  5: "変化",
  6: "愛情",
  7: "内省",
  8: "実行",
  9: "手放し"
};

const DAY_TONES: Record<number, string[]> = {
  1: [
    "小さく始めたことが流れを変えやすい日です",
    "迷いを減らし最初の一手を選ぶほど運が動きます",
    "誰かの合図を待つより自分のタイミングを信じたい日です"
  ],
  2: [
    "強く押すより相手との間合いを整える日です",
    "返事や判断を急がず流れを見た方がまとまります",
    "人の言葉にヒントが混ざりやすい日です"
  ],
  3: [
    "言葉にすることで気持ちが軽くなりやすい日です",
    "表に出したものから次の縁が広がります",
    "少し明るい選択が流れを柔らかくします"
  ],
  4: [
    "足元を整えるほど安心が戻る日です",
    "派手な変化より手順の見直しが効きます",
    "小さな整理があとで大きな助けになります"
  ],
  5: [
    "いつもと違う選択が空気を入れ替えます",
    "予定を固めすぎず余白を残すと動きやすい日です",
    "変化を怖がりすぎないことが流れを開きます"
  ],
  6: [
    "大切な人や居場所を整えることで心が戻ります",
    "誰かを気にかけるほど自分の軸も見えてきます",
    "やさしさと境界線の両方が必要な日です"
  ],
  7: [
    "静かに考える時間が答えを近づけます",
    "外へ広げるより内側を点検したい日です",
    "違和感を見過ごさないことが今日の鍵です"
  ],
  8: [
    "決めたことを形に移す力が強まる日です",
    "結果に向けて一つ進めるほど流れが締まります",
    "曖昧なままにせず優先順位を決めたい日です"
  ],
  9: [
    "抱えすぎたものを一つ下ろす日です",
    "終わらせることで次の余白が生まれます",
    "許すことや離れることが流れを軽くします"
  ]
};

const MIND_TONES: Record<number, string[]> = {
  1: ["気持ちは前へ向きやすい反面 少し焦りも出そうです", "自分で決めたい気持ちが強くなりやすい日です"],
  2: ["心は人の反応を拾いやすくなっています", "やさしさが出るぶん疲れも受け取りやすい日です"],
  3: ["言いたいことが増えますが軽さを大切にすると整います", "気分転換が心の風通しを良くします"],
  4: ["安心できる形を求めやすい日です", "細かな不安は整理すると静まります"],
  5: ["心が少し外へ向きやすく刺激を求めます", "変えたい気持ちと守りたい気持ちが揺れそうです"],
  6: ["大切な人のことを考える時間が増えそうです", "面倒を見る力が出ますが背負いすぎには注意です"],
  7: ["静かな場所で本音が見えやすい日です", "考えすぎる前に一度休むと整います"],
  8: ["結果を出したい気持ちが強まりやすい日です", "現実的な判断がしやすい一方で力みも出そうです"],
  9: ["気持ちの奥にある疲れや未練に気づきやすい日です", "無理に明るく振る舞わなくても大丈夫です"]
};

const NAME_TONES: Record<number, string[]> = {
  1: ["外からは意志がはっきりした人に見えやすいです", "頼られる場面では先頭に立つ印象が出ます"],
  2: ["外からは穏やかで話しやすい人に見えやすいです", "場の空気を読める人として受け取られやすいです"],
  3: ["外からは明るく場を和ませる人に見えやすいです", "言葉や反応に親しみやすさが出ます"],
  4: ["外からは堅実で任せやすい人に見えやすいです", "積み重ねを大切にする印象が出ます"],
  5: ["外からは柔軟で動きのある人に見えやすいです", "変化に強い人として映りやすいです"],
  6: ["外からは面倒見がよく責任感のある人に見えやすいです", "安心感を与える人として受け取られやすいです"],
  7: ["外からは落ち着いて深く考える人に見えやすいです", "少し神秘的で読めない魅力も出ます"],
  8: ["外からは現実を動かせる頼れる人に見えやすいです", "結果に強い人として認識されやすいです"],
  9: ["外からは包容力があり視野の広い人に見えやすいです", "受け止める力のある人として映りやすいです"]
};

const ACTIONS: Record<number, string[]> = {
  1: ["朝のうちに今日やることを一つだけ決める", "後回しにしていた小さな着手をする", "短い宣言をメモに残す"],
  2: ["返事を急がず一度読み返す", "相手の事情を一つ想像してから動く", "水分を取りながら呼吸を整える"],
  3: ["短い言葉で気持ちを共有する", "好きな音楽や会話で空気を変える", "思いつきをメモに残す"],
  4: ["机や鞄の中を一か所だけ整える", "手順を一つ減らせないか見直す", "予定を詰めすぎず確認する"],
  5: ["いつもと違う道や方法を選ぶ", "予定に小さな余白を作る", "気になった情報を一つ試す"],
  6: ["身近な人に一言やさしく声をかける", "部屋の落ち着く場所を整える", "自分にも同じだけやさしくする"],
  7: ["静かな時間を10分だけ作る", "違和感を書き出して眺める", "情報を増やすより一つ深く見る"],
  8: ["優先順位を一つ決めて実行する", "数字や期限を確認する", "決めたことを形に残す"],
  9: ["不要な通知や予定を一つ減らす", "終わったことを終わったと認める", "手放したいものを一つ書く"]
};

const CAUTIONS: Record<number, string[]> = {
  1: ["勢いだけで決め切らないこと", "正しさを押しつけすぎないこと"],
  2: ["相手に合わせすぎて自分を消さないこと", "返事を待つ時間に心を削られすぎないこと"],
  3: ["言いすぎや広げすぎに注意です", "軽い約束を増やしすぎないこと"],
  4: ["完璧を求めすぎないこと", "小さな乱れを責めすぎないこと"],
  5: ["衝動で予定を崩しすぎないこと", "刺激を求めて疲れを見落とさないこと"],
  6: ["背負いすぎないこと", "やさしさを義務にしないこと"],
  7: ["考えすぎて動けなくならないこと", "一人で抱え込みすぎないこと"],
  8: ["結果だけで自分を測らないこと", "強く出すぎて周りを置いていかないこと"],
  9: ["過去を何度もなぞりすぎないこと", "全部を丸く収めようとしすぎないこと"]
};

const KEYWORDS = [
  "余白", "整える", "小さな一歩", "見直し", "追い風", "境界線", "深呼吸", "選び直し", "静かな決意",
  "手放し", "めぐり", "灯り", "準備", "調和", "再起動", "声にする", "流れを見る", "守る力"
];

function toDigits(value: string): number[] {
  return value.replace(/\D/g, "").split("").map(Number).filter((n) => Number.isFinite(n));
}

function sumDigits(value: string): number {
  return toDigits(value).reduce((sum, n) => sum + n, 0);
}

function reduceNumber(num: number, keepMaster = false): number {
  let n = Math.abs(Math.floor(num));

  while (n > 9) {
    if (keepMaster && (n === 11 || n === 22 || n === 33)) return n;
    n = String(n).split("").reduce((sum, v) => sum + Number(v), 0);
  }

  return n || 1;
}

function parseBirthday(birthday: string): { year: number; month: number; day: number } {
  const [year, month, day] = birthday.split("-").map(Number);

  if (!year || !month || !day) {
    throw new Error("生年月日が正しくありません");
  }

  return { year, month, day };
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getZodiac(month: number, day: number): string {
  if ((month === 3 && day >= 21) || (month === 4 && day <= 19)) return "牡羊座";
  if ((month === 4 && day >= 20) || (month === 5 && day <= 20)) return "牡牛座";
  if ((month === 5 && day >= 21) || (month === 6 && day <= 21)) return "双子座";
  if ((month === 6 && day >= 22) || (month === 7 && day <= 22)) return "蟹座";
  if ((month === 7 && day >= 23) || (month === 8 && day <= 22)) return "獅子座";
  if ((month === 8 && day >= 23) || (month === 9 && day <= 22)) return "乙女座";
  if ((month === 9 && day >= 23) || (month === 10 && day <= 23)) return "天秤座";
  if ((month === 10 && day >= 24) || (month === 11 && day <= 22)) return "蠍座";
  if ((month === 11 && day >= 23) || (month === 12 && day <= 21)) return "射手座";
  if ((month === 12 && day >= 22) || (month === 1 && day <= 19)) return "山羊座";
  if ((month === 1 && day >= 20) || (month === 2 && day <= 18)) return "水瓶座";
  return "魚座";
}

function nameNumber(name: string): number {
  const stripped = name.replace(/\s/g, "");
  const total = Array.from(stripped).reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
  return reduceNumber(total);
}

function hashString(value: string): number {
  let hash = 2166136261;

  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

function pick<T>(items: T[], seed: number, salt: number): T {
  return items[(seed + salt * 97) % items.length];
}

function normalizeNine(value: number): number {
  const n = value % 9;
  return n === 0 ? 9 : n;
}

export function calculateLifePathNumber(birthday: string): number {
  const total = sumDigits(birthday);
  return reduceNumber(total, true);
}

export function calculatePersonalDayNumber(birthday: string, date = new Date()): number {
  const birth = parseBirthday(birthday);
  const today = formatLocalDate(date);
  const total = birth.month + birth.day + sumDigits(today);
  return reduceNumber(total);
}

export function buildDailyFortune(input: DailyFortuneInput, date = new Date()): DailyFortuneResult {
  const name = input.name.trim();
  const birthday = input.birthday;
  const birth = parseBirthday(birthday);
  const fortuneDate = formatLocalDate(date);

  const lifePathNumber = calculateLifePathNumber(birthday);
  const personalDayNumber = calculatePersonalDayNumber(birthday, date);
  const userNameNumber = nameNumber(name);
  const zodiac = getZodiac(birth.month, birth.day);
  const seed = hashString(`${name}|${birthday}|${fortuneDate}|${lifePathNumber}|${personalDayNumber}|${userNameNumber}`);

  const lifeTheme = LIFE_PATH_THEMES[lifePathNumber] || LIFE_PATH_THEMES[reduceNumber(lifePathNumber)];
  const dayTheme = DAY_THEMES[personalDayNumber];
  const theme = `${dayTheme} × ${lifeTheme}`;

  const flowBase = pick(DAY_TONES[personalDayNumber], seed, 1);
  const mindBase = pick(MIND_TONES[personalDayNumber], seed, 2);
  const outerBase = pick(NAME_TONES[userNameNumber], seed, 3);
  const action = pick(ACTIONS[personalDayNumber], seed, 4);
  const caution = pick(CAUTIONS[personalDayNumber], seed, 5);
  const keyword = pick(KEYWORDS, seed, normalizeNine(lifePathNumber) + personalDayNumber);

  const lifeHint = lifePathNumber === 11 || lifePathNumber === 22 || lifePathNumber === 33
    ? `ライフパス${lifePathNumber}の強い感受性は 今日は小さく現実に落とすほど扱いやすくなります`
    : `ライフパス${lifePathNumber}の性質は 今日は「${dayTheme}」の流れに乗せると生きやすくなります`;

  const summary = `${name}さんの今日は「${theme}」の日です`;
  const flow = `${flowBase}\n${lifeHint}`;
  const mind = `${mindBase}\n心が揺れたら キーワードは「${keyword}」です`;
  const outer = `${zodiac}の気質に ${outerBase}\n無理に印象を作るより 自然な反応が味方になります`;
  const luckyAction = `今日の一手は「${action}」です`;
  const cautionText = `避けたいことは「${caution}」です`;

  return {
    engineVersion: ENGINE_VERSION,
    fortuneDate,
    displayName: `${name}さん`,
    zodiac,
    lifePathNumber,
    personalDayNumber,
    nameNumber: userNameNumber,
    theme,
    summary,
    flow,
    mind,
    outer,
    action: luckyAction,
    caution: cautionText,
    keyword,
    luckyAction: action
  };
}
