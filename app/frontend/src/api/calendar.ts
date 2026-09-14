import { getJson, sendJson } from "./client";

export type CalendarView = "day" | "week" | "month";
export interface CalendarPreferences {
  show_personal: boolean;
  show_group: boolean;
  show_tentative: boolean;
  view: CalendarView;
}
export interface CalendarAvailability {
  personal: { enabled: boolean; reason: string | null };
  group: { enabled: boolean; name: string; reason: string | null };
}
export interface CalendarFeed {
  id: string;
  name: string;
  kind: "url" | "file";
  color: string;
  visible: boolean;
  filename: string | null;
  last_fetched_at: string | null;
  last_error: string | null;
}
export interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  all_day: boolean;
  location: string | null;
  description: string | null;
  web_url: string | null;
  source: string;
  tentative?: boolean;
}
export interface CalendarEvents {
  events: CalendarEvent[];
  warnings: string[];
  cache?: {
    saved_at: string;
    from_cache: boolean;
    refresh_error: string | null;
  };
}
export type FeedMetadata = Pick<CalendarFeed, "name" | "color" | "visible">;
export type CreateCalendarFeed = FeedMetadata & (
  { kind: "url"; url: string } | { kind: "file"; content: string; filename: string }
);
const base = "/api/calendar";
export const getCalendarAvailability = () => getJson<CalendarAvailability>(`${base}/availability`);
export const getCalendarPreferences = () => getJson<CalendarPreferences>(`${base}/preferences`);
export const saveCalendarPreferences = (value: CalendarPreferences) =>
  sendJson<CalendarPreferences>("PUT", `${base}/preferences`, value);
export const getCalendarFeeds = () => getJson<{ items: CalendarFeed[] }>(`${base}/feeds`);
export const createCalendarFeed = (value: CreateCalendarFeed) =>
  sendJson<CalendarFeed>("POST", `${base}/feeds`, value);
export const updateCalendarFeed = (id: string, value: Partial<FeedMetadata>) =>
  sendJson<CalendarFeed>("PUT", `${base}/feeds/${encodeURIComponent(id)}`, value);
export const deleteCalendarFeed = (id: string) =>
  sendJson<{ ok: boolean }>("DELETE", `${base}/feeds/${encodeURIComponent(id)}`);
export function getCalendarEvents(source: string, start: string, end: string, refresh = false) {
  const query = new URLSearchParams({ start, end });
  if (source.startsWith("feed:")) {
    if (refresh) query.set("refresh", "true");
    return getJson<CalendarEvents>(`${base}/feeds/${encodeURIComponent(source.slice(5))}/events?${query}`);
  }
  query.set("source", source);
  return getJson<CalendarEvents>(`${base}/events?${query}`);
}
