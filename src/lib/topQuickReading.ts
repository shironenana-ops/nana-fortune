import {
  getShironePhaseDetail,
  getShironeTypeByBirthDate
} from "./shironeTypes";

export type TopQuickReadingInput = {
  birthday: string;
};

export type TopQuickReadingResult = {
  typeId: string;
  typeName: string;
  phaseName: string;
  icon: string;
  identitySummary: string[];
  strengths: string;
  guidance: string;
  cautions: string;
};

export class TopQuickReadingValidationError extends Error {
  readonly field = "birthday" as const;

  constructor(message: string) {
    super(message);
    this.name = "TopQuickReadingValidationError";
  }
}

const MIN_BIRTHDAY = "1900-01-01";

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function validateBirthday(value: string, today: Date): string {
  const birthday = String(value ?? "").trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthday);

  if (!match) {
    throw new TopQuickReadingValidationError("生年月日を正しく入力してください。");
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(year, month - 1, day);

  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day
  ) {
    throw new TopQuickReadingValidationError("実在する生年月日を入力してください。");
  }

  if (birthday < MIN_BIRTHDAY) {
    throw new TopQuickReadingValidationError("生年月日は1900年1月1日以降で入力してください。");
  }

  if (birthday > formatLocalDate(today)) {
    throw new TopQuickReadingValidationError("未来の日付は入力できません。");
  }

  return birthday;
}

export function buildTopQuickReading(
  input: TopQuickReadingInput,
  today = new Date()
): TopQuickReadingResult {
  if (Number.isNaN(today.getTime())) {
    throw new Error("基準日が正しくありません。");
  }

  const birthday = validateBirthday(input.birthday, today);
  const shironeType = getShironeTypeByBirthDate(birthday);

  if (!shironeType) {
    throw new TopQuickReadingValidationError("生年月日を正しく入力してください。");
  }

  const phaseDetail = shironeType.phase
    ? getShironePhaseDetail(shironeType, shironeType.phase.key)
    : shironeType.specialNote ?? "";

  return {
    typeId: shironeType.slug,
    typeName: shironeType.typeName,
    phaseName: shironeType.phase?.label ?? "",
    icon: shironeType.icon,
    identitySummary: [
      shironeType.summary,
      phaseDetail,
      shironeType.relationship
    ].filter(Boolean),
    strengths: shironeType.strengths,
    guidance: shironeType.gentleMessage,
    cautions: shironeType.weakness
  };
}
