export type ShironePhaseKey = "sun" | "moon";

export type ShironePhase = {
  key: ShironePhaseKey;
  label: string;
  description: string;
};

export type ShironeType = {
  slug: string;
  typeName: string;
  reading: string;
  displayNumber: number;
  kind: "base" | "special";
  phases?: readonly ShironePhase[];
  phase?: ShironePhase;
  specialNote?: string;
  catchphrase: string;
  motif: string;
  colorsText: string;
  icon: string;
  summary: string;
  strengths: string;
  weakness: string;
  love: string;
  work: string;
  relationship: string;
  todayMessage: string;
  compatibilityHint: string;
  gentleMessage: string;
};

export const shironePhases = [
  {
    key: "sun",
    label: "陽の相",
    description: "外へひらき、形にしていく力",
  },
  {
    key: "moon",
    label: "月の相",
    description: "内へ深め、気配を受け取る力",
  },
] as const satisfies readonly ShironePhase[];

const specialAttributeNote =
  "陽の相・月の相には分けず、属性そのものの響きとして読みます。優劣ではなく、読み方が少し違う属性です。";

export const shironeBaseTypes = [
  {
    slug: "moonlight",
    typeName: "月灯属性",
    reading: "つきあかり",
    displayNumber: 1,
    kind: "base",
    phases: shironePhases,
    catchphrase: "静かな光で人を照らす人",
    motif: "月、灯、夜道",
    colorsText: "月白、淡い金、深い紺",
    icon: "月",
    summary:
      "目立つよりも、そばにいることで安心を渡す人。人の変化に気づきやすく、言葉にしない寂しさも拾いやすいタイプです。",
    strengths: "落ち着き、観察力、包み込むやさしさ。",
    weakness:
      "自分の願いを後回しにしやすいところがあります。気づきすぎて疲れる日は、少し距離を置いて大丈夫です。",
    love:
      "急に燃え上がるより、信頼を重ねる恋が向いています。安心できる時間の中で心が開いていきます。",
    work:
      "支える役、整える役、相談される役で力を発揮します。場を落ち着かせる仕事と相性がよいタイプです。",
    relationship:
      "少人数の深い関係を大切にします。無理に広げるより、帰ってこられる関係を育てると整います。",
    todayMessage:
      "今日は無理に明るくしなくて大丈夫\n小さな灯りをひとつ守れたら十分です",
    compatibilityHint:
      "火織属性に背中を押され、風音属性に視野を広げられます。",
    gentleMessage:
      "あなたの静けさは\n誰かにとって帰る場所になります",
  },
  {
    slug: "stargazer",
    typeName: "星詠属性",
    reading: "ほしよみ",
    displayNumber: 2,
    kind: "base",
    phases: shironePhases,
    catchphrase: "遠くの意味を見つける人",
    motif: "星図、夜空、羅針盤",
    colorsText: "群青、銀、淡い紫",
    icon: "星",
    summary:
      "目の前の出来事から、少し先の流れを読む人。考えること、つなげること、意味を探すことが得意です。",
    strengths: "洞察力、想像力、言葉にする力。",
    weakness:
      "考えすぎて動き出しが遅くなることがあります。答えを出す前に、小さく試すと流れが動きます。",
    love:
      "心の深い話ができる相手に惹かれます。言葉の奥にある価値観を大切にします。",
    work:
      "企画、分析、文章、設計、相談役に向きます。見えない流れを整理する場面で力が出ます。",
    relationship:
      "広く浅くより、価値観が響く人を大切にします。ひとりの時間も大切な充電です。",
    todayMessage:
      "今日は答えを急がなくて大丈夫\n見上げた先に次の目印が出てきます",
    compatibilityHint:
      "水鏡属性と内面を深め、風音属性と可能性を広げます。",
    gentleMessage:
      "あなたが見つける意味は\n誰かの夜道の星になります",
  },
  {
    slug: "water-mirror",
    typeName: "水鏡属性",
    reading: "みかがみ",
    displayNumber: 3,
    kind: "base",
    phases: shironePhases,
    catchphrase: "心の揺れを映して整える人",
    motif: "水面、鏡、雫",
    colorsText: "青緑、水色、透明感のある白",
    icon: "鏡",
    summary:
      "感受性が高く、場の空気や相手の気持ちを自然に受け取る人。自分の心を整えるほど、周りにも穏やかさが広がります。",
    strengths: "共感力、調整力、深い理解。",
    weakness:
      "人の感情を受け取りすぎることがあります。境界線を持つことは、冷たさではなく自分を守る力です。",
    love:
      "安心できる距離感と誠実な言葉を大切にします。急かされない関係で魅力がやわらかく出ます。",
    work:
      "ケア、調整、聞く仕事、表現に向きます。人の本音を汲み取る場で力を発揮します。",
    relationship:
      "相手に合わせすぎず、自分の水面を静かに保つことが鍵です。",
    todayMessage:
      "今日は心の水面を静かにして\n本当の気持ちを映してみてください",
    compatibilityHint:
      "月灯属性に安心し、星詠属性に言葉をもらえます。",
    gentleMessage:
      "揺れる心は弱さではなく\n深く感じられる力です",
  },
  {
    slug: "flower-keeper",
    typeName: "花守属性",
    reading: "はなもり",
    displayNumber: 4,
    kind: "base",
    phases: shironePhases,
    catchphrase: "小さな美しさを育てる人",
    motif: "花、庭、つぼみ",
    colorsText: "桜、若葉、生成り",
    icon: "花",
    summary:
      "日々の中の小さな喜びを見つけ、育てていける人。人や物事の良いところを見逃さない、あたたかなタイプです。",
    strengths: "育てる力、継続力、やさしい美意識。",
    weakness:
      "期待に応えようとして、自分を小さくしてしまうことがあります。あなた自身にも手入れが必要です。",
    love:
      "穏やかに育つ恋が向いています。日常を一緒に大切にできる相手と合います。",
    work:
      "育成、制作、接客、暮らしに関わる仕事で力が出ます。小さな改善を積み重ねることが得意です。",
    relationship:
      "相手を大切にする分、自分も大切にする練習が必要です。",
    todayMessage:
      "今日は小さな手入れの日\nひとつ整えるだけで運が息を吹き返します",
    compatibilityHint:
      "月灯属性と安心を育て、火織属性から行動力をもらえます。",
    gentleMessage:
      "あなたが大切にしたものは\nゆっくり花を開いていきます",
  },
  {
    slug: "windpath",
    typeName: "風音属性",
    reading: "かざね",
    displayNumber: 5,
    kind: "base",
    phases: shironePhases,
    catchphrase: "変化の流れを読む人",
    motif: "風、旅、羽",
    colorsText: "薄灰、空色、白",
    icon: "風",
    summary:
      "軽やかに動き、変化の中で道を見つける人。新しい空気を取り入れることで、心と運が動きやすくなります。",
    strengths: "柔軟性、発想力、切り替える力。",
    weakness:
      "気持ちが散りやすく、続ける前に次へ行きたくなることがあります。戻る場所をひとつ決めると安定します。",
    love:
      "自由さを尊重してくれる相手と合います。束縛よりも信頼が、心を近づけます。",
    work:
      "発信、企画、移動の多い仕事、変化のある環境に向きます。",
    relationship:
      "軽やかな距離感が心地よいタイプです。会うたびに新しい風を運べます。",
    todayMessage:
      "今日は風向きが少し変わります\n予定外の流れにも小さなヒントがあります",
    compatibilityHint:
      "星詠属性に方向をもらい、白音属性に落ち着きをもらえます。",
    gentleMessage:
      "変わっていくあなたも\nちゃんとあなたのままです",
  },
  {
    slug: "fire-knot",
    typeName: "火織属性",
    reading: "ひおり",
    displayNumber: 6,
    kind: "base",
    phases: shironePhases,
    catchphrase: "情熱を形に結ぶ人",
    motif: "火、結び、朝焼け",
    colorsText: "朱、琥珀、深い赤",
    icon: "火",
    summary:
      "心に火がつくと、まっすぐ動ける人。思いを形にする力があり、周りを温める勢いも持っています。",
    strengths: "行動力、決断力、熱量。",
    weakness:
      "急ぎすぎて、自分にも人にも厳しくなることがあります。火を弱める時間も力の一部です。",
    love:
      "好きになると誠実でまっすぐ。曖昧な関係より、心の向きが見える関係を好みます。",
    work:
      "リーダー役、実行役、勝負どころのある仕事に向きます。",
    relationship:
      "熱さを受け止めてくれる相手と深くつながります。言葉が強くなりすぎないようにすると整います。",
    todayMessage:
      "今日は小さく火を灯す日\n全部を変えなくても一歩で流れは動きます",
    compatibilityHint:
      "月灯属性に落ち着きをもらい、花守属性に持続力をもらえます。",
    gentleMessage:
      "あなたの熱は\n未来を温めるためにあります",
  },
  {
    slug: "shirone",
    typeName: "白音属性",
    reading: "しろね",
    displayNumber: 7,
    kind: "base",
    phases: shironePhases,
    catchphrase: "余白の奥に本音を響かせる人",
    motif: "白い音、余白、鈴",
    colorsText: "白、真珠、淡い金",
    icon: "音",
    summary:
      "静かな中に、独自の感性と芯を持つ人。はっきり言葉にしなくても、存在そのものに不思議な余韻があります。",
    strengths: "直感、余白を読む力、自分だけの感性。",
    weakness:
      "分かってもらえない感覚を抱えやすいところがあります。説明できない気配にも価値があります。",
    love:
      "深く理解しようとしてくれる相手に心を開きます。静かな信頼が恋を育てます。",
    work:
      "表現、創作、研究、個人の感性を活かす仕事に向きます。",
    relationship:
      "無理に輪の中心にいなくても大丈夫。静かにつながれる関係が合います。",
    todayMessage:
      "今日は言葉にならない感覚を信じて\n静かな違和感が道しるべになります",
    compatibilityHint:
      "風音属性に動きをもらい、水鏡属性に深く映してもらえます。",
    gentleMessage:
      "うまく説明できないあなたの感覚にも\nちゃんと名前のない価値があります",
  },
] as const satisfies readonly ShironeType[];

