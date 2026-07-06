const DATE_TIME_REST = "(?:[T ]\\d{2}:\\d{2}(?::\\d{2})?(?:\\.\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})?)?";
const RE_ISO_DATE = new RegExp(`^(\\d{4})-(\\d{2})-(\\d{2})(${DATE_TIME_REST})$`);
const RE_SLASH_DATE = new RegExp(`^(\\d{1,2})\\/(\\d{1,2})\\/(\\d{4})(${DATE_TIME_REST})$`);

function validParts(year: number, month: number, day: number) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function normalizeDateLike(value: string): string | null {
  const s = value.trim();
  const iso = s.match(RE_ISO_DATE);
  if (iso) {
    const year = Number(iso[1]), month = Number(iso[2]), day = Number(iso[3]);
    return validParts(year, month, day) ? `${iso[1]}-${iso[2]}-${iso[3]}${iso[4] ?? ""}` : null;
  }

  const slash = s.match(RE_SLASH_DATE);
  if (!slash) return null;

  const first = Number(slash[1]), second = Number(slash[2]), year = Number(slash[3]);
  let day = first, month = second;
  if (first <= 12 && second > 12) {
    month = first;
    day = second;
  }
  if (!validParts(year, month, day)) return null;

  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}${slash[4] ?? ""}`;
}

export function isDateLike(value: string) {
  return normalizeDateLike(value) != null;
}

export function hasDateTimePart(value: string) {
  const normalized = normalizeDateLike(value);
  return normalized != null && /[T ]\d{2}:\d{2}(:\d{2})?/.test(normalized);
}
