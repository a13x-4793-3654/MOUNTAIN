import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createContractSearchHandler, parseContractCommand } from "../dist/contract-search.js";

const tenantId = randomUUID();
const userId = randomUUID();
const config = { apiBaseUrl: "https://mountain.example.test", connectionName: "mountain-api", tenantId };
const token = [
  Buffer.from('{"alg":"none"}').toString("base64url"),
  Buffer.from(JSON.stringify({ oid: userId, tid: tenantId, scp: "access_as_user" })).toString("base64url"),
  "",
].join(".");

function fixture(options = {}) {
  const sent = [];
  const logs = [];
  const calls = { registered: 0, signIn: 0, signOut: 0 };
  const flow = {
    onSignInComplete(handler) { this.complete = handler; return this; },
    onSignInFailure(handler) { this.fail = handler; return this; },
    async signIn() { calls.signIn++; return options.token; },
    async signOut() { calls.signOut++; },
  };
  const app = {
    addOAuthFlow(name) {
      assert.equal(name, "mountain-api");
      calls.registered++;
      return flow;
    },
  };
  const context = {
    activity: {
      conversation: { conversationType: options.conversationType ?? "personal" },
      from: { id: "teams-test-user", aadObjectId: options.missingUser ? undefined : userId },
    },
    log: { error: (...args) => logs.push(args.join(" ")) },
    send: async (message) => { sent.push(message); },
  };
  return { app, context, flow, calls, sent, logs };
}

test("contract commands require a delimiter and support Japanese, case, and slash prefixes", () => {
  for (const text of ["契約検索 山田", "/契約検索　山田", " /SeArCh 山田 "]) {
    assert.deepEqual(parseContractCommand(text), { kind: "search", query: "山田" });
  }
  assert.deepEqual(parseContractCommand("search"), { kind: "search", query: "" });
  assert.deepEqual(parseContractCommand("/ログアウト"), { kind: "signout" });
  assert.deepEqual(parseContractCommand("SIGNOUT"), { kind: "signout" });
  assert.equal(parseContractCommand("searching"), undefined);
  assert.equal(parseContractCommand("ordinary text"), undefined);
});

test("disabled search registers no OAuth flow and reports configuration explicitly", async () => {
  const f = fixture();
  const handle = createContractSearchHandler(f.app);
  assert.equal(await handle(f.context, "ping"), false);
  assert.equal(await handle(f.context, "search 山田"), true);
  assert.equal(f.calls.registered, 0);
  assert.match(f.sent[0].text, /接続設定が未完了/);
  assert.equal(f.sent[0].textFormat, "plain");
});

test("channels and group chats cannot start OAuth or retrieve contract data", async () => {
  for (const conversationType of ["channel", "groupChat", "unknown"]) {
    const f = fixture({ conversationType });
    const handle = createContractSearchHandler(f.app, config);
    for (const text of ["search secret-contract", "signout"]) {
      await handle(f.context, text);
    }
    assert.equal(f.calls.signIn, 0);
    assert.equal(f.calls.signOut, 0);
    assert.ok(f.sent.every((message) => /個人チャット/.test(message.text) && !message.text.includes("secret-contract")));
  }
});

test("invalid queries and missing sender identity cannot start sign-in", async () => {
  const f = fixture();
  const handle = createContractSearchHandler(f.app, config);
  await handle(f.context, "search");
  await handle(f.context, `search ${"x".repeat(201)}`);
  assert.equal(f.calls.signIn, 0);
  assert.ok(f.sent.every((message) => /1〜200文字/.test(message.text)));
  const missing = fixture({ missingUser: true });
  await createContractSearchHandler(missing.app, config)(missing.context, "search query");
  assert.equal(missing.calls.signIn, 0);
  assert.match(missing.sent[0].text, /ユーザーを確認できない/);
});

test("a newly initiated sign-in does not query data or persist the search", async (t) => {
  const f = fixture();
  const request = t.mock.method(globalThis, "fetch", async () => { throw new Error("No request expected"); });
  await createContractSearchHandler(f.app, config)(f.context, "search private-query");
  assert.equal(f.calls.signIn, 1);
  assert.equal(request.mock.callCount(), 0);
  assert.equal(f.sent.length, 0);
  await f.flow.complete(f.context, { token: "never-print-token" });
  assert.match(f.sent[0].text, /もう一度/);
  assert.doesNotMatch(f.sent[0].text, /private-query|never-print-token/);
});

test("signed-in search sends only authorized plain-text summaries", async (t) => {
  const f = fixture({ token });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => Response.json(++calls === 1
    ? { auth_enabled: true, entra: { tenant_id: tenantId } }
    : { total: 1, items: [{
      id: randomUUID(), contract_no: "C-42", contract_summary: "検証契約",
      company_name: null, person_name: null, contract_status: "active", status_label: "有効",
      account_no: "never-print-account",
    }] }));
  await createContractSearchHandler(f.app, config)(f.context, "search query");
  assert.equal(calls, 2);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].textFormat, "plain");
  assert.match(f.sent[0].text, /C-42/);
  assert.doesNotMatch(f.sent[0].text, /never-print-account|access_as_user/);
  assert.equal(f.logs.length, 0);
});

test("permission denial is surfaced without results, search terms, or tokens in logs", async (t) => {
  const f = fixture({ token });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => ++calls === 1
    ? Response.json({ auth_enabled: true, entra: { tenant_id: tenantId } })
    : new Response("private upstream error", { status: 403 }));
  await createContractSearchHandler(f.app, config)(f.context, "search private-query");
  assert.match(f.sent[0].text, /閲覧する権限がありません/);
  assert.doesNotMatch(f.sent[0].text, /該当する契約はありません|private upstream/);
  assert.equal(f.logs.length, 1);
  assert.doesNotMatch(f.logs.join("\n"), /private-query|access_as_user|private upstream/);
});

test("sign-out revokes only the configured connection and OAuth failures are visible", async () => {
  const f = fixture();
  const handle = createContractSearchHandler(f.app, config);
  await handle(f.context, "ログアウト");
  assert.equal(f.calls.signOut, 1);
  assert.equal(f.calls.signIn, 0);
  assert.match(f.sent[0].text, /サインアウトしました/);
  await f.flow.fail(f.context, { message: "do-not-print-failure-details" });
  assert.match(f.sent[1].text, /サインインできませんでした/);
  assert.doesNotMatch(JSON.stringify(f.sent) + f.logs.join("\n"), /do-not-print-failure-details/);
});

test("unexpected OAuth errors are reported without logging exception messages or tokens", async () => {
  const f = fixture();
  f.flow.signIn = async () => { throw new Error(`sensitive-exception ${token}`); };
  await createContractSearchHandler(f.app, config)(f.context, "search private-query");
  assert.match(f.sent[0].text, /連携でエラーが発生/);
  assert.doesNotMatch(JSON.stringify(f.sent) + f.logs.join("\n"), /sensitive-exception|access_as_user|private-query/);
});
