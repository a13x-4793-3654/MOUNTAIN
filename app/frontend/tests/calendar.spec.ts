import { expect, test, type Page } from "@playwright/test";
import type { CalendarEvent, CalendarFeed, CalendarPreferences, CreateCalendarFeed } from "../src/api/calendar";

test.use({ timezoneId: "America/Los_Angeles", viewport: { width: 1500, height: 1050 } });
const origin = "http://127.0.0.1:4179";
const unexpectedByPage = new WeakMap<Page, string[]>();
test.afterEach(async ({ page }) => { expect(unexpectedByPage.get(page) ?? []).toEqual([]); });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const event = (source: string, title: string, overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: "same-id", source, title, start: "2026-09-15T00:00:00Z", end: "2026-09-15T01:00:00Z",
  all_day: false, location: "会議室A", description: "<img src=x onerror=alert(1)> 安全な説明",
  web_url: "https://example.invalid/event", ...overrides,
});
const ics = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:local-fixture\r\nDTSTART:20260915T030000Z\r\nDTEND:20260915T040000Z\r\nSUMMARY:保存ファイルの予定\r\nEND:VEVENT\r\nEND:VCALENDAR";

async function setup(page: Page, options: {
  gated?: boolean; personalError?: boolean; noPermissions?: boolean; feedCount?: number; slowFeeds?: boolean;
  longMonthEvent?: boolean;
} = {}) {
  await page.clock.setFixedTime(new Date("2026-09-15T00:00:00Z"));
  const profiles = new Map<string, { preferences: CalendarPreferences; feeds: CalendarFeed[] }>();
  const profile = (user: string) => {
    if (!profiles.has(user)) profiles.set(user, { preferences: { show_personal: true, show_group: true, view: "month" }, feeds: [] });
    return profiles.get(user)!;
  };
  const state = {
    user: "local-user", profile, sequence: 0,
    writes: [] as { path: string; method: string; body: any }[],
    reads: [] as { source: string; start: string; end: string }[],
    unexpected: [] as string[],
    failures: new Map<string, string>(options.personalError ? [["personal", "個人の予定表へのアクセス許可がありません。"]] : []),
    warnings: new Map<string, string[]>(),
    saveFailures: 0, saveGate: null as Promise<void> | null,
    oldRange: "", gate: options.gated ? deferred() : null,
    groupEnabled: true,
    personalTitle: options.longMonthEvent ? "Teams - 長い予定タイトルでも開始時刻を折り返さずに表示する" : "自分の予定",
    description: null as string | null,
    feedGate: options.slowFeeds ? deferred() : null,
    activeFeeds: 0,
    maxActiveFeeds: 0,
  };
  profile(state.user).feeds = Array.from({ length: options.feedCount ?? 0 }, (_, index) => ({
    id: `feed-${++state.sequence}`, name: `保存済みICS ${index + 1}`, kind: "url", color: "#0b6a55",
    visible: true, filename: null, last_fetched_at: null, last_error: null,
  }));
  unexpectedByPage.set(page, state.unexpected);
  page.on("pageerror", (error) => state.unexpected.push(error.message));
  await page.route("**/*", async (route) => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    state.unexpected.push(route.request().url());
    return route.abort();
  });
  await page.route(`${origin}/api/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (path === "/api/config") return json({
      auth_enabled: false, entra: { tenant_id: "", client_id: "", api_scope: "" },
      sip: { wss_url: "", realm: "", stun: "", prefixes: "" }, cti_provider: "simulator",
    });
    if (path === "/api/auth/me") return json({
      id: state.user, display_name: "ローカルテスト", user_principal_name: "local@example.invalid",
      status: 1, is_admin: false, permissions: options.noPermissions ? [] : ["screen.home"],
      mail: null, cti_ext_num: null, cti_password: null,
    });
    if (path === "/api/auth/login") return json({ ok: true });
    if (path === "/api/cti/active") return json({ active: null });
    if (path === "/api/dashboard") return json({ detail: "ローカルのホーム画面" }, 503);
    const current = profile(state.user);
    if (path === "/api/calendar/availability") return json({
      personal: { enabled: true, reason: null },
      group: { enabled: state.groupEnabled, name: "共有グループ", reason: state.groupEnabled ? null : "グループは未設定です。" },
    });
    if (method !== "GET") {
      state.writes.push({ path, method, body: request.postData() ? request.postDataJSON() : null });
      if (state.saveFailures-- > 0) return json({ detail: "この設定は保存できません。入力内容を確認してください。" }, 422);
      if (state.saveGate) await state.saveGate;
    }
    if (path === "/api/calendar/preferences") {
      if (method === "PUT") current.preferences = request.postDataJSON();
      return json(current.preferences);
    }
    if (path === "/api/calendar/feeds") {
      if (method === "GET") return json({ items: current.feeds });
      if (method === "POST") {
        const body: CreateCalendarFeed = request.postDataJSON();
        const feed: CalendarFeed = {
          id: `feed-${++state.sequence}`, name: body.name, kind: body.kind, color: body.color, visible: body.visible,
          filename: body.kind === "file" ? body.filename : null, last_fetched_at: null, last_error: null,
        };
        current.feeds.push(feed);
        return json(feed);
      }
    }
    const feedMatch = path.match(/^\/api\/calendar\/feeds\/([^/]+)(\/events)?$/);
    const feed = feedMatch ? current.feeds.find((item) => item.id === feedMatch[1]) : undefined;
    if (feedMatch && !feedMatch[2] && feed) {
      if (method === "PUT") Object.assign(feed, request.postDataJSON());
      if (method === "DELETE") { current.feeds = current.feeds.filter((item) => item.id !== feed.id); return json({ ok: true }); }
      return json(feed);
    }
    if (path === "/api/calendar/events" || (feedMatch?.[2] && feed)) {
      const source = feed ? `feed:${feed.id}` : url.searchParams.get("source")!;
      const start = url.searchParams.get("start")!;
      const end = url.searchParams.get("end")!;
      state.reads.push({ source, start, end });
      if (feed) {
        state.activeFeeds += 1;
        state.maxActiveFeeds = Math.max(state.maxActiveFeeds, state.activeFeeds);
        if (state.feedGate) await state.feedGate.promise;
        state.activeFeeds -= 1;
      }
      const old = options.gated && (!state.oldRange || state.oldRange === start);
      if (old) { state.oldRange = start; await state.gate!.promise; }
      if (state.failures.has(source)) return json({ detail: state.failures.get(source) }, 403);
      let events = source === "personal" ? [
        event(source, state.personalTitle, options.longMonthEvent ? {
          start: "2026-09-05T18:30:00Z", end: "2026-09-05T19:00:00Z",
        } : {}),
        event(source, "複数日の終日予定", { id: "all-day", start: "2026-09-14", end: "2026-09-17", all_day: true, web_url: "javascript:alert(1)" }),
      ] : source === "group" ? [event(source, "共有の予定", { start: "2026-09-15T02:00:00Z", end: "2026-09-15T03:00:00Z" })]
        : [event(source, feed!.kind === "url" ? "URL購読の予定" : "保存ファイルの予定")];
      if (options.gated) events = [event(source, old ? "古い範囲の応答" : "新しい範囲の応答", { start: "2026-10-01T00:00:00Z", end: "2026-10-01T01:00:00Z" })];
      if (state.description !== null) events = events.map((item) => ({ ...item, description: state.description }));
      if (feed) { feed.last_fetched_at = "2026-09-15T00:00:00Z"; feed.last_error = null; }
      events = events.filter((item) => {
        const eventStart = Date.parse(item.all_day ? `${item.start}T00:00:00+09:00` : item.start);
        const eventEnd = Date.parse(item.all_day ? `${item.end}T00:00:00+09:00` : item.end);
        return eventStart < Date.parse(end) && eventEnd > Date.parse(start);
      });
      return json({ events, warnings: state.warnings.get(source) ?? [] });
    }
    state.unexpected.push(`${method} ${path}`);
    return json({ detail: "Unexpected fixture request" }, 404);
  });
  await page.goto("/calendar");
  await expect(page.getByRole("heading", { name: "カレンダー", exact: true })).toBeVisible();
  return state;
}
const eventButton = (page: Page, name: string) => page.getByRole("button", { name: new RegExp(`^${name}、`) });
const settings = async (page: Page) => {
  await page.getByRole("button", { name: "ICSカレンダー設定", exact: true }).click();
  return page.getByRole("dialog", { name: "個人用ICSカレンダー設定" });
};
const settle = (page: Page) => expect(page.locator(".calendar-grid-container")).toHaveAttribute("aria-busy", "false");
const assertReadOnly = (writes: { path: string; method: string }[]) => {
  expect(writes.every((write) => write.path === "/api/calendar/preferences" || /^\/api\/calendar\/feeds(?:\/[^/]+)?$/.test(write.path))).toBeTruthy();
};

test("month event keeps 03:30 on one line while only its long title wraps", async ({ page }, testInfo) => {
  await setup(page, { longMonthEvent: true });
  await settle(page);
  const appointment = page.locator('.fc-daygrid-day[data-date="2026-09-06"] .fc-daygrid-event');
  for (const width of [1920, 1400, 390]) {
    await page.setViewportSize({ width, height: 1050 });
    await expect(appointment).toBeVisible();
    await expect(appointment.locator(".fc-event-time")).toHaveText("03:30");
    await expect(async () => {
      const layout = await appointment.evaluate((element) => {
        const time = element.querySelector(".fc-event-time")!;
        const title = element.querySelector(".fc-event-title")!;
        const timeRange = document.createRange();
        timeRange.selectNodeContents(time);
        const titleRange = document.createRange();
        titleRange.selectNodeContents(title);
        return {
          timeLines: new Set(Array.from(timeRange.getClientRects(), (rect) => Math.round(rect.top))).size,
          titleLines: new Set(Array.from(titleRange.getClientRects(), (rect) => Math.round(rect.top))).size,
          timeRight: timeRange.getBoundingClientRect().right,
          titleLeft: title.getBoundingClientRect().left,
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
        };
      });
      expect(layout.timeLines).toBe(1);
      expect(layout.titleLines).toBeGreaterThan(1);
      expect(layout.timeRight).toBeLessThanOrEqual(layout.titleLeft + 1);
      expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1);
    }).toPass({ timeout: 5000 });
    await appointment.screenshot({ path: testInfo.outputPath(`long-month-event-${width}.png`) });
  }
});

test("menu, JST month/week/day, keyboard details and all-day exclusive ends", async ({ page }, testInfo) => {
  const state = await setup(page);
  await settle(page);
  await expect(page.getByRole("navigation").getByRole("link").nth(0)).toHaveText("ホーム");
  await expect(page.getByRole("navigation").getByRole("link").nth(1)).toHaveText("カレンダー");
  await expect(page.locator(".fc-dayGridMonth-view")).toBeVisible();
  await expect(page.getByRole("button", { name: "2026年9月15日", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(eventButton(page, "自分の予定")).toHaveCount(1);
  await expect(eventButton(page, "共有の予定")).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath("calendar-month.png") });
  await eventButton(page, "複数日の終日予定").click();
  let dialog = page.getByRole("dialog", { name: "複数日の終日予定" });
  await expect(dialog).toContainText("2026年9月14日（月） ～ 2026年9月16日（水）（終日）");
  await expect(dialog.getByRole("link")).toHaveCount(0);
  await dialog.getByRole("button", { name: "閉じる" }).click();
  await eventButton(page, "自分の予定").focus();
  await page.keyboard.press("Enter");
  dialog = page.getByRole("dialog", { name: "自分の予定" });
  await expect(dialog).toContainText("2026年9月15日（火） 09:00");
  await expect(dialog).toContainText("<img src=x onerror=alert(1)> 安全な説明");
  await expect(dialog.locator("img")).toHaveCount(0);
  await expect(dialog.getByRole("link")).toHaveAttribute("rel", "noopener noreferrer");
  await dialog.getByRole("button", { name: "閉じる" }).click();
  await page.getByRole("button", { name: "週", exact: true }).click();
  await expect(page.locator(".fc-timeGridWeek-view")).toBeVisible();
  await settle(page);
  await expect(page.locator(".fc-timegrid-axis").filter({ hasText: "終日" })).toBeVisible();
  await expect(eventButton(page, "自分の予定")).toContainText("09:00");
  await page.getByRole("button", { name: "日", exact: true }).click();
  await expect(page.locator(".fc-timeGridDay-view")).toBeVisible();
  await settle(page);
  expect(state.reads.every((read) => read.start.endsWith("+09:00") && read.end.endsWith("+09:00"))).toBeTruthy();
  expect(state.reads.every((read) => Date.parse(read.end) - Date.parse(read.start) <= 62 * 86400000)).toBeTruthy();
  await page.getByRole("button", { name: "次の期間", exact: true }).click();
  await settle(page);
  await expect(eventButton(page, "複数日の終日予定")).toBeVisible();
  await page.getByRole("button", { name: "次の期間", exact: true }).click();
  await settle(page);
  await expect(eventButton(page, "複数日の終日予定")).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("この期間の予定はありません");
  assertReadOnly(state.writes);
});

test("all signed-in users can open calendar; toggles and view persist on reopening", async ({ page }) => {
  const state = await setup(page, { noPermissions: true });
  await settle(page);
  await page.getByRole("checkbox", { name: "自分のOutlook" }).click();
  await expect(page.getByRole("checkbox", { name: "自分のOutlook" })).not.toBeChecked();
  await settle(page);
  await expect(eventButton(page, "自分の予定")).toHaveCount(0);
  await expect(eventButton(page, "共有の予定")).toBeVisible();
  await page.getByRole("button", { name: "週", exact: true }).click();
  await expect(page.locator(".fc-timeGridWeek-view")).toBeVisible();
  await page.goto("/contracts");
  await page.getByRole("link", { name: "カレンダー", exact: true }).press("Enter");
  await settle(page);
  await expect(page.getByRole("checkbox", { name: "自分のOutlook" })).not.toBeChecked();
  await expect(page.locator(".fc-timeGridWeek-view")).toBeVisible();
  await page.getByRole("checkbox", { name: "共有グループ" }).click();
  await expect(page.getByRole("status")).toContainText("表示するカレンダーを選択");
  expect(state.profile(state.user).preferences).toEqual({ show_personal: false, show_group: false, view: "week" });
  assertReadOnly(state.writes);
});

test("private saved URL and uploaded snapshot overlays, metadata, reopen refetch and confirmed deletion", async ({ page }) => {
  test.setTimeout(60_000);
  const state = await setup(page);
  await settle(page);
  let dialog = await settings(page);
  await expect(dialog).toContainText("Outlookへの登録・インポートは行いません");
  await dialog.getByRole("textbox", { name: "カレンダー名", exact: true }).fill("個人の購読");
  await dialog.getByRole("textbox", { name: "購読URL", exact: true }).fill("https://example.invalid/private.ics?token=synthetic-token");
  await dialog.getByRole("button", { name: "追加する", exact: true }).click();
  await expect(dialog.getByText("カレンダーを保存しました。")).toBeVisible();
  await dialog.getByRole("textbox", { name: "カレンダー名", exact: true }).fill("個人のファイル");
  await dialog.getByLabel("追加方法", { exact: true }).selectOption("file");
  await dialog.getByLabel("ICSファイル", { exact: true }).setInputFiles({ name: "local.ics", mimeType: "text/calendar", buffer: Buffer.from(ics) });
  await dialog.getByRole("button", { name: "追加する", exact: true }).click();
  await expect(dialog.getByText("ファイル: local.ics", { exact: true })).toBeVisible();
  const creates = state.writes.filter((write) => write.method === "POST");
  expect(creates[0].body.url).toContain("synthetic-token");
  expect(creates[1].body).toMatchObject({ content: ics, filename: "local.ics", kind: "file" });
  await dialog.getByRole("button", { name: "閉じる", exact: true }).click();
  await settle(page);
  await expect(eventButton(page, "URL購読の予定")).toBeVisible();
  await expect(eventButton(page, "保存ファイルの予定")).toBeVisible();
  const before = state.reads.filter((read) => read.source.startsWith("feed:")).length;
  await page.reload();
  await settle(page);
  await expect(eventButton(page, "保存ファイルの予定")).toBeVisible();
  expect(state.reads.filter((read) => read.source.startsWith("feed:")).length).toBeGreaterThan(before);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain("synthetic-token");
  dialog = await settings(page);
  await expect(dialog).toContainText("最終取得: 2026年9月15日（火） 09:00");
  await dialog.getByRole("button", { name: "個人の購読 の表示設定を編集", exact: true }).click();
  await expect(dialog.getByRole("textbox", { name: "購読URL", exact: true })).toHaveCount(0);
  await dialog.getByRole("textbox", { name: "カレンダー名", exact: true }).fill("名称変更");
  await dialog.getByLabel("表示色", { exact: true }).fill("#ffeecc");
  await dialog.getByRole("checkbox", { name: "カレンダーに表示", exact: true }).uncheck();
  await dialog.getByRole("button", { name: "表示設定を保存", exact: true }).click();
  await expect(dialog.getByText("名称変更", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "閉じる", exact: true }).click();
  await settle(page);
  await expect(eventButton(page, "URL購読の予定")).toHaveCount(0);
  await page.getByRole("checkbox", { name: "名称変更", exact: true }).click();
  await expect(eventButton(page, "URL購読の予定")).toBeVisible();
  await expect(eventButton(page, "URL購読の予定").locator(".fc-event-main")).toHaveCSS("color", "rgb(0, 0, 0)");
  state.user = "second-user";
  await page.reload();
  await settle(page);
  await expect(eventButton(page, "保存ファイルの予定")).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: "名称変更", exact: true })).toHaveCount(0);
  state.user = "local-user";
  await page.reload();
  await settle(page);
  dialog = await settings(page);
  await dialog.getByRole("button", { name: "個人のファイル を削除", exact: true }).click();
  await dialog.getByRole("button", { name: "削除をキャンセル", exact: true }).click();
  expect(state.writes.filter((write) => write.method === "DELETE")).toHaveLength(0);
  await dialog.getByRole("button", { name: "個人のファイル を削除", exact: true }).click();
  state.saveFailures = 1;
  await dialog.getByRole("button", { name: "削除する", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("この設定は保存できません");
  await expect(dialog.getByRole("region", { name: "ICSカレンダーの削除確認" })).toBeVisible();
  await dialog.getByRole("button", { name: "削除する", exact: true }).click();
  await expect(dialog.getByText("カレンダーを削除しました。")).toBeVisible();
  await dialog.getByRole("button", { name: "閉じる", exact: true }).click();
  await settle(page);
  await expect(eventButton(page, "保存ファイルの予定")).toHaveCount(0);
  expect(state.profile(state.user).feeds).toHaveLength(1);
  assertReadOnly(state.writes);
});

test("file size and strict UTF-8 validation; server errors preserve form and disable in-flight submits", async ({ page }) => {
  const state = await setup(page);
  const dialog = await settings(page);
  await dialog.getByRole("textbox", { name: "カレンダー名", exact: true }).fill("検証用ファイル");
  await dialog.getByLabel("追加方法", { exact: true }).selectOption("file");
  const fileInput = dialog.getByLabel("ICSファイル", { exact: true });
  await fileInput.setInputFiles({ name: "large.ics", mimeType: "text/calendar", buffer: Buffer.alloc(1024 * 1024 + 1, 65) });
  await dialog.getByRole("button", { name: "追加する", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("1 MiB以下");
  await fileInput.setInputFiles({ name: "invalid.ics", mimeType: "text/calendar", buffer: Buffer.from([0xc3, 0x28]) });
  await dialog.getByRole("button", { name: "追加する", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("UTF-8");
  expect(state.writes).toHaveLength(0);
  await fileInput.setInputFiles({ name: "local.ics", mimeType: "text/calendar", buffer: Buffer.from(ics) });
  state.saveFailures = 1;
  await dialog.getByRole("button", { name: "追加する", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("この設定は保存できません");
  await expect(dialog.getByRole("textbox", { name: "カレンダー名", exact: true })).toHaveValue("検証用ファイル");
  expect(await fileInput.evaluate((element: HTMLInputElement) => element.files?.[0].name)).toBe("local.ics");
  const gate = deferred();
  state.saveGate = gate.promise;
  await dialog.getByRole("button", { name: "追加する", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "保存中…", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "閉じる", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("textbox", { name: "カレンダー名", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  gate.resolve();
  await expect(dialog.getByText("カレンダーを保存しました。")).toBeVisible();
  assertReadOnly(state.writes);
});

test("personal permission failure leaves group/ICS visible; warning and retry are accessible", async ({ page }) => {
  const state = await setup(page, { personalError: true });
  await settle(page);
  await expect(eventButton(page, "共有の予定")).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("自分のOutlook");
  const dialog = await settings(page);
  await dialog.getByRole("textbox", { name: "カレンダー名", exact: true }).fill("失敗と独立したICS");
  await dialog.getByRole("textbox", { name: "購読URL", exact: true }).fill("https://example.invalid/only-test.ics");
  await dialog.getByRole("button", { name: "追加する", exact: true }).click();
  await expect(dialog.getByText("カレンダーを保存しました。")).toBeVisible();
  await dialog.getByRole("button", { name: "閉じる", exact: true }).click();
  await expect(eventButton(page, "URL購読の予定")).toBeVisible();
  state.failures.delete("personal");
  state.warnings.set("group", ["一部の予定に注意が必要です。"]);
  await page.getByRole("button", { name: "予定を再取得", exact: true }).first().click();
  await settle(page);
  await expect(eventButton(page, "自分の予定")).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("一部の予定に注意が必要です");
  state.personalTitle = "更新された自分の予定";
  await page.getByRole("button", { name: "予定を再取得", exact: true }).first().click();
  await expect(eventButton(page, "更新された自分の予定")).toBeVisible();
  await expect(eventButton(page, "自分の予定")).toHaveCount(0);
  assertReadOnly(state.writes);
});

test("late old-range responses cannot overwrite newer events", async ({ page }) => {
  const state = await setup(page, { gated: true });
  await expect.poll(() => state.reads.length).toBeGreaterThanOrEqual(2);
  await page.getByRole("button", { name: "次の期間", exact: true }).click();
  await settle(page);
  await expect(eventButton(page, "新しい範囲の応答")).toHaveCount(2);
  state.gate!.resolve();
  // Wait for both network responses and a render, rather than relying on a fixed sleep.
  await page.waitForLoadState("networkidle");
  await expect(eventButton(page, "古い範囲の応答")).toHaveCount(0);
  await expect(eventButton(page, "新しい範囲の応答")).toHaveCount(2);
  assertReadOnly(state.writes);
});

test("failed preference write leaves previous state and surfaces error; disabled group is explained", async ({ page }) => {
  const state = await setup(page);
  await settle(page);
  state.saveFailures = 1;
  await page.getByRole("checkbox", { name: "自分のOutlook" }).click();
  await expect(page.getByRole("alert")).toContainText("表示設定を保存できませんでした");
  await expect(page.getByRole("checkbox", { name: "自分のOutlook" })).toBeChecked();
  await expect(eventButton(page, "自分の予定")).toBeVisible();
  state.groupEnabled = false;
  await page.reload();
  await settle(page);
  await expect(page.getByRole("checkbox", { name: "共有グループ" })).toBeDisabled();
  await expect(page.getByText("グループは未設定です。")).toBeVisible();
});

test("narrow calendar keeps navigation and settings usable with a scrollable month grid", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await settle(page);
  await expect(page.getByRole("link", { name: "カレンダー", exact: true })).toBeVisible();
  const settingsButton = page.getByRole("button", { name: "ICSカレンダー設定", exact: true });
  await expect(settingsButton).toBeVisible();
  const box = await settingsButton.boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.getByRole("button", { name: "日", exact: true }).click();
  await expect(page.locator(".fc-timeGridDay-view")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("calendar-mobile.png") });
  const dialog = await settings(page);
  await expect(dialog.getByRole("textbox", { name: "カレンダー名", exact: true })).toBeVisible();
});

test("ICS description links preserve history query/fragment while markup and unsafe schemes remain text", async ({ page }) => {
  const state = await setup(page);
  const historyUrl = `${origin}/contracts/local-contract?tab=history#communication-local`;
  const referenceUrl = "http://example.invalid/reference_(calendar)?a=1&b=2";
  state.description = [
    `MOUNTAIN履歴：${historyUrl}。`,
    `参考 (${referenceUrl}).`,
    "javascript:alert(1) data:text/html,<script>alert(1)</script>",
    '<img src=x onerror="alert(1)"> HTMLは表示だけ',
  ].join("\n");
  const settingsDialog = await settings(page);
  await settingsDialog.getByRole("textbox", { name: "カレンダー名", exact: true }).fill("履歴リンクのICS");
  await settingsDialog.getByRole("textbox", { name: "購読URL", exact: true }).fill("https://example.invalid/calendar.ics");
  await settingsDialog.getByRole("button", { name: "追加する", exact: true }).click();
  await expect(settingsDialog.getByText("カレンダーを保存しました。")).toBeVisible();
  await settingsDialog.getByRole("button", { name: "閉じる", exact: true }).click();
  await eventButton(page, "URL購読の予定").click();
  const description = page.getByRole("dialog", { name: "URL購読の予定" }).locator(".calendar-description");
  await expect(description).toHaveText(state.description);
  await expect(description.getByRole("link")).toHaveCount(2);
  await expect(description.getByRole("link", { name: historyUrl, exact: true })).toHaveAttribute("href", historyUrl);
  await expect(description.getByRole("link", { name: referenceUrl, exact: true })).toHaveAttribute("href", referenceUrl);
  for (const link of await description.getByRole("link").all()) {
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  }
  await expect(description.locator("img, script")).toHaveCount(0);
  assertReadOnly(state.writes);
});

