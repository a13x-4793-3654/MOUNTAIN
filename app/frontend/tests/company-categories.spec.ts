import { expect, test, type Locator, type Page } from "@playwright/test";
import type { CodeMaster, CompanyCategory, CompanyDetail, CompanyIn, MasterIn } from "../src/api/client";

const LAWYER = "弁護士・法律事務所";
const SERVICER = "債権回収業者（サービサー）";
const CUSTOM = "調停支援機関";
const LEGACY = "legacy,arbitration";
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
  const masters: CodeMaster[] = [
    { id: 1, category: "company_category", code: "lawyer", label: LAWYER, sort_order: 0, is_active: true },
    { id: 2, category: "company_category", code: "servicer", label: SERVICER, sort_order: 1, is_active: true },
    { id: 3, category: "company_category", code: "mediator", label: CUSTOM, sort_order: 2, is_active: true },
    { id: 4, category: "company_category", code: "old-office", label: "旧事務所区分", sort_order: 3, is_active: false },
  ];
  function categories(codes: string[]): CompanyCategory[] {
    return codes.map((code) => {
      const master = masters.find((item) => item.code === code);
      return { code, label: master?.label ?? code, is_active: master?.is_active ?? false };
    });
  }
  function company(id: string, name: string, codes: string[]): CompanyDetail {
    return {
      company: {
        id, company_name: name, company_name_kana: null, corporate_number: null,
        prefecture: null, city: null, address1: null, address2: null, postal_code: null,
        status_flag: 0, status_reason: null, phone: null, contract_count: 0,
        categories: categories(codes),
      },
      phones: [], contracts: [],
    };
  }
  const records: Record<string, CompanyDetail> = {
    unclassified: company("unclassified", "架空の未分類会社", []),
    classified: company("classified", "架空の複合業務会社", ["lawyer", "servicer"]),
    legacy: company("legacy", "架空の旧分類会社", ["old-office", LEGACY, "lawyer"]),
  };
  records.classified.contracts.push({
    id: "fictional-contract", contract_no: "LOCAL-CLASSIFICATION-001",
    contract_summary: "分類と関係を区別するローカルテスト", contract_status: "active",
    status_label: "有効", link_category: "debtor", link_label: "債務者",
  });
  const state = {
    masters, records,
    writes: [] as { method: string; path: string; body: CompanyIn }[],
    masterWrites: [] as MasterIn[],
    masterFailure: false,
    masterGate: null as Promise<void> | null,
    masterRequests: 0,
    masterCompleted: 0,
    saveFailures: 0,
    saveGate: null as Promise<void> | null,
    unexpected: [] as string[],
  };
  unexpectedByPage.set(page, state.unexpected);
  page.on("pageerror", (error) => state.unexpected.push(error.message));
  // Block external traffic and fulfill every API call with fictional local data.
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
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (path === "/api/config") return json({
      auth_enabled: false, entra: { tenant_id: "", client_id: "", api_scope: "" },
      sip: { wss_url: "", realm: "", stun: "", prefixes: "" }, cti_provider: "simulator",
    });
    if (path === "/api/auth/me") return json({
      id: "fictional-user", display_name: "ローカルテスト管理者",
      user_principal_name: "categories@example.invalid", status: 1, is_admin: true,
      mail: null, cti_ext_num: null, cti_password: null,
    });
    if (path === "/api/auth/login") return json({ ok: true });
    if (path === "/api/cti/active") return json({ active: null });
    if (path === "/api/masters/company_category") {
      state.masterRequests += 1;
      const failure = state.masterFailure;
      const snapshot = masters.filter((item) => item.is_active).map(({ code, label }) => ({ code, label }));
      if (state.masterGate) await state.masterGate;
      await json(failure ? { detail: "分類マスタを取得できません" } : snapshot, failure ? 503 : 200);
      state.masterCompleted += 1;
      return;
    }
    if (path === "/api/admin" && method === "GET") return json({
      users: [], code_masters: masters, deny_list: [], audit: [], notifications: [],
      roles: [], permissions: [], group_role_maps: [],
    });
    if (path === "/api/admin/masters" && method === "POST") {
      const body: MasterIn = request.postDataJSON();
      state.masterWrites.push(body);
      const id = masters.length + 1;
      masters.push({ id, ...body });
      return json({ id });
    }
    if (path === "/api/companies" && method === "GET") {
      const items = Object.values(records).map((record) => ({
        ...record.company, categories: categories(record.company.categories.map((item) => item.code)),
      }));
      return json({ total: items.length, items });
    }
    const id = path.slice("/api/companies/".length);
    if (path.startsWith("/api/companies/") && method === "GET" && records[id]) {
      const detail = records[id];
      return json({
        ...detail,
        company: { ...detail.company, categories: categories(detail.company.categories.map((item) => item.code)) },
      });
    }
    if ((path === "/api/companies" && method === "POST") ||
        (path.startsWith("/api/companies/") && records[id] && method === "PUT")) {
      const body: CompanyIn = request.postDataJSON();
      state.writes.push({ method, path, body });
      if (state.saveFailures-- > 0) return json({ detail: "会社情報を保存できません" }, 409);
      if (state.saveGate) await state.saveGate;
      const targetId = method === "POST" ? `created-${state.writes.length}` : id;
      const record = records[targetId] ?? company(targetId, body.company_name, []);
      record.company = {
        ...record.company, ...body,
        categories: body.category_codes === undefined
          ? record.company.categories : categories(body.category_codes),
      };
      records[targetId] = record;
      return json(method === "POST" ? { id: targetId } : { ok: true });
    }
    state.unexpected.push(`${method} ${path}`);
    return json({ detail: "Unexpected fixture request" }, 404);
  });
  return state;
}

