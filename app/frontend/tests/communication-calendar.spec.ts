import { expect, test, type Locator, type Page } from "@playwright/test";
import { build } from "esbuild";
import { resolve } from "node:path";
import type {
  CalendarRegistration, Communication, CommunicationIn, ContractDetail,
  getJson, sendJson,
} from "../src/api/client";

declare global {
  interface Window {
    communicationCalendarTestApi: { getJson: typeof getJson; sendJson: typeof sendJson };
  }
}

test.describe.configure({ mode: "default" });
test.use({ timezoneId: "America/Los_Angeles" });

const CONTRACT = "history-test";
const OCCURRED_AT = "2026-09-14T11:22:33+09:00";
const START = "2026-09-20T09:30:00+09:00";
const END = "2026-09-20T10:00:00+09:00";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const unexpectedByPage = new WeakMap<Page, string[]>();
let fixtureBundle = "";

test.beforeAll(async ({}, info) => {
  info.setTimeout(180000);
  // Exercise the real history UI without signing in to any external identity provider.
  // Keeping the fixture in memory also works against a production-preview server.
  const result = await build({
    stdin: {
      resolveDir: resolve(info.project.testDir, ".."),
      sourcefile: "communication-calendar-fixture.tsx",
      loader: "tsx",
      contents: `
        import React from "react";
        import { createRoot } from "react-dom/client";
        import { FluentProvider, webLightTheme } from "@fluentui/react-components";
        import { BrowserRouter, Route, Routes } from "react-router-dom";
        import ContractDetail from "./src/pages/ContractDetail";
        import { loadRuntimeConfig } from "./src/auth/runtimeConfig";
        import { getJson, sendJson } from "./src/api/client";
        Object.assign(window, { communicationCalendarTestApi: { getJson, sendJson } });
        await loadRuntimeConfig();
        createRoot(document.getElementById("root")).render(
          <React.StrictMode><FluentProvider theme={webLightTheme}>
            <BrowserRouter><Routes>
              <Route path="/contracts/:id" element={<ContractDetail />} />
            </Routes></BrowserRouter>
          </FluentProvider></React.StrictMode>
        );
      `,
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    target: "es2022",
    jsx: "automatic",
    minify: true,
    preserveSymlinks: true,
    logLevel: "warning",
  });
  const output = result.outputFiles?.[0];
  if (!output) throw new Error("History UI fixture bundle was not generated");
  fixtureBundle = output.text;
});

test.afterEach(({ page }) => expect(unexpectedByPage.get(page) ?? []).toEqual([]));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function registration(status: CalendarRegistration["status"]): CalendarRegistration {
  return {
    status, calendar_name: "履歴テストグループ", starts_at: START, ends_at: END,
    error: status === "failed" ? "予定表への書き込みに失敗しました" : null,
  };
}

function communication(id: string, status: CalendarRegistration["status"] | null = null): Communication {
  return {
    id, occurred_at: OCCURRED_AT, channel: "電話", direction: "in",
    summary: `履歴 ${id}`, details: "既存詳細\n二行目",
    calendar: status ? registration(status) : null,
  };
}

async function setup(page: Page, enabled = true) {
  const origin = new URL(test.info().project.use.baseURL ?? "http://127.0.0.1:4179").origin;
  const detail: ContractDetail = {
    contract: {
      id: CONTRACT, contract_no: "HISTORY-001", contract_summary: "履歴の予定登録テスト",
      contract_status: "active", review_status: "approved",
    },
    companies: [], persons: [], accounts: [], identifiers: [], flags: [],
    communications: [
      communication("unscheduled"), communication("created", "created"),
      communication("pending", "pending"), communication("failed", "failed"),
      ...Array.from({ length: 20 }, (_, i) => communication(`older-${i}`)),
      communication("target-last"),
    ],
    claims: [], payments: [], lawsuits: [], files: [],
  };
  const state = {
    detail, reads: 0, failNextRead: false, readGate: null as Promise<void> | null,
    saveGate: null as Promise<void> | null, abortNextSave: false, saveFailures: [] as number[],
    saveStatus: "created" as CalendarRegistration["status"],
    retryStatus: "created" as CalendarRegistration["status"], denyRetry: false,
    concurrentRegistration: false,
    writes: [] as { method: string; path: string; raw: string; body: CommunicationIn }[],
    retries: [] as { method: string; path: string; body: string | null }[],
    submissions: new Map<string, { raw: string; method: string; id: string }>(),
    unexpected: [] as string[],
    errorResponse: { status: 503, body: "設定を確認してください" as unknown, plain: false },
  };
  unexpectedByPage.set(page, state.unexpected);
  page.on("pageerror", (error) => state.unexpected.push(error.message));
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) {
      state.unexpected.push(request.url());
      return route.abort();
    }
    if (request.resourceType() === "document" && url.pathname.startsWith("/contracts/")) {
      return route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><html lang="ja"><meta charset="UTF-8"><div id="root"></div><script type="module" src="/communication-calendar-fixture.js"></script></html>',
      });
    }
    if (url.pathname === "/communication-calendar-fixture.js") {
      return route.fulfill({ contentType: "text/javascript", body: fixtureBundle });
    }
    return route.continue();
  });
  await page.route(`${origin}/api/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (path === "/api/config") return json({
      auth_enabled: true, entra: { tenant_id: "", client_id: "", api_scope: "" },
      sip: { wss_url: "", realm: "", stun: "", prefixes: "" }, cti_provider: "simulator",
      calendar: {
        enabled, name: "履歴テストグループ",
        unavailable_reason: enabled ? null : "公開 URL が未設定のため予定登録を利用できません。",
      },
    });
    if (path.startsWith("/api/masters/") || path === "/api/users") return json([]);
    if (path === "/api/error-fixture") {
      if (state.errorResponse.plain) return route.fulfill({
        status: state.errorResponse.status, contentType: "text/html", body: "<h1>Proxy failure</h1>",
      });
      return json({ detail: state.errorResponse.body }, state.errorResponse.status);
    }
    if (path === `/api/contracts/${CONTRACT}`) {
      state.reads++;
      if (state.readGate) await state.readGate;
      if (state.failNextRead) { state.failNextRead = false; return route.abort(); }
      return json(detail);
    }
    const edit = /^\/api\/communications\/([^/]+)$/.exec(path);
    if ((edit && request.method() === "PUT") || (path === `/api/contracts/${CONTRACT}/communications` && request.method() === "POST")) {
      const raw = request.postData()!;
      const body: CommunicationIn = request.postDataJSON();
      state.writes.push({ method: request.method(), path, raw, body });
      const failure = state.saveFailures.shift();
      if (failure) return json({ detail: `保存エラー ${failure}` }, failure);
      const prior = body.calendar && state.submissions.get(body.calendar.request_id);
      if (prior && (prior.raw !== raw || prior.method !== request.method() || (edit && edit[1] !== prior.id))) {
        return json({ detail: "同じ送信 ID で内容は変更できません" }, 409);
      }
      const id = edit?.[1] ?? prior?.id ?? `new-${state.writes.length}`;
      let record = detail.communications.find((item) => item.id === id);
      if (!record) {
        record = communication(id);
        detail.communications.push(record);
      }
      if (state.concurrentRegistration && body.calendar && !prior) {
        record.calendar = registration("created");
        return json({ detail: "この履歴には別のタブから予定が登録されています" }, 409);
      }
      if (body.calendar && record.calendar && !prior) return json({ detail: "予定の追加登録はできません" }, 409);
      if (!prior) {
        record.occurred_at = body.occurred_at || "2026-09-15T12:00:00+09:00";
        record.summary = body.summary;
        record.details = body.details ?? null;
        record.direction = body.direction ?? null;
        record.channel = body.channel ?? null;
        if (body.calendar) {
          record.calendar = {
            ...registration(state.saveStatus), starts_at: body.calendar.starts_at, ends_at: body.calendar.ends_at,
          };
          state.submissions.set(body.calendar.request_id, { raw, method: request.method(), id });
        }
      }
      if (state.saveGate) await state.saveGate;
      if (state.abortNextSave) { state.abortNextSave = false; return route.abort(); }
      return json({ ...(edit ? { ok: true } : {}), id, calendar: record.calendar });
    }
    const retry = /^\/api\/communications\/([^/]+)\/calendar\/retry$/.exec(path);
    if (retry && request.method() === "POST") {
      state.retries.push({ method: request.method(), path, body: request.postData() });
      if (state.denyRetry) return json({ detail: "最初の依頼者だけが再試行できます" }, 403);
      const record = detail.communications.find((item) => item.id === retry[1])!;
      record.calendar = { ...record.calendar!, status: state.retryStatus, error: null };
      return json(record.calendar);
    }
    state.unexpected.push(path);
    return json({ detail: "Unexpected fixture request" }, 404);
  });
  return state;
}

async function visitHistory(page: Page) {
  await page.goto(`/contracts/${CONTRACT}?tab=history`);
  await expect(page.getByRole("tab", { name: "やり取り履歴", exact: true })).toHaveAttribute("aria-selected", "true");
}

async function editHistory(page: Page, id = "unscheduled") {
  await page.locator(`#communication-${id}`).getByRole("button", { name: "編集", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "やり取りを編集", exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function chooseCalendar(dialog: Locator) {
  await expect(dialog.getByRole("checkbox")).not.toBeChecked();
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("textbox", { name: "予定の開始日時（日本時間）", exact: true }).fill("2026-09-20T09:30");
  await dialog.getByRole("textbox", { name: "予定の終了日時（日本時間）", exact: true }).fill("2026-09-20T10:00");
}

