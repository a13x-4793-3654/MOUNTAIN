export function calendarDateTimeToJst(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match.map(Number);
  if (year < 1 || month < 1 || month > 12 || hour > 23 || minute > 59) return null;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > daysInMonth[month - 1]) return null;
  // datetime-local はブラウザのタイムゾーンで解釈せず、日本時間を明示する。
  return `${value}:00+09:00`;
}

const jstFormatter = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function formatCalendarDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "日時を確認できません" : jstFormatter.format(date);
}