async function openCreate(page: Page) {
  await page.getByRole("button", { name: "新規登録", exact: true }).click();
  return page.getByRole("dialog", { name: "会社の新規登録", exact: true });
}

async function openEdit(page: Page) {
  await page.getByRole("button", { name: "編集", exact: true }).first().click();
  return page.getByRole("dialog", { name: "会社情報の編集", exact: true });
}

async function toggleCategories(page: Page, dialog: Locator, labels: string[]) {
  const picker = dialog.getByRole("combobox", { name: "会社分類", exact: true });
  await expect(picker).toBeEnabled();
  await picker.click();
  for (const label of labels) await page.getByRole("menuitemcheckbox", { name: label, exact: true }).click();
  await picker.press("Escape");
}

async function saveEdit(dialog: Locator) {
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

test("list and detail show current labels, unclassified companies, and separate contract roles", async ({ page }) => {
  const state = await setup(page);
  state.masters[0].label = "法律専門会社（名称更新）";
  await page.goto("/companies");
  const table = page.getByRole("table", { name: "会社一覧", exact: true });
  await expect(table.getByRole("columnheader", { name: "会社分類", exact: true })).toBeVisible();
  await expect(table.getByRole("row").filter({ hasText: "架空の未分類会社" })).toContainText("未分類");
  const classified = table.getByRole("row").filter({ hasText: "架空の複合業務会社" });
  await expect(classified).toContainText("法律専門会社（名称更新）");
  await expect(classified).toContainText(SERVICER);
  await expect(table.getByRole("row").filter({ hasText: "架空の旧分類会社" })).toContainText(`${LEGACY}（無効・未登録）`);
  await classified.getByRole("button", { name: "開く", exact: true }).click();
  await expect(page.getByText(`法律専門会社（名称更新）、${SERVICER}`, { exact: true })).toBeVisible();
  await expect(page.getByRole("table", { name: "関連する契約", exact: true })).toContainText("債務者");
  await page.getByRole("button", { name: "会社一覧へ戻る", exact: true }).click();
  await table.getByRole("row").filter({ hasText: "架空の未分類会社" }).click();
  await expect(page.getByText("未分類", { exact: true })).toBeVisible();
  expect(state.writes).toEqual([]);
});

test("create selects both initial classifications and a custom code from masters", async ({ page }) => {
  const state = await setup(page);
  await page.goto("/companies");
  const dialog = await openCreate(page);
  await dialog.getByRole("textbox", { name: "会社名", exact: true }).fill("架空の新規複合会社");
  await toggleCategories(page, dialog, [LAWYER, SERVICER, CUSTOM]);
  await dialog.getByRole("button", { name: "登録", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]).toMatchObject({
    method: "POST", path: "/api/companies",
    body: { company_name: "架空の新規複合会社", category_codes: ["lawyer", "servicer", "mediator"], status_flag: 0 },
  });
  const row = page.getByRole("table", { name: "会社一覧", exact: true }).getByRole("row")
    .filter({ hasText: "架空の新規複合会社" });
  await expect(row).toContainText(`${LAWYER}、${SERVICER}、${CUSTOM}`);
  await row.click();
  await expect(page.getByText(`${LAWYER}、${SERVICER}、${CUSTOM}`, { exact: true })).toBeVisible();
});

test("edit round-trips multiple values, removes one, and explicitly clears all", async ({ page }) => {
  const state = await setup(page);
  await page.goto("/companies/classified");
  let dialog = await openEdit(page);
  await expect(dialog.getByRole("combobox", { name: "会社分類", exact: true })).toHaveText(`${LAWYER}、${SERVICER}`);
  await saveEdit(dialog);
  expect(state.writes[0].body.category_codes).toEqual(["lawyer", "servicer"]);
  dialog = await openEdit(page);
  await toggleCategories(page, dialog, [LAWYER]);
  await saveEdit(dialog);
  expect(state.writes[1].body.category_codes).toEqual(["servicer"]);
  await expect(page.getByText(SERVICER, { exact: true })).toBeVisible();
  dialog = await openEdit(page);
  await toggleCategories(page, dialog, [SERVICER]);
  await saveEdit(dialog);
  expect(state.writes[2].body.category_codes).toEqual([]);
  await expect(page.getByText("未分類", { exact: true })).toBeVisible();
  dialog = await openEdit(page);
  const picker = dialog.getByRole("combobox", { name: "会社分類", exact: true });
  await picker.click();
  await expect(page.getByRole("menuitemcheckbox")).toHaveCount(3);
  await expect(page.getByRole("menuitemcheckbox", { checked: true })).toHaveCount(0);
  await picker.press("Escape");
  await dialog.getByRole("button", { name: "キャンセル", exact: true }).click();
});

test("inactive and orphan comma-containing codes survive edits and can be removed, not newly assigned", async ({ page }) => {
  const state = await setup(page);
  await page.goto("/companies/legacy");
  let dialog = await openEdit(page);
  await expect(dialog.getByText("無効・未登録の分類は、", { exact: false })).toBeVisible();
  await expect(dialog.getByRole("combobox", { name: "会社分類", exact: true }))
    .toHaveText(`旧事務所区分（無効・未登録）、${LEGACY}（無効・未登録）、${LAWYER}`);
  await dialog.getByRole("textbox", { name: "会社名", exact: true }).fill("架空の旧分類会社・編集");
  await saveEdit(dialog);
  expect(state.writes[0].body.category_codes).toEqual(["old-office", LEGACY, "lawyer"]);
  dialog = await openEdit(page);
  await toggleCategories(page, dialog, [`旧事務所区分（無効・未登録）`, `${LEGACY}（無効・未登録）`]);
  await saveEdit(dialog);
  expect(state.writes[1].body.category_codes).toEqual(["lawyer"]);
  await page.goto("/companies");
  dialog = await openCreate(page);
  const picker = dialog.getByRole("combobox", { name: "会社分類", exact: true });
  await expect(picker).toBeEnabled();
  await picker.click();
  await expect(page.getByRole("menuitemcheckbox")).toHaveCount(3);
  await expect(page.getByRole("menuitemcheckbox", { name: /旧事務所区分|legacy/ })).toHaveCount(0);
  await picker.press("Escape");
  await dialog.getByRole("button", { name: "キャンセル", exact: true }).click();
  await page.goto("/companies/unclassified");
  dialog = await openEdit(page);
  await expect(dialog.getByRole("combobox", { name: "会社分類", exact: true })).toBeEnabled();
  await dialog.getByRole("combobox", { name: "会社分類", exact: true }).click();
  await expect(page.getByRole("menuitemcheckbox")).toHaveCount(3);
  await expect(page.getByRole("menuitemcheckbox", { name: /旧事務所区分|legacy/ })).toHaveCount(0);
  await dialog.getByRole("combobox", { name: "会社分類", exact: true }).press("Escape");
  await saveEdit(dialog);
  expect(state.writes[2].body.category_codes).toEqual([]);
});

test("an empty active master is valid and existing inactive codes are not silently cleared", async ({ page }) => {
  const state = await setup(page);
  state.masters.forEach((master) => { master.is_active = false; });
  await page.goto("/companies/legacy");
  const dialog = await openEdit(page);
  await expect(dialog.getByRole("button", { name: "保存", exact: true })).toBeEnabled();
  const picker = dialog.getByRole("combobox", { name: "会社分類", exact: true });
  await picker.click();
  await expect(page.getByRole("menuitemcheckbox")).toHaveCount(3);
  await expect(page.getByRole("menuitemcheckbox", { name: `${SERVICER}（無効・未登録）`, exact: true })).toHaveCount(0);
  await picker.press("Escape");
  await saveEdit(dialog);
  expect(state.writes[0].body.category_codes).toEqual(["old-office", LEGACY, "lawyer"]);
});

for (const mode of ["create", "edit"] as const) {
  test(`${mode}: master error blocks submission and retry preserves form values and assignments`, async ({ page }) => {
    const state = await setup(page);
    state.masterFailure = true;
    await page.goto(mode === "create" ? "/companies" : "/companies/legacy");
    const dialog = mode === "create" ? await openCreate(page) : await openEdit(page);
    const save = dialog.getByRole("button", { name: mode === "create" ? "登録" : "保存", exact: true });
    const picker = dialog.getByRole("combobox", { name: "会社分類", exact: true });
    await expect(dialog.getByText("会社分類を読み込めませんでした。", { exact: false })).toBeVisible();
    await dialog.getByRole("textbox", { name: "会社名", exact: true }).fill("再試行中の架空会社");
    await expect(save).toBeDisabled();
    await expect(picker).toBeDisabled();
    await save.evaluate((element) => (element as HTMLButtonElement).click());
    expect(state.writes).toEqual([]);
    const pending = deferred();
    state.masterFailure = false;
    state.masterGate = pending.promise;
    const beforeRetry = state.masterRequests;
    await dialog.getByRole("button", { name: "再試行", exact: true }).click();
    await expect.poll(() => state.masterRequests).toBeGreaterThan(beforeRetry);
    await expect(dialog.getByText("会社分類を読み込み中…", { exact: true })).toBeVisible();
    await expect(save).toBeDisabled();
    pending.resolve();
    await expect(save).toBeEnabled();
    await expect(dialog.getByRole("textbox", { name: "会社名", exact: true })).toHaveValue("再試行中の架空会社");
    await save.click();
    await expect(dialog).toHaveCount(0);
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0].body.category_codes).toEqual(mode === "create" ? [] : ["old-office", LEGACY, "lawyer"]);
  });
}