test("unscheduled history can add a calendar once through PUT with separate JST dates", async ({ page }) => {
  const state = await setup(page);
  await visitHistory(page);
  const dialog = await editHistory(page);
  await expect(dialog.getByRole("checkbox")).not.toBeChecked();
  await expect(dialog.locator('input[type="datetime-local"]')).toHaveCount(0);
  await dialog.getByRole("textbox", { name: "概要（結果・要点）" }).fill("予定を追加した履歴");
  await chooseCalendar(dialog);
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("#communication-unscheduled").getByText("予定登録済み", { exact: true })).toBeVisible();
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]).toMatchObject({ method: "PUT", path: "/api/communications/unscheduled" });
  expect(state.writes[0].body).toEqual({
    occurred_at: OCCURRED_AT, direction: "in", channel: "電話",
    summary: "予定を追加した履歴", details: "既存詳細\n二行目",
    calendar: { request_id: expect.stringMatching(uuid), starts_at: START, ends_at: END },
  });
  const reopened = await editHistory(page);
  await expect(reopened.getByText("予定の追加登録不可", { exact: true })).toBeVisible();
  await expect(reopened.getByRole("checkbox")).toHaveCount(0);
  await expect(reopened.locator('input[type="datetime-local"]')).toHaveCount(0);
});

