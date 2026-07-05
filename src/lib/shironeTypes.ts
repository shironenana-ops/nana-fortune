export type ShironeType = {
  slug: string;
  typeName: string;
  reading: string;
  displayNumber: number;
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

export const shironeTypes = [
  {
    slug: "moonlight",
    typeName: "月灯属性",
    reading: "つきあかり",
    displayNumber: 1,
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
      "火結属性に背中を押され、風渡属性に視野を広げられます。",
    gentleMessage:
      "あなたの静けさは\n誰かにとって帰る場所になります",
  },
  {
    slug: "stargazer",
    typeName: "星詠属性",
    reading: "ほしよみ",
    displayNumber: 2,
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
      "水鏡属性と内面を深め、風渡属性と可能性を広げます。",
    gentleMessage:
      "あなたが見つける意味は\n誰かの夜道の星になります",
  },
  {
    slug: "water-mirror",
    typeName: "水鏡属性",
    reading: "みずかがみ",
    displayNumber: 3,
    catchphrase: "心の揺れを映して整える人",
    motif: "水面、鏡、雫",
    colorsText: "青緑、水色、透明感のある白",
    icon: "水",
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
      "月灯属性と安心を育て、火結属性から行動力をもらえます。",
    gentleMessage:
      "あなたが大切にしたものは\nゆっくり花を開いていきます",
  },
  {
    slug: "windpath",
    typeName: "風渡属性",
    reading: "かぜわたり",
    displayNumber: 5,
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
    typeName: "火結属性",
    reading: "ひむすび",
    displayNumber: 6,
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
      "風渡属性に動きをもらい、水鏡属性に深く映してもらえます。",
    gentleMessage:
      "うまく説明できないあなたの感覚にも\nちゃんと名前のない価値があります",
  },
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
  const index = sum % shironeTypes.length;
  return shironeTypes[index] ?? null;
}
