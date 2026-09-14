import { expect, test, type Page } from "@playwright/test";
import type { AccountListItem, CompanyListItem, ContractDetail, PersonListItem } from "../src/api/client";

const CONTRACT_ID = "local-contract";
const titles = {
  companies: "会社を紐付け",
  persons: "名義を紐付け",
  accounts: "口座・カードを紐付け",
} as const;
type Resource = keyof typeof titles;
type Write = { path: string; method: string; body: unknown };
const unexpectedByPage = new WeakMap<Page, string[]>();

test.afterEach(async ({ page }) => {
  expect(unexpectedByPage.get(page) ?? []).toEqual([]);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function setup(page: Page) {
  const companies: CompanyListItem[] = Array.from({ length: 65 }, (_, i) => ({
    id: `company-${i + 1}`, company_name: `会社${i + 1}`, company_name_kana: `カイシャ${i + 1}`,
    prefecture: "東京都", city: `市区町村${i + 1}`, phone: `03-0000-${String(i + 1).padStart(4, "0")}`,
    status_flag: 0, contract_count: 0,
  }));
  const persons: PersonListItem[] = Array.from({ length: 65 }, (_, i) => ({
    id: `person-${i + 1}`, full_name: `名義${i + 1}`, full_name_kana: `メイギ${i + 1}`,
    prefecture: "大阪府", city: `市区町村${i + 1}`, birth_date: "1980-01-02", contract_count: 0,
  }));
  const accounts: AccountListItem[] = Array.from({ length: 65 }, (_, i) => ({
    id: `account-${i + 1}`, account_category: i === 60 ? "credit" : "bank",
    account_type: i === 60 ? "visa" : "ordinary", account_role: "self",
    bank_name: i === 60 ? null : `テスト銀行${i + 1}`, branch_name: i === 60 ? null : "本店",
    account_holder_kana: `メイギ${i + 1}`, account_no_masked: `****${String(i + 1).padStart(4, "0")}`,
    expiry_mm_yy: null, is_active: true, contract_count: 0,
  }));
  const detail: ContractDetail = {
    contract: {
      id: CONTRACT_ID, contract_no: "LOCAL-001", contract_summary: "ローカルの紐付けテスト",
      contract_category: "service", contract_status: "active", review_status: "approved",
    },
    companies: [], persons: [], accounts: [], identifiers: [], flags: [], communications: [],
    claims: [], payments: [], lawsuits: [], files: [],
  };
  const state = {
    companies, persons, accounts, detail,
    searches: [] as { resource: Resource; q: string; offset: number; limit: number }[],
    writes: [] as Write[],
    failures: new Map<string, number>(),
    slow: new Map<string, Promise<void>>(),
    roleFailures: 0,
    saveFailures: 0,
    saveGate: null as Promise<void> | null,
    unexpected: [] as string[],
  };
  unexpectedByPage.set(page, state.unexpected);
  page.on("pageerror", (error) => state.unexpected.push(error.message));
  // Every API response is local test data; unknown or non-local requests never reach a real service.
  await page.route("**/*", async (route) => {
    if (new URL(route.request().url()).origin === "http://127.0.0.1:4179") {
      await route.continue();
    } else {
      state.unexpected.push(route.request().url());
      await route.abort();
    }
  });
  await page.route("http://127.0.0.1:4179/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (path === "/api/config") return json({
      auth_enabled: false, entra: { tenant_id: "", client_id: "", api_scope: "" },
      sip: { wss_url: "", realm: "", stun: "", prefixes: "" }, cti_provider: "simulator",
    });
    if (path === "/api/auth/me") return json({
      id: "local-user", display_name: "テストユーザー", user_principal_name: "test@example.invalid",
      status: 1, is_admin: true, mail: null, cti_ext_num: null, cti_password: null,
    });
    if (path === "/api/auth/login") return json({ ok: true });
    if (path === "/api/cti/active") return json({ active: null });
    if (path === "/api/masters/link_category") {
      if (state.roleFailures-- > 0) return json({ detail: "master unavailable" }, 503);
      return json([{ code: "debtor", label: "債務者" }, { code: "guarantor", label: "保証人" }]);
    }
    if (path.startsWith("/api/masters/") || path === "/api/users") return json([]);
    if (path === `/api/contracts/${CONTRACT_ID}`) return json(detail);
    const resource = path.slice("/api/".length) as Resource;
    if (resource in titles) {
      const q = url.searchParams.get("q") ?? "";
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 50);
      state.searches.push({ resource, q, offset, limit });
      if (state.slow.has(q)) await state.slow.get(q);
      if ((state.failures.get(q) ?? 0) > 0) {
        state.failures.set(q, state.failures.get(q)! - 1);
        return json({ detail: "search unavailable" }, 503);
      }
      const items = state[resource].filter((item) => {
        const searchable = "company_name" in item
          ? [item.company_name, item.company_name_kana, item.city]
          : "full_name" in item ? [item.full_name, item.full_name_kana, item.city]
            : [item.bank_name, item.branch_name, item.account_holder_kana];
        return !q || searchable.some((value) => value?.includes(q));
      });
      return json({ total: items.length, items: items.slice(offset, offset + limit) });
    }
    if (path.startsWith(`/api/contracts/${CONTRACT_ID}/`) && request.method() === "POST") {
      const body: { entity_id: string; link_category: string; is_default?: boolean } = request.postDataJSON();
      state.writes.push({ path, method: request.method(), body });
      if (state.saveFailures-- > 0) return json({ detail: "この紐付けは保存できません" }, 409);
      if (state.saveGate) await state.saveGate;
      const link = { link_id: 101, link_category: body.link_category, link_label: "債務者" };
      if (path.endsWith("/company-links")) {
        detail.companies.push({ ...companies.find((item) => item.id === body.entity_id)!, ...link, address1: null });
      } else if (path.endsWith("/person-links")) {
        detail.persons.push({ ...persons.find((item) => item.id === body.entity_id)!, ...link, address1: null });
      } else if (path.endsWith("/account-links")) {
        detail.accounts.push({ ...accounts.find((item) => item.id === body.entity_id)!, ...link, is_default: !!body.is_default });
      }
      return json({ link_id: 101 });
    }
    if (path.startsWith("/api/contract-") && ["PUT", "DELETE"].includes(request.method())) {
      state.writes.push({ path, method: request.method(), body: request.method() === "PUT" ? request.postDataJSON() : null });
      return json({ ok: true });
    }
    state.unexpected.push(path);
    return json({ detail: "Unexpected fixture request" }, 404);
  });
  await page.goto(`/contracts/${CONTRACT_ID}`);
  await page.getByRole("tab", { name: "紐付（会社・名義・口座）", exact: true }).click();
  expect(state.searches).toHaveLength(0);
  return state;
}

