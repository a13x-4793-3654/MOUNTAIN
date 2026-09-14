import { useEffect, useRef, useState } from "react";
import { Button, Checkbox, Spinner } from "@fluentui/react-components";
import { ArrowClockwise20Regular, ChevronLeft20Regular, ChevronRight20Regular, Settings20Regular } from "@fluentui/react-icons";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import luxonPlugin from "@fullcalendar/luxon3";
import jaLocale from "@fullcalendar/core/locales/ja";
import type { DatesSetArg, EventInput } from "@fullcalendar/core";
import { DateTime } from "luxon";
import {
  CalendarAvailability, CalendarEvent, CalendarEvents, CalendarFeed, CalendarPreferences, CalendarView,
  getCalendarAvailability, getCalendarEvents, getCalendarFeeds, getCalendarPreferences,
  saveCalendarPreferences, updateCalendarFeed,
} from "../api/calendar";
import MiniCalendar from "../components/calendar/MiniCalendar";
import EventDetails, { DisplayCalendarEvent } from "../components/calendar/EventDetails";
import FeedSettings from "../components/calendar/FeedSettings";
import { scheduleCalendarFeedRequest } from "../components/calendar/calendarRequestQueue";
import {
  CALENDAR_ZONE, calendarError, colorText, eventPeriod, formatCalendarTime, GROUP_COLOR, jstNow, PERSONAL_COLOR, validColor,
} from "../components/calendar/calendarUtils";
import "../components/calendar/calendar.css";

const viewNames = { day: "timeGridDay", week: "timeGridWeek", month: "dayGridMonth" };
const defaultPreferences: CalendarPreferences = { show_personal: true, show_group: true, show_tentative: false, view: "month" };
const defaultAvailability: CalendarAvailability = {
  personal: { enabled: true, reason: null },
  group: { enabled: true, name: "Microsoft 365 グループ", reason: null },
};
interface Source { id: string; name: string; color: string }
interface SourceResult {
  source: Source;
  loading: boolean;
  events: CalendarEvent[];
  warnings: string[];
  successful: boolean;
  cache?: CalendarEvents["cache"];
  retained?: boolean;
  error?: string;
  failedRefresh?: boolean;
}
interface CalendarSnapshot { key: string; rangeKey: string; results: SourceResult[] }

function pendingResults(sources: Source[], rangeKey: string, previous: CalendarSnapshot): SourceResult[] {
  return sources.map((source) => {
    const saved = source.id.startsWith("feed:") && previous.rangeKey === rangeKey
      ? previous.results.find((result) => result.source.id === source.id && result.successful) : undefined;
    return {
      source, loading: true, successful: !!saved, events: saved?.events ?? [], warnings: saved?.warnings ?? [],
      cache: saved?.cache, retained: !!saved,
    };
  });
}

const savedTime = (result: SourceResult) =>
  result.cache ? `${formatCalendarTime(result.cache.saved_at)}（日本時間）` : "不明";

function labelEvent(element: HTMLElement, event: CalendarEvent, sourceName: string, title: string) {
  element.setAttribute("aria-label", `${title}、${sourceName}、${eventPeriod(event)}`);
  element.setAttribute("role", "button");
  element.title = `${title}（${sourceName}）`;
}