test("registered history remains editable but cannot register another event, including after reopening", async ({ page }) => {
  const state = await setup(page);
  await visitHistory(page);
  let dialog = await editHistory(page, "created");
  await expect(dialog.getByText("予定登録済み", { exact: true })).toBeVisible();
  await expect(dialog.getByText("予定の追加登録不可", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("checkbox")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: /予定を再登録/ })).toHaveCount(0);
  await dialog.getByRole("textbox", { name: "詳細メモ" }).fill("履歴だけの変更\n二行目も保持");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(state.writes[0].body).not.toHaveProperty("calendar");
  expect(state.writes[0].body.occurred_at).toBe(OCCURRED_AT);
  await expect(page.getByText("登録済みの Outlook の予定は変更していません。", { exact: false })).toBeVisible();
  dialog = await editHistory(page, "created");
  await expect(dialog.getByRole("checkbox")).toHaveCount(0);
  await expect(dialog.getByRole("textbox", { name: "詳細メモ" })).toHaveValue("履歴だけの変更\n二行目も保持");
  expect(state.submissions.size).toBe(0);
});

test("edit validates required calendar dates and preserves editable values after a pre-save rejection", async ({ page }) => {
  const state = await setup(page);
  await visitHistory(page);
  const dialog = await editHistory(page);
  await dialog.getByRole("checkbox").check();
  const save = dialog.getByRole("button", { name: "保存", exact: true });
  await save.click();
  await expect(dialog.getByText("実在する開始日時を分単位で入力してください。", { exact: true })).toBeVisible();
  await expect(dialog.getByText("実在する終了日時を分単位で入力してください。", { exact: true })).toBeVisible();
  expect(state.writes).toHaveLength(0);
  const start = dialog.getByRole("textbox", { name: "予定の開始日時（日本時間）", exact: true });
  const end = dialog.getByRole("textbox", { name: "予定の終了日時（日本時間）", exact: true });
  await start.fill("2026-09-20T09:30");
  await end.fill("2026-09-20T09:30");
  await save.click();
  await expect(dialog.getByText("終了日時は開始日時より後にしてください。", { exact: true })).toBeVisible();
  expect(state.writes).toHaveLength(0);
  await end.fill("2026-09-20T10:00");
  state.saveFailures.push(422);
  await save.click();
  await expect(dialog.getByText("保存エラー 422", { exact: false })).toBeVisible();
  await expect(start).toBeEnabled();
  await expect(end).toHaveValue("2026-09-20T10:00");
  await expect(dialog.getByRole("checkbox")).toBeChecked();
  await dialog.getByRole("textbox", { name: "概要（結果・要点）" }).fill("修正した概要");
  await save.click();
  await expect(dialog).toHaveCount(0);
  expect(state.writes).toHaveLength(2);
  expect(state.writes[0].body.calendar?.request_id).toBe(state.writes[1].body.calendar?.request_id);
  expect(state.writes[1].body.summary).toBe("修正した概要");
});