export const shironeSpecialTypes = [
  {
    slug: "sumine",
    typeName: "澄音属性",
    reading: "すみね",
    displayNumber: 8,
    kind: "special",
    specialNote: specialAttributeNote,
    catchphrase: "言葉になる前の気配を受け取る人",
    motif: "澄んだ音、透明な水、朝の光",
    colorsText: "透明感のある白、淡い水色、銀",
    icon: "澄",
    summary:
      "直観力が鋭く、言葉になる前の気配を受け取る人。理由より先に、場の変化や心の揺れを感じ取ることがあります。",
    strengths: "直観、清らかな感受性、静かな判断力。",
    weakness:
      "感じ取る量が多く、ひとりで抱え込みやすいところがあります。静かな時間を持つほど、感覚が整います。",
    love:
      "言葉の多さより、空気のやさしさを大切にします。安心できる沈黙がある関係で心が開きます。",
    work:
      "相談、表現、ケア、感性を扱う仕事に向きます。見えない違和感を整える場面で力が出ます。",
    relationship:
      "相手の気配を読みすぎず、自分の感覚も同じくらい大切にすると安定します。",
    todayMessage:
      "今日は言葉にする前の感覚を大切に\n小さな違和感が道を整えてくれます",
    compatibilityHint:
      "白音属性と静けさを深め、水鏡属性と感覚を映し合えます。",
    gentleMessage:
      "あなたが受け取る小さな気配は\n誰かをそっと守る力になります",
  },
  {
    slug: "futane",
    typeName: "双音属性",
    reading: "ふたね",
    displayNumber: 9,
    kind: "special",
    specialNote: specialAttributeNote,
    catchphrase: "違う音を重ねて形にする人",
    motif: "二つの音、結び目、重なる輪",
    colorsText: "淡い金、薄紫、やわらかな灰",
    icon: "双",
    summary:
      "二つの音を重ね、違うもの同士を調和させ、現実にひとつの形をつくる人。対立して見えるものの間に、橋をかける力があります。",
    strengths: "調和、編集力、形にする力。",
    weakness:
      "両方を大切にしようとして、自分の本音が後回しになることがあります。選ぶことも調和の一部です。",
    love:
      "違いを楽しめる関係で魅力が出ます。似ていることより、歩み寄れることを大切にします。",
    work:
      "調整、企画、制作、複数の人や要素をまとめる仕事に向きます。",
    relationship:
      "間に立つことが多い人です。自分だけが背負わない形を作ると、関係が長く育ちます。",
    todayMessage:
      "今日は二つの選択を敵にしなくて大丈夫\n重ね方を変えると新しい形が見えてきます",
    compatibilityHint:
      "花守属性と育てる力を重ね、火織属性と形にする力を強めます。",
    gentleMessage:
      "違うものをつなげられるあなたは\n世界にやさしい形を増やせます",
  },
  {
    slug: "amane",
    typeName: "天音属性",
    reading: "あまね",
    displayNumber: 10,
    kind: "special",
    specialNote: specialAttributeNote,
    catchphrase: "届いた音を人の心へ響かせる人",
    motif: "天の音、鈴、ひらく空",
    colorsText: "真珠、淡い金、空の青",
    icon: "天",
    summary:
      "天から届く音を受け取り、人の心にやさしく響かせる人。自分では当たり前に感じる言葉が、誰かの救いになることがあります。",
    strengths: "受信力、やさしい表現、心に届ける力。",
    weakness:
      "理想が高く、現実の重さに疲れることがあります。小さく届けるだけでも十分に意味があります。",
    love:
      "心の奥に届くような、やさしいつながりを求めます。尊敬と安心が重なる関係で整います。",
    work:
      "表現、発信、教育、癒やし、人の心に言葉を届ける仕事に向きます。",
    relationship:
      "人のために響こうとしすぎず、自分の音も守ることが大切です。",
    todayMessage:
      "今日は無理に大きな声を出さなくて大丈夫\n必要な言葉は静かに届いていきます",
    compatibilityHint:
      "星詠属性と言葉を広げ、月灯属性とやさしい安心を育てます。",
    gentleMessage:
      "あなたの中に届く音は\n誰かの心をやわらかく照らします",
  },
] as const satisfies readonly ShironeType[];

export const shironeTypes = [
  ...shironeBaseTypes,
  ...shironeSpecialTypes,
] as const satisfies readonly ShironeType[];

export function getShironeTypeByBirthDate(birthDate: string): ShironeType | null {
  const digits = birthDate.replace(/\D/g, "");
  if (digits.length !== 8) return null;

  const year = Number(digits.slice(0, 4));
  const month = Number(digits.slice(4, 6));
  const day = Number(digits.slice(6, 8));
  const date = new Date(year, month - 1, day);

  if (
    Number.isNaN(date.getTime()) ||
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }

  const sum = digits
    .split("")
    .reduce((total, char) => total + Number(char), 0);

  if (sum === 11) return shironeSpecialTypes[0] ?? null;
  if (sum === 22) return shironeSpecialTypes[1] ?? null;
  if (sum === 33) return shironeSpecialTypes[2] ?? null;

  const index = sum % shironeBaseTypes.length;
  const baseType = shironeBaseTypes[index];
  if (!baseType) return null;

  const phase = sum % 2 === 1 ? shironePhases[0] : shironePhases[1];
  return {
    ...baseType,
    phase,
  };
}