async function openPicker(page: Page, resource: Resource) {
  await page.getByRole("button", { name: titles[resource], exact: true }).click();
  const dialog = page.getByRole("dialog", { name: titles[resource], exact: true });
  await expect(dialog.getByRole("radio")).toHaveCount(20);
  return dialog;
}

async function chooseRole(page: Page, label = "債務者") {
  await page.getByRole("dialog").getByRole("combobox").click();
  await page.getByRole("option", { name: label, exact: true }).click();
}

for (const resource of Object.keys(titles) as Resource[]) {
  test(`${resource}: paginated server search, selection, metadata and saved link`, async ({ page }) => {
    const state = await setup(page);
    const dialog = await openPicker(page, resource);
    await expect(dialog.getByRole("combobox")).toHaveCount(1);
    await expect(dialog.getByRole("button", { name: "紐付ける", exact: true })).toBeDisabled();
    await expect(dialog.getByText("検索結果：65 件", { exact: false })).toBeVisible();
    await dialog.getByRole("radio").first().check();
    await chooseRole(page);
    await dialog.getByRole("button", { name: "次の20件" }).click();
    await expect(dialog.getByRole("radio")).toHaveCount(20);
    await expect(dialog.getByText("未選択：", { exact: false })).toBeVisible();
    expect(state.searches.at(-1)).toEqual({ resource, q: "", offset: 20, limit: 20 });
    await dialog.getByRole("button", { name: "前の20件" }).click();
    await expect(dialog.getByText("1–20 件を表示", { exact: false })).toBeVisible();
    await dialog.getByRole("textbox", { name: "キーワード検索" }).fill(" 61 ");
    await dialog.getByRole("textbox", { name: "キーワード検索" }).press("Enter");
    await expect(dialog.getByRole("radio")).toHaveCount(1);
    expect(state.searches.at(-1)).toEqual({ resource, q: "61", offset: 0, limit: 20 });
    const table = dialog.getByRole("table");
    if (resource === "companies") {
      await expect(table).toContainText("カイシャ61");
      await expect(table).toContainText("東京都 市区町村61");
      await expect(table).toContainText("03-0000-0061");
    } else if (resource === "persons") {
      await expect(table).toContainText("メイギ61");
      await expect(table).toContainText("1980-01-02");
      await expect(table).toContainText("大阪府 市区町村61");
    } else {
      await expect(table).toContainText("クレジットカード・VISA");
      await expect(table).toContainText("メイギ61");
      await expect(table).toContainText("****0061");
      await expect(dialog.getByRole("switch", { name: "既定にする" })).not.toBeChecked();
      await dialog.getByRole("switch", { name: "既定にする" }).check();
    }
    await dialog.getByRole("radio").check();
    await dialog.getByRole("button", { name: "紐付ける", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const entityType = { companies: "company", persons: "person", accounts: "account" }[resource];
    expect(state.writes).toEqual([{
      path: `/api/contracts/${CONTRACT_ID}/${entityType}-links`,
      method: "POST",
      body: { entity_id: `${entityType}-61`, link_category: "debtor", ...(resource === "accounts" ? { is_default: true } : {}) },
    }]);
    const linkedTable = page.getByRole("table", { name: { companies: "紐付会社", persons: "紐付名義", accounts: "紐付口座" }[resource], exact: true });
    await expect(linkedTable).toContainText(resource === "accounts" ? "****0061" : `${resource === "companies" ? "会社" : "名義"}61`);
    await expect(page.getByRole("button", { name: titles[resource], exact: true })).toBeFocused();
    expect(state.unexpected).toEqual([]);
  });
}

test("bank account keeps default false and existing change/unlink controls still use their APIs", async ({ page }) => {
  const state = await setup(page);
  const dialog = await openPicker(page, "accounts");
  const row = dialog.getByRole("row").filter({ hasText: "テスト銀行1" }).first();
  await expect(row).toContainText("銀行口座・普通預金");
  await expect(row).toContainText("本店");
  await row.getByRole("radio").check();
  await chooseRole(page);
  await dialog.getByRole("button", { name: "紐付ける", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(state.writes[0].body).toEqual({ entity_id: "account-1", link_category: "debtor", is_default: false });
  const linked = page.getByRole("table", { name: "紐付口座", exact: true });
  await linked.getByRole("button", { name: "変更", exact: true }).click();
  await chooseRole(page, "保証人");
  await page.getByRole("dialog").getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(state.writes[1]).toEqual({
    path: "/api/contract-account-links/101", method: "PUT", body: { link_category: "guarantor", is_default: false },
  });
  await linked.getByRole("button", { name: "解除", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "実行する", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(state.writes[2]).toEqual({ path: "/api/contract-account-links/101", method: "DELETE", body: null });
});

test("search failure is not an empty result, retries and clearing return to page one", async ({ page }) => {
  const state = await setup(page);
  state.failures.set("61", 1);
  const dialog = await openPicker(page, "companies");
  await dialog.getByRole("textbox").fill("61");
  await dialog.getByRole("button", { name: "検索", exact: true }).click();
  await expect(dialog.getByText("検索に失敗しました。", { exact: false })).toBeVisible();
  await expect(dialog.getByText("該当するレコードがありません。", { exact: false })).toHaveCount(0);
  await expect(dialog.getByRole("radio")).toHaveCount(0);
  await dialog.getByRole("button", { name: "再試行", exact: true }).click();
  await expect(dialog.getByRole("radio")).toHaveCount(1);
  await dialog.getByRole("textbox").fill("該当なし");
  await dialog.getByRole("textbox").press("Enter");
  await expect(dialog.getByText("該当するレコードがありません。", { exact: false })).toBeVisible();
  await dialog.getByRole("button", { name: "条件をクリア" }).click();
  await expect(dialog.getByRole("radio")).toHaveCount(20);
  await expect(dialog.getByRole("textbox")).toHaveValue("");
  expect(state.searches.at(-1)).toEqual({ resource: "companies", q: "", offset: 0, limit: 20 });
});

test("slow superseded responses cannot replace current results or selection", async ({ page }) => {
  const state = await setup(page);
  const old = deferred();
  state.slow.set("61", old.promise);
  const dialog = await openPicker(page, "companies");
  await dialog.getByRole("textbox").fill("61");
  await dialog.getByRole("textbox").press("Enter");
  await expect(dialog.getByText("検索中…", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("radio")).toHaveCount(0);
  await dialog.getByRole("textbox").fill("62");
  await dialog.getByRole("textbox").press("Enter");
  await expect(dialog.getByRole("table")).toContainText("会社62");
  await dialog.getByRole("radio").check();
  const response = page.waitForResponse((res) => new URL(res.url()).searchParams.get("q") === "61");
  old.resolve();
  await response;
  await expect(dialog.getByRole("table")).toContainText("会社62");
  await expect(dialog.getByRole("radio")).toBeChecked();
  await expect(dialog.getByText("選択中：会社62", { exact: true })).toBeVisible();
});

test("closing while searching ignores the old response and reopening starts fresh", async ({ page }) => {
  const state = await setup(page);
  const old = deferred();
  state.slow.set("61", old.promise);
  let dialog = await openPicker(page, "persons");
  await dialog.getByRole("textbox").fill("61");
  await dialog.getByRole("textbox").press("Enter");
  await expect(dialog.getByText("検索中…", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "キャンセル" }).click();
  dialog = await openPicker(page, "persons");
  const response = page.waitForResponse((res) => new URL(res.url()).searchParams.get("q") === "61");
  old.resolve();
  await response;
  await expect(dialog.getByRole("radio")).toHaveCount(20);
  await expect(dialog.getByRole("textbox")).toHaveValue("");
  await expect(dialog.getByText("未選択：", { exact: false })).toBeVisible();
  expect(state.writes).toEqual([]);
});

test("master load error can be retried without losing the selected record", async ({ page }) => {
  const state = await setup(page);
  state.roleFailures = Infinity;
  const dialog = await openPicker(page, "companies");
  await dialog.getByRole("radio").first().check();
  await expect(dialog.getByText("紐付け種別の読み込みに失敗しました。", { exact: false })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "紐付ける", exact: true })).toBeDisabled();
  state.roleFailures = 0;
  await dialog.getByRole("button", { name: "種別を再読み込み" }).click();
  await chooseRole(page);
  await expect(dialog.getByRole("radio").first()).toBeChecked();
  await expect(dialog.getByRole("button", { name: "紐付ける", exact: true })).toBeEnabled();
});

test("failed saves preserve selection and metadata; retry cannot double-submit or close mid-save", async ({ page }) => {
  const state = await setup(page);
  state.saveFailures = 1;
  const dialog = await openPicker(page, "accounts");
  await dialog.getByRole("radio").first().check();
  await chooseRole(page);
  await dialog.getByRole("switch", { name: "既定にする" }).check();
  const save = dialog.getByRole("button", { name: "紐付ける", exact: true });
  await save.click();
  await expect(dialog.getByText("この紐付けは保存できません", { exact: false })).toBeVisible();
  await expect(dialog.getByRole("radio").first()).toBeChecked();
  await expect(dialog.getByRole("combobox")).toHaveText("債務者");
  await expect(dialog.getByRole("switch")).toBeChecked();
  const pending = deferred();
  state.saveGate = pending.promise;
  await save.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await expect(dialog.getByText("紐付け中…", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "キャンセル" })).toBeDisabled();
  await expect(dialog.getByRole("textbox")).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect.poll(() => state.writes.length).toBe(2);
  pending.resolve();
  await expect(dialog).toHaveCount(0);
  expect(state.writes[1].body).toEqual(state.writes[0].body);
  expect(state.writes).toHaveLength(2);
});

test("same-name records remain distinguishable and keyboard selection works on a narrow screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await setup(page);
  state.persons[0].full_name = state.persons[1].full_name = "山田 太郎";
  state.persons[1].birth_date = "1990-03-04";
  const dialog = await openPicker(page, "persons");
  await dialog.getByRole("textbox").fill("山田");
  await dialog.getByRole("textbox").press("Enter");
  await expect(dialog.getByRole("radio")).toHaveCount(2);
  await dialog.getByRole("radio").first().focus();
  await page.keyboard.press("Space");
  await expect(dialog.getByRole("radio").first()).toBeChecked();
  await page.keyboard.press("ArrowDown");
  await expect(dialog.getByRole("radio").nth(1)).toBeChecked();
  await expect(dialog.getByRole("radio").first()).not.toBeChecked();
  await expect(dialog.getByText("生年月日：1990-03-04", { exact: false })).toBeVisible();
  const bounds = await dialog.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.width).toBeLessThanOrEqual(390);
  const scroll = dialog.getByRole("region", { name: "検索結果の表" });
  expect(await scroll.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  const screenshot = test.info().outputPath("record-link-mobile.png");
  await dialog.screenshot({ path: screenshot });
  await test.info().attach("record-link-mobile", { path: screenshot, contentType: "image/png" });
  await chooseRole(page);
  await dialog.getByRole("button", { name: "紐付ける", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(state.writes[0].body).toEqual({ entity_id: "person-2", link_category: "debtor" });
});

test("Enter during IME composition does not submit a search and Escape cancels without saving", async ({ page }) => {
  const state = await setup(page);
  const dialog = await openPicker(page, "companies");
  const count = state.searches.length;
  await dialog.getByRole("textbox").fill("会社");
  await dialog.getByRole("textbox").dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
  expect(state.searches).toHaveLength(count);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(state.writes).toEqual([]);
  await expect(page.getByRole("button", { name: titles.companies, exact: true })).toBeFocused();
});