test("save errors retain input and selected classifications; pending saves cannot submit twice or close", async ({ page }) => {
  const state = await setup(page);
  state.saveFailures = 1;
  await page.goto("/companies/classified");
  const dialog = await openEdit(page);
  await dialog.getByRole("textbox", { name: "会社名", exact: true }).fill("保存再試行の架空会社");
  await toggleCategories(page, dialog, [CUSTOM]);
  const save = dialog.getByRole("button", { name: "保存", exact: true });
  await save.click();
  await expect(dialog.getByText("会社情報を保存できません", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "会社名", exact: true })).toHaveValue("保存再試行の架空会社");
  await expect(dialog.getByRole("combobox", { name: "会社分類", exact: true })).toHaveText(`${LAWYER}、${SERVICER}、${CUSTOM}`);
  const pending = deferred();
  state.saveGate = pending.promise;
  await save.evaluate((element) => {
    (element as HTMLButtonElement).click();
    (element as HTMLButtonElement).click();
  });
  await expect.poll(() => state.writes.length).toBe(2);
  await expect(dialog.getByRole("button", { name: "キャンセル", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  pending.resolve();
  await expect(dialog).toHaveCount(0);
  expect(state.writes).toHaveLength(2);
  expect(state.writes[1].body).toEqual(state.writes[0].body);
  await expect(page.getByText("保存再試行の架空会社", { exact: true })).toBeVisible();
});

for (const staleFailure of [false, true]) {
  test(`closed dialogs ignore late ${staleFailure ? "failed" : "successful"} master requests after reopening`, async ({ page }) => {
    const state = await setup(page);
    const old = deferred();
    state.masterGate = old.promise;
    state.masterFailure = staleFailure;
    await page.goto("/companies");
    let dialog = await openCreate(page);
    await expect.poll(() => state.masterRequests).toBeGreaterThan(0);
    await expect(dialog.getByRole("button", { name: "登録", exact: true })).toBeDisabled();
    await dialog.getByRole("button", { name: "キャンセル", exact: true }).click();
    state.masterGate = null;
    state.masterFailure = false;
    state.masters[0].label = "最新の法律事務所分類";
    dialog = await openCreate(page);
    const picker = dialog.getByRole("combobox", { name: "会社分類", exact: true });
    await expect(picker).toBeEnabled();
    await dialog.getByRole("textbox", { name: "会社名", exact: true }).fill("最新の架空会社");
    await toggleCategories(page, dialog, ["最新の法律事務所分類"]);
    old.resolve();
    await expect.poll(() => state.masterCompleted).toBe(state.masterRequests);
    await expect(picker).toHaveText("最新の法律事務所分類");
    await expect(dialog.getByText("会社分類を読み込めませんでした。", { exact: false })).toHaveCount(0);
    await dialog.getByRole("button", { name: "登録", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(state.writes[0].body).toMatchObject({ company_name: "最新の架空会社", category_codes: ["lawyer"] });
  });
}

test("admin creates a custom company classification that the company form can use", async ({ page }) => {
  const state = await setup(page);
  await page.goto("/admin");
  await page.getByRole("tab", { name: /^コードマスタ/ }).click();
  await expect(page.getByText("使用中の会社分類は削除・コード変更・分類の種別変更ができません。", { exact: false })).toBeVisible();
  const section = page.locator("div").filter({ has: page.getByRole("table", { name: "会社の分類", exact: true }) })
    .filter({ has: page.getByRole("button", { name: "追加", exact: true }) }).last();
  await section.getByRole("button", { name: "追加", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "「会社の分類」に区分を追加", exact: true });
  await expect(dialog.getByRole("combobox", { name: "分類の種別", exact: true })).toHaveText("会社の分類");
  await dialog.getByRole("textbox", { name: "コード（英数字の識別子）", exact: true }).fill("consultant");
  await dialog.getByRole("textbox", { name: "表示名（画面に出る名前）", exact: true }).fill("独自の相談支援会社");
  await dialog.getByRole("spinbutton").fill("10");
  await dialog.getByRole("button", { name: "登録する", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(state.masterWrites).toEqual([{
    category: "company_category", code: "consultant", label: "独自の相談支援会社", sort_order: 10, is_active: true,
  }]);
  await expect(page.getByRole("table", { name: "会社の分類", exact: true })).toContainText("独自の相談支援会社");
  await page.goto("/companies");
  const create = await openCreate(page);
  await create.getByRole("textbox", { name: "会社名", exact: true }).fill("架空の相談会社");
  await toggleCategories(page, create, ["独自の相談支援会社"]);
  await create.getByRole("button", { name: "登録", exact: true }).click();
  await expect(create).toHaveCount(0);
  expect(state.writes[0].body.category_codes).toEqual(["consultant"]);
});