for (const status of ["pending", "failed"] as const) {
  test(`${status}: edit offers only the existing calendar retry and keeps the unsaved draft`, async ({ page }) => {
    const state = await setup(page);
    await visitHistory(page);
    const dialog = await editHistory(page, status);
    await expect(dialog.getByRole("checkbox")).toHaveCount(0);
    await expect(dialog.locator('input[type="datetime-local"]')).toHaveCount(0);
    await dialog.getByRole("textbox", { name: "詳細メモ" }).fill("未保存の変更");
    state.denyRetry = true;
    await dialog.getByRole("button", { name: /予定を再登録/ }).click();
    await expect(dialog.getByText("最初に予定登録を依頼した本人のみ行えます。", { exact: false })).toBeVisible();
    state.denyRetry = false;
    await dialog.getByRole("button", { name: /予定を再登録/ }).click();
    await expect(dialog.getByText("予定登録済み", { exact: true })).toBeVisible();
    await expect(dialog.getByRole("checkbox")).toHaveCount(0);
    await expect(dialog.getByRole("textbox", { name: "詳細メモ" })).toHaveValue("未保存の変更");
    expect(state.writes).toHaveLength(0);
    expect(state.retries).toEqual(Array.from({ length: 2 }, () => ({
      method: "POST", path: `/api/communications/${status}/calendar/retry`, body: null,
    })));
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(state.writes[0].body).not.toHaveProperty("calendar");
    expect(state.writes[0].body.details).toBe("未保存の変更");
  });
}

test("uncertain checked edit retries the original UUID and byte-identical PUT body through later errors", async ({ page }) => {
  const state = await setup(page);
  await visitHistory(page);
  const dialog = await editHistory(page);
  await chooseCalendar(dialog);
  const gate = deferred();
  state.saveGate = gate.promise;
  state.abortNextSave = true;
  const save = dialog.getByRole("button", { name: "保存", exact: true });
  await save.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await expect.poll(() => state.writes.length).toBe(1);
  await expect(dialog.getByRole("checkbox")).toBeDisabled();
  await expect(dialog.getByRole("textbox", { name: "概要（結果・要点）" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "キャンセル" })).toBeDisabled();
  gate.resolve();
  const retry = dialog.getByRole("button", { name: "同じ内容で再試行", exact: true });
  await expect(retry).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  for (const status of [503, 422]) {
    state.saveFailures.push(status);
    await retry.click();
    await expect(dialog.getByText(`保存エラー ${status}`, { exact: false })).toBeVisible();
    await expect(dialog.getByRole("checkbox")).toBeDisabled();
    await expect(dialog.getByRole("textbox", { name: "概要（結果・要点）" })).toBeDisabled();
  }
  await retry.click();
  await expect(dialog).toHaveCount(0);
  expect(state.writes).toHaveLength(4);
  expect(new Set(state.writes.map((write) => write.raw)).size).toBe(1);
  expect(state.writes.every((write) => write.method === "PUT" && write.path === "/api/communications/unscheduled")).toBe(true);
  expect(state.writes[0].body.calendar?.request_id).toMatch(uuid);
  expect(state.submissions.size).toBe(1);
  expect(state.retries).toHaveLength(0);
});