test("feed reads stay capped at two across ranges and skip stale queued requests", async ({ page }) => {
  const state = await setup(page, { feedCount: 5, slowFeeds: true });
  await expect.poll(() => state.activeFeeds).toBe(2);
  await expect(eventButton(page, "自分の予定")).toBeVisible();
  await expect(eventButton(page, "共有の予定")).toBeVisible();
  const firstRange = state.reads.find((read) => read.source.startsWith("feed:"))!.start;
  await page.getByRole("button", { name: "次の期間", exact: true }).click();
  await expect.poll(() => state.reads.filter((read) => read.source === "group").length).toBeGreaterThanOrEqual(2);
  expect(state.reads.filter((read) => read.source.startsWith("feed:"))).toHaveLength(2);
  state.feedGate!.resolve();
  await settle(page);
  const reads = state.reads.filter((read) => read.source.startsWith("feed:"));
  expect(reads.filter((read) => read.start === firstRange)).toHaveLength(2);
  expect(reads.filter((read) => read.start !== firstRange)).toHaveLength(5);
  expect(state.maxActiveFeeds).toBe(2);
  await page.getByRole("button", { name: "今日", exact: true }).click();
  await settle(page);
  await expect(page.getByRole("status")).toContainText("8件の予定を表示中");
  await expect(page.getByRole("alert")).toHaveCount(0);
  assertReadOnly(state.writes);
});
