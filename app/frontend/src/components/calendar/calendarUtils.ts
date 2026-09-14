import { DateTime } from "luxon";
import type { CalendarEvent } from "../../api/calendar";

export const CALENDAR_ZONE = "Asia/Tokyo";
export const PERSONAL_COLOR = "#0f6cbd";
export const GROUP_COLOR = "#8764b8";
export const FEED_COLOR = "#0b6a55";
export const MAX_ICS_BYTES = 1024 * 1024;
export const jstNow = () => DateTime.now().setZone(CALENDAR_ZONE).setLocale("ja");
export const calendarError = (error: unknown) =>
  error instanceof Error ? error.message : "処理に失敗しました。もう一度お試しください。";
export const validColor = (color: string) => /^#[\da-f]{6}$/i.test(color) ? color : FEED_COLOR;
export function colorText(color: string) {
  const hex = validColor(color).slice(1);
  const [r, g, b] = [0, 2, 4].map((i) => {
    const channel = parseInt(hex.slice(i, i + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.179 ? "#000000" : "#ffffff";
}
export function safeCalendarLink(value: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}
export function calendarDescriptionParts(text: string): { text: string; href?: string }[] {
  const parts: { text: string; href?: string }[] = [];
  let cursor = 0;
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'「」『』（）]+/gi)) {
    let candidate = match[0].replace(/[.,;:!?。、，．]+$/, "");
    for (const [open, close] of [["(", ")"], ["[", "]"]]) {
      while (candidate.endsWith(close) && candidate.split(close).length > candidate.split(open).length) {
        candidate = candidate.slice(0, -1);
      }
    }
    const href = safeCalendarLink(candidate);
    if (!href) continue;
    const index = match.index!;
    parts.push({ text: text.slice(cursor, index) }, { text: candidate, href });
    cursor = index + candidate.length;
  }
  parts.push({ text: text.slice(cursor) });
  return parts;
}
export function formatCalendarTime(value: string) {
  const date = DateTime.fromISO(value, { zone: CALENDAR_ZONE }).setLocale("ja");
  return date.isValid ? date.toFormat("yyyy年M月d日（ccc） HH:mm") : value;
}
export function eventPeriod(event: CalendarEvent) {
  if (!event.all_day) return `${formatCalendarTime(event.start)} ～ ${formatCalendarTime(event.end)}（日本時間）`;
  const start = DateTime.fromISO(event.start, { zone: CALENDAR_ZONE }).setLocale("ja");
  // Calendar all-day end dates are exclusive; only the detail label is inclusive.
  const last = DateTime.fromISO(event.end, { zone: CALENDAR_ZONE }).minus({ days: 1 }).setLocale("ja");
  const firstLabel = start.toFormat("yyyy年M月d日（ccc）");
  return `${firstLabel}${start.hasSame(last, "day") ? "" : ` ～ ${last.toFormat("yyyy年M月d日（ccc）")}`}（終日）`;
}
export async function readIcsFile(file: File) {
  if (!/\.ics$/i.test(file.name)) throw new Error(".ics ファイルを選択してください。");
  if (file.size > MAX_ICS_BYTES) throw new Error("ファイルは1 MiB以下にしてください。");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
  } catch {
    throw new Error("UTF-8形式のファイルを選択してください。読み取りできませんでした。");
  }
}