test("an uncertain history-only edit can explicitly retry the same PUT without a calendar", async ({ page }) => {
  const state = await setup(page);
  await visitHistory(page);
  const dialog = await editHistory(page);
  await dialog.getByRole("textbox", { name: "概要（結果・要点）" }).fill("履歴だけを更新");
  state.abortNextSave = true;
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog.getByRole("textbox", { name: "概要（結果・要点）" })).toBeDisabled();
  await dialog.getByRole("button", { name: "同じ内容で再試行", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(state.writes).toHaveLength(2);
  expect(state.writes[0].raw).toBe(state.writes[1].raw);
  expect(state.writes.every((write) => write.method === "PUT" && !write.body.calendar)).toBe(true);
  expect(state.submissions.size).toBe(0);
});

for (const status of ["pending", "failed"] as const) {
  test(`${status}: checked edit saves history, refreshes status, and preserves the partial-result notice`, async ({ page }) => {
    const state = await setup(page);
    await visitHistory(page);
    const dialog = await editHistory(page);
    await chooseCalendar(dialog);
    state.saveStatus = status;
    state.failNextRead = true;
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText("履歴は保存済みですが、", { exact: false })).toBeVisible();
    await expect(page.getByText("履歴を再読み込みできませんでした。", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "履歴を再読み込み", exact: true }).click();
    const row = page.locator("#communication-unscheduled");
    await expect(row.getByText(status === "pending" ? "予定登録の確認待ち" : "予定登録に失敗", { exact: true })).toBeVisible();
    await expect(page.getByText("履歴は保存済みですが、", { exact: false })).toBeVisible();
    const reopened = await editHistory(page);
    await expect(reopened.getByRole("checkbox")).toHaveCount(0);
    await expect(reopened.getByRole("button", { name: /予定を再登録/ })).toBeVisible();
    expect(state.writes).toHaveLength(1);
    expect(state.submissions.size).toBe(1);
  });
}

test("concurrent registration conflict never generates a replacement request or reoffers registration", async ({ page }) => {
  const state = await setup(page);
  await visitHistory(page);
  const dialog = await editHistory(page);
  await chooseCalendar(dialog);
  state.concurrentRegistration = true;
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog.getByText("別のタブから予定が登録されています", { exact: false })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "同じ内容で再試行", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("checkbox")).toBeDisabled();
  await dialog.getByRole("button", { name: "閉じて履歴を確認", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("#communication-unscheduled").getByText("予定登録済み", { exact: true })).toBeVisible();
  const reopened = await editHistory(page);
  await expect(reopened.getByRole("checkbox")).toHaveCount(0);
  expect(state.writes).toHaveLength(1);
});