export default function Calendar() {
  const calendar = useRef<FullCalendar>(null);
  const eventElements = useRef(new Map<HTMLElement, string>());
  const [preferences, setPreferences] = useState(defaultPreferences);
  const [availability, setAvailability] = useState(defaultAvailability);
  const [feeds, setFeeds] = useState<CalendarFeed[]>([]);
  const [ready, setReady] = useState(false);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [feedsReady, setFeedsReady] = useState(false);
  const [setupErrors, setSetupErrors] = useState<string[]>([]);
  const [setupAttempt, setSetupAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [feedStatusError, setFeedStatusError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selected, setSelected] = useState<DisplayCalendarEvent | null>(null);
  const [date, setDate] = useState(() => jstNow().toISODate()!);
  const [title, setTitle] = useState("");
  const [range, setRange] = useState<{ start: string; end: string } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [snapshot, setSnapshot] = useState<CalendarSnapshot>({ key: "", rangeKey: "", results: [] });
  const explicitRefresh = useRef<string | null>(null);
  const feedRevision = useRef(0);
  const mounted = useRef(false);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let current = true;
    setReady(false); setSetupErrors([]);
    void Promise.allSettled([getCalendarAvailability(), getCalendarPreferences(), getCalendarFeeds()]).then((results) => {
      if (!current) return;
      const [availabilityResult, preferencesResult, feedsResult] = results;
      const errors: string[] = [];
      if (availabilityResult.status === "fulfilled") setAvailability(availabilityResult.value);
      else errors.push(`利用状況: ${calendarError(availabilityResult.reason)}`);
      setPreferencesReady(preferencesResult.status === "fulfilled");
      if (preferencesResult.status === "fulfilled") setPreferences({ ...defaultPreferences, ...preferencesResult.value });
      else errors.push(`表示設定: ${calendarError(preferencesResult.reason)}`);
      setFeedsReady(feedsResult.status === "fulfilled");
      if (feedsResult.status === "fulfilled") setFeeds(feedsResult.value.items);
      else errors.push(`ICS一覧: ${calendarError(feedsResult.reason)}`);
      setSetupErrors(errors); setReady(true);
    });
    return () => { current = false; };
  }, [setupAttempt]);

  const sources: Source[] = [];
  if (preferences.show_personal && availability.personal.enabled) sources.push({ id: "personal", name: "自分のOutlook", color: PERSONAL_COLOR });
  if (preferences.show_group && availability.group.enabled) sources.push({ id: "group", name: availability.group.name || "Microsoft 365 グループ", color: GROUP_COLOR });
  feeds.filter((feed) => feed.visible).forEach((feed) => sources.push({ id: `feed:${feed.id}`, name: feed.name, color: validColor(feed.color) }));
  const sourceKey = JSON.stringify(sources);
  const rangeKey = JSON.stringify(range);
  const contextKey = JSON.stringify([rangeKey, sourceKey]);
  const requestKey = JSON.stringify([contextKey, refresh]);
  const reloadSources = (refreshFeeds = false) => {
    explicitRefresh.current = refreshFeeds ? contextKey : null;
    setRefresh((value) => value + 1);
  };

  useEffect(() => {
    if (!ready || !range) return;
    let current = true;
    const activeSources: Source[] = JSON.parse(sourceKey);
    const key = requestKey;
    // Consume the Update intent once; later range/source changes must use saved ICS data.
    const refreshFeeds = explicitRefresh.current === contextKey;
    explicitRefresh.current = null;
    setSnapshot((previous) => ({ key, rangeKey, results: pendingResults(activeSources, rangeKey, previous) }));
    setFeedStatusError("");
    const loadSource = async (source: Source) => {
      if (!current) return;
      try {
        const response = await getCalendarEvents(source.id, range.start, range.end, refreshFeeds);
        const result: SourceResult = {
          source, loading: false, successful: true, events: response.events, warnings: response.warnings,
          cache: response.cache, error: response.cache?.refresh_error || undefined,
          failedRefresh: !!response.cache?.refresh_error, retained: !!response.cache?.refresh_error,
        };
        if (current) setSnapshot((previous) => previous.key === key
          ? { ...previous, results: previous.results.map((item) => item.source.id === source.id ? result : item) } : previous);
      } catch (error) {
        if (current) setSnapshot((previous) => previous.key === key ? {
          ...previous,
          results: previous.results.map((item) => item.source.id === source.id
            ? { ...item, loading: false, error: calendarError(error), failedRefresh: refreshFeeds, retained: item.successful }
            : item),
        } : previous);
      }
    };
    const requests = activeSources.map((source) => source.id.startsWith("feed:")
      ? scheduleCalendarFeedRequest(() => loadSource(source))
      : loadSource(source));
    const revision = feedRevision.current;
    void Promise.all(requests).then(async () => {
      if (!current || !activeSources.some((source) => source.id.startsWith("feed:"))) return;
      try {
        const response = await getCalendarFeeds();
        if (current && feedRevision.current === revision) setFeeds(response.items);
      } catch (error) {
        if (current) setFeedStatusError(`ICS取得状況: ${calendarError(error)}`);
      }
    });
    return () => { current = false; };
  }, [ready, range?.start, range?.end, rangeKey, sourceKey, contextKey, requestKey]);

  const results = snapshot.key === requestKey ? snapshot.results : pendingResults(sources, rangeKey, snapshot);
  const loading = !!sources.length && (!range || snapshot.key !== requestKey || results.some((result) => result.loading));
  const hiddenTentative = preferences.show_tentative ? 0
    : results.reduce((total, result) => total + result.events.filter((event) => event.tentative === true).length, 0);
  const events: EventInput[] = results.flatMap((result) => result.events
    .filter((event) => preferences.show_tentative || event.tentative !== true).map((event) => ({
    id: `${result.source.id}:${event.id}`, title: event.title || "（件名なし）",
    start: event.start, end: event.end, allDay: event.all_day,
    backgroundColor: result.source.color, borderColor: result.source.color, textColor: colorText(result.source.color),
    extendedProps: { detail: { event, sourceName: result.source.name } satisfies DisplayCalendarEvent },
  })));
  useEffect(() => {
    // Retained events reuse DOM nodes, so refresh labels when their data changes.
    for (const [element, id] of eventElements.current) {
      const event = calendar.current?.getApi().getEventById(id);
      if (event) {
        const detail = event.extendedProps.detail as DisplayCalendarEvent;
        labelEvent(element, detail.event, detail.sourceName, event.title);
      }
    }
  }, [events]);
  const datesChanged = (value: DatesSetArg) => {
    setTitle(value.view.title);
    setRange((previous) => previous?.start === value.startStr && previous.end === value.endStr
      ? previous : { start: value.startStr, end: value.endStr });
    const focused = calendar.current?.getApi().getDate();
    if (focused) setDate(DateTime.fromJSDate(focused, { zone: CALENDAR_ZONE }).toISODate()!);
    setSelected(null);
  };
  const savePreferences = async (value: CalendarPreferences) => {
    if (saving || !preferencesReady) return;
    setSaving(true); setSaveError("");
    try {
      const response = await saveCalendarPreferences(value);
      if (!mounted.current) return;
      setPreferences({ ...defaultPreferences, ...response });
      if (response.view !== preferences.view) calendar.current?.getApi().changeView(viewNames[response.view]);
    } catch (error) {
      if (mounted.current) setSaveError(`表示設定を保存できませんでした: ${calendarError(error)}`);
    } finally {
      if (mounted.current) setSaving(false);
    }
  };
  const feedSaved = (feed: CalendarFeed) => {
    feedRevision.current += 1;
    setFeeds((previous) => previous.some((item) => item.id === feed.id)
      ? previous.map((item) => item.id === feed.id ? feed : item) : [...previous, feed]);
  };
  const toggleFeed = async (feed: CalendarFeed, visible: boolean) => {
    if (saving) return;
    setSaving(true); setSaveError("");
    try {
      const saved = await updateCalendarFeed(feed.id, { visible });
      if (mounted.current) feedSaved(saved);
    } catch (error) {
      if (mounted.current) setSaveError(`「${feed.name}」の表示設定を保存できませんでした: ${calendarError(error)}`);
    } finally {
      if (mounted.current) setSaving(false);
    }
  };
  return (
    <div className="mountain-calendar">
      <header className="calendar-page-heading">
        <h1>カレンダー</h1>
        <span>日本時間（Asia/Tokyo）・読み取り専用</span>
      </header>
      {!ready ? <Spinner label="カレンダー設定を読み込み中" /> : <>
        {setupErrors.length > 0 && <div role="alert" className="calendar-error">
          {setupErrors.map((error) => <p key={error}>{error}</p>)}
          <Button onClick={() => setSetupAttempt((value) => value + 1)}>設定を再取得</Button>
        </div>}
        {saveError && <p role="alert" className="calendar-error">{saveError}</p>}
        <div className="calendar-workspace">
          <aside className="calendar-sidebar" aria-label="カレンダーの表示設定">
            <MiniCalendar date={date} onSelect={(value) => calendar.current?.getApi().gotoDate(value)} />
            <section aria-label="表示するカレンダー">
              <h2>マイカレンダー</h2>
              <div className="calendar-source">
                <span className="calendar-swatch" style={{ backgroundColor: PERSONAL_COLOR }} />
                <Checkbox label="自分のOutlook" checked={preferences.show_personal} disabled={saving || !preferencesReady || !availability.personal.enabled}
                  onChange={(_, value) => void savePreferences({ ...preferences, show_personal: value.checked === true })} />
              </div>
              {availability.personal.reason && <p className="calendar-source-note">{availability.personal.reason}</p>}
              <div className="calendar-source">
                <span className="calendar-swatch" style={{ backgroundColor: GROUP_COLOR }} />
                <Checkbox label={availability.group.name || "Microsoft 365 グループ"} checked={preferences.show_group} disabled={saving || !preferencesReady || !availability.group.enabled}
                  onChange={(_, value) => void savePreferences({ ...preferences, show_group: value.checked === true })} />
              </div>
              {availability.group.reason && <p className="calendar-source-note">{availability.group.reason}</p>}
              <h2>個人用ICS</h2>
              {feeds.map((feed) => <div key={feed.id} className="calendar-source">
                <span className="calendar-swatch" style={{ backgroundColor: validColor(feed.color) }} />
                <Checkbox label={feed.name} checked={feed.visible} disabled={saving}
                  onChange={(_, value) => void toggleFeed(feed, value.checked === true)} />
              </div>)}
              {!feeds.length && <p className="calendar-source-note">URL購読・ファイルの予定を重ねて表示できます。</p>}
              <Button icon={<Settings20Regular />} disabled={saving || !feedsReady} onClick={() => setSettingsOpen(true)}>ICSカレンダー設定</Button>
              <p className="calendar-source-note">ICSは自分だけに表示されます。通常は保存済みの予定を表示し、URLの再取得は「更新」から行います。Outlookへの登録は行いません。</p>
              <h2>表示オプション</h2>
              <Checkbox label="未確定の予定を表示" checked={preferences.show_tentative} disabled={saving || !preferencesReady}
                onChange={(_, value) => void savePreferences({ ...preferences, show_tentative: value.checked === true })} />
              <p className="calendar-source-note">予定自体が未確定のものだけが対象です。招待への未回答・仮承諾だけでは非表示にしません。</p>
            </section>
          </aside>
          <section className="calendar-main" aria-label="予定表">
            <div className="calendar-toolbar">
              <div className="calendar-actions">
                <Button onClick={() => calendar.current?.getApi().today()}>今日</Button>
                <Button icon={<ChevronLeft20Regular />} aria-label="前の期間" onClick={() => calendar.current?.getApi().prev()} />
                <Button icon={<ChevronRight20Regular />} aria-label="次の期間" onClick={() => calendar.current?.getApi().next()} />
              </div>
              <h2 aria-live="polite">{title}</h2>
              <div className="calendar-actions" role="group" aria-label="カレンダー表示">
                {(["day", "week", "month"] as CalendarView[]).map((view) =>
                  <Button key={view} aria-pressed={preferences.view === view} disabled={saving || !preferencesReady}
                    appearance={preferences.view === view ? "primary" : "secondary"}
                    onClick={() => void savePreferences({ ...preferences, view })}>{({ day: "日", week: "週", month: "月" })[view]}</Button>)}
                <Button icon={<ArrowClockwise20Regular />} aria-label="予定を再取得" title="更新：Outlookの最新予定とICSの元データを再取得"
                  disabled={!range} onClick={() => reloadSources(true)}>更新</Button>
              </div>
            </div>
            <div className="calendar-status" role="status" aria-live="polite">
              {loading ? results.some((result) => result.retained) ? "予定を読み込み中…（表示済みのICS予定は保持しています）" : "予定を読み込み中…"
                : !sources.length ? "表示するカレンダーを選択してください。"
                : !events.length ? results.some((result) => result.error) ? "取得できた予定はありません。ソースのエラーを確認してください。"
                  : hiddenTentative ? `未確定の予定 ${hiddenTentative}件を非表示にしています。` : "この期間の予定はありません。"
                  : `${events.length}件の予定を表示中${hiddenTentative ? `（未確定 ${hiddenTentative}件は非表示）` : ""}`}
            </div>
            {results.some((result) => result.source.id.startsWith("feed:") && result.successful) && <ul className="calendar-cache-state" aria-label="ICSの保存状態" aria-live="polite">
              {results.filter((result) => result.source.id.startsWith("feed:") && result.successful).map((result) =>
                <li key={result.source.id}>
                  <strong>{result.source.name}</strong>：
                  {result.retained || result.cache?.from_cache ? "保存済みの予定を表示" : "取得した予定を表示"} · 保存日時: {savedTime(result)}
                </li>)}
            </ul>}
            {results.filter((result) => result.error).map((result) => <div key={result.source.id} role="alert" className="calendar-error">
              <strong>{result.source.name}</strong>
              <p>{result.failedRefresh ? "更新に失敗しました。" : "予定の取得に失敗しました。"} {result.error}</p>
              {result.successful && <p>保存済みの予定を表示しています。保存日時: {savedTime(result)}</p>}
              <Button size="small" onClick={() => reloadSources()}>
                {result.source.id.startsWith("feed:") ? "保存済み予定を再表示" : "予定を再取得"}
              </Button>
            </div>)}
            {results.filter((result) => result.warnings.length).map((result) =>
              <div key={result.source.id} role="note" aria-label={`${result.source.name}の注意`} className="calendar-warning">
                <strong>注意 · {result.source.name}（予定の表示は継続しています）</strong>
                {result.warnings.map((warning, index) => <p key={index}>{warning}</p>)}
              </div>)}
            {feedStatusError && <p role="alert" className="calendar-error">{feedStatusError}</p>}
            <div className="calendar-grid-container" aria-busy={loading}>
              <FullCalendar ref={calendar} plugins={[dayGridPlugin, timeGridPlugin, luxonPlugin]}
                locale={jaLocale} timeZone={CALENDAR_ZONE} initialView={viewNames[preferences.view]} initialDate={date}
                headerToolbar={false} datesSet={datesChanged} events={events} firstDay={0}
                editable={false} selectable={false} eventStartEditable={false} eventDurationEditable={false}
                eventInteractive eventDisplay="block" nowIndicator allDaySlot allDayText="終日" dayMaxEvents={6}
                height="auto" scrollTime="08:00:00" slotDuration="00:30:00" slotLabelFormat={{ hour: "2-digit", minute: "2-digit", hour12: false }}
                eventTimeFormat={{ hour: "2-digit", minute: "2-digit", hour12: false }} displayEventEnd={preferences.view !== "month"}
                eventClick={(value) => {
                  value.jsEvent.preventDefault();
                  setSelected(value.event.extendedProps.detail as DisplayCalendarEvent);
                }}
                eventDidMount={(value) => {
                  const detail = value.event.extendedProps.detail as DisplayCalendarEvent;
                  eventElements.current.set(value.el, value.event.id);
                  labelEvent(value.el, detail.event, detail.sourceName, value.event.title);
                }}
                eventWillUnmount={(value) => { eventElements.current.delete(value.el); }}
              />
            </div>
          </section>
        </div>
      </>}
      <EventDetails selected={selected} onClose={() => setSelected(null)} />
      {settingsOpen && <FeedSettings feeds={feeds} onClose={() => setSettingsOpen(false)} onSaved={feedSaved}
        onDeleted={(id) => { feedRevision.current += 1; setFeeds((previous) => previous.filter((feed) => feed.id !== id)); }} />}
    </div>
  );
}