test("create keeps transport retry safety and generates a fresh request ID for the next record", async ({ page }) => {
  const state = await setup(page);
  await visitHistory(page);
  await page.getByRole("button", { name: "記録", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "やり取りを記録", exact: true });
  await dialog.getByRole("textbox", { name: "概要（結果・要点）" }).fill("新規履歴");
  await chooseCalendar(dialog);
  state.abortNextSave = true;
  await dialog.getByRole("button", { name: "記録する", exact: true }).click();
  await expect(dialog.getByRole("checkbox")).toBeDisabled();
  await dialog.getByRole("button", { name: "同じ内容で再試行", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(state.writes[0].raw).toBe(state.writes[1].raw);
  expect(state.writes.every((write) => write.method === "POST")).toBe(true);
  await page.getByRole("button", { name: "記録", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "やり取りを記録", exact: true });
  await dialog.getByRole("textbox", { name: "概要（結果・要点）" }).fill("次の履歴");
  await chooseCalendar(dialog);
  await dialog.getByRole("button", { name: "記録する", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(state.writes[2].body.calendar?.request_id).not.toBe(state.writes[0].body.calendar?.request_id);
});

test("deep links select history, focus and scroll the row after loading, and preserve manual tab selection", async ({ page }) => {
  const state = await setup(page);
  const gate = deferred();
  state.readGate = gate.promise;
  await page.goto(`/contracts/${CONTRACT}?tab=history#communication-target-last`);
  await expect.poll(() => state.reads).toBeGreaterThan(0);
  gate.resolve();
  const target = page.locator("#communication-target-last");
  await expect(target).toBeFocused();
  await expect(target).toBeInViewport();
  await page.getByRole("tab", { name: "基本情報", exact: true }).click();
  await expect(page.getByRole("tab", { name: "基本情報", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("table", { name: "やり取り履歴", exact: true })).toHaveCount(0);
  await page.evaluate((url) => {
    window.history.pushState({}, "", url);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, `/contracts/${CONTRACT}?tab=history#communication-unscheduled`);
  await expect(page.locator("#communication-unscheduled")).toBeFocused();
  await page.reload();
  await expect(page.locator("#communication-unscheduled")).toBeFocused();
  await expect(page.locator("#communication-unscheduled")).toBeInViewport();
});

test("missing and malformed history anchors are handled without focusing unrelated elements", async ({ page }) => {
  await setup(page);
  await page.goto(`/contracts/${CONTRACT}?tab=history#communication-missing%22%5D`);
  await expect(page.getByText("指定された履歴が見つかりません。", { exact: false })).toBeVisible();
  await expect(page.getByRole("tab", { name: "やり取り履歴", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.goto(`/contracts/${CONTRACT}?tab=history#communication-%E0%A4%A`);
  await expect(page.getByRole("table", { name: "やり取り履歴", exact: true })).toBeVisible();
  await page.goto(`/contracts/${CONTRACT}?tab=unknown#communication-unscheduled`);
  await expect(page.getByRole("tab", { name: "基本情報", exact: true })).toHaveAttribute("aria-selected", "true");
});

test("public URL unavailability disables scheduling for unscheduled edits but still permits history changes", async ({ page }) => {
  const state = await setup(page, false);
  await visitHistory(page);
  const dialog = await editHistory(page);
  await expect(dialog.getByRole("checkbox")).not.toBeChecked();
  await expect(dialog.getByRole("checkbox")).toBeDisabled();
  await expect(dialog.getByText("公開 URL が未設定", { exact: false })).toBeVisible();
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(state.writes[0].body).not.toHaveProperty("calendar");
});

test("GET and write errors expose safe detail with ApiError and fall back to status for non-JSON responses", async ({ page }) => {
  const state = await setup(page);
  await visitHistory(page);
  async function readError(method: "GET" | "POST") {
    return page.evaluate(async (method) => {
      try {
        if (method === "GET") await window.communicationCalendarTestApi.getJson("/api/error-fixture");
        else await window.communicationCalendarTestApi.sendJson("POST", "/api/error-fixture");
        return null;
      } catch (error: unknown) {
        if (!(error instanceof Error)) throw error;
        return { name: error.name, message: error.message, status: "status" in error ? error.status : null };
      }
    }, method);
  }
  for (const method of ["GET", "POST"] as const) {
    state.errorResponse.body = "公開 URL の設定を確認してください";
    expect(await readError(method)).toEqual({ name: "ApiError", message: "公開 URL の設定を確認してください", status: 503 });
    state.errorResponse.body = [{ loc: ["starts_at"], msg: "invalid date" }];
    expect(await readError(method)).toEqual({ name: "ApiError", message: JSON.stringify(state.errorResponse.body), status: 503 });
    state.errorResponse.plain = true;
    expect(await readError(method)).toEqual({ name: "ApiError", message: "API 503", status: 503 });
    state.errorResponse.plain = false;
  }
});
