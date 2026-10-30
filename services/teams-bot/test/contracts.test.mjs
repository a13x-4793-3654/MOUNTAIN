import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { MountainApiError, MountainContractsClient, validateContractQuery } from "../dist/contracts.js";

const tenantId = randomUUID();
const userId = randomUUID();
const config = { apiBaseUrl: "https://mountain.example.test", connectionName: "mountain-api", tenantId };
const authConfig = () => ({ auth_enabled: true, entra: { tenant_id: tenantId } });
const token = (claims = {}) => [
  Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
  Buffer.from(JSON.stringify({ oid: userId, tid: tenantId, scp: "access_as_user", ...claims })).toString("base64url"),
  "",
].join(".");
const item = () => ({
  id: randomUUID(), contract_no: "C-001", contract_summary: "契約の概要",
  company_name: "検証用会社", person_name: "架空名義", contract_status: "active", status_label: "有効",
  account_no: "never-expose-account", cti_password: "never-expose-password",
});
const isCode = (code) => (error) => error instanceof MountainApiError && error.code === code;

test("contract search uses the caller token only for the existing bounded read-only API", async () => {
  const calls = [];
  const row = item();
  const userToken = token();
  const client = new MountainContractsClient(config, async (url, options) => {
    calls.push({ url: new URL(url), options });
    return Response.json(calls.length === 1 ? authConfig() : { total: 1, items: [row] });
  });
  const result = await client.search("  山田 & 会社  ", userToken, userId);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.pathname, "/api/config");
  assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.equal(calls[1].url.origin, config.apiBaseUrl);
  assert.equal(calls[1].url.pathname, "/api/contracts");
  assert.equal(calls[1].url.searchParams.get("q"), "山田 & 会社");
  assert.equal(calls[1].url.searchParams.get("limit"), "5");
  assert.equal(calls[1].url.searchParams.get("offset"), "0");
  assert.equal(calls[1].options.headers.Authorization, `Bearer ${userToken}`);
  assert.ok(calls.every(({ options }) => options.method === "GET" && options.redirect === "error" && options.signal));
  assert.equal(result.items[0].contractNo, row.contract_no);
  const message = client.format(result);
  assert.match(message, /C-001.*契約の概要/);
  assert.match(message, new RegExp(`/contracts/${row.id}`));
  assert.doesNotMatch(message, /never-expose|Bearer|access_as_user/);
});

test("query limits count Unicode code points and reject empty or oversized queries", async () => {
  assert.equal(validateContractQuery(" 🏔 "), "🏔");
  assert.equal(validateContractQuery("🏔".repeat(200)).length, 400);
  assert.throws(() => validateContractQuery("🏔".repeat(201)), RangeError);
  let calls = 0;
  const client = new MountainContractsClient(config, async () => { calls++; throw new Error("No request expected"); });
  for (const query of ["", "  ", "x".repeat(201)]) {
    await assert.rejects(client.search(query, token(), userId), RangeError);
  }
  assert.equal(calls, 0);
});

test("only the same delegated user and tenant can reach the MOUNTAIN API", async () => {
  let calls = 0;
  const client = new MountainContractsClient(config, async () => { calls++; throw new Error("No request expected"); });
  for (const value of ["invalid", "a.?.c", token({ oid: randomUUID() }), token({ tid: randomUUID() }),
    token({ scp: "" }), token({ scp: undefined, roles: ["Application.Permission"] })]) {
    await assert.rejects(client.search("query", value, userId), isCode("unauthorized"));
  }
  await assert.rejects(client.search("query", token(), "not-an-object-id"), isCode("unauthorized"));
  assert.equal(calls, 0);
});

test("development authentication, missing auth configuration, and other tenants fail closed", async () => {
  for (const value of [{ auth_enabled: false }, {}, { auth_enabled: true, entra: { tenant_id: randomUUID() } }]) {
    let calls = 0;
    const client = new MountainContractsClient(config, async () => {
      calls++;
      return Response.json(value);
    });
    await assert.rejects(client.search("query", token(), userId), isCode("unsafe_configuration"));
    assert.equal(calls, 1);
  }
});

test("permission, authentication, and server failures are not reported as zero results or retried", async () => {
  for (const [status, code] of [[401, "unauthorized"], [403, "forbidden"], [500, "unavailable"]]) {
    let calls = 0;
    const client = new MountainContractsClient(config, async () => {
      calls++;
      return calls === 1 ? Response.json(authConfig()) : new Response("private diagnostics", { status });
    });
    await assert.rejects(client.search("query", token(), userId), isCode(code));
    assert.equal(calls, 2);
  }
});

test("public configuration failures and redirect/network failures do not expose credentials", async () => {
  const forbidden = new MountainContractsClient(config, async () => new Response("", { status: 403 }));
  await assert.rejects(forbidden.search("query", token(), userId), isCode("unavailable"));
  const redirected = new MountainContractsClient(config, async (_url, options) => {
    assert.equal(options.redirect, "error");
    throw new TypeError("fetch failed: redirect");
  });
  await assert.rejects(redirected.search("query", token(), userId), isCode("unavailable"));
});

test("a bounded deadline is propagated and surfaced as a timeout", async (t) => {
  const expired = AbortSignal.abort(new DOMException("Expired", "TimeoutError"));
  t.mock.method(AbortSignal, "timeout", () => expired);
  const client = new MountainContractsClient(config, async (_url, options) => { throw options.signal.reason; });
  await assert.rejects(client.search("query", token(), userId), isCode("timeout"));
});

test("invalid response shapes and unsafe detail IDs are rejected", async () => {
  const valid = item();
  const cases = [
    { total: "1", items: [valid] }, { total: -1, items: [] }, { total: 1, items: [] },
    { total: 0, items: [valid] }, { total: 6, items: Array.from({ length: 6 }, item) },
    { total: 1, items: [{ ...valid, id: "../../private" }] },
    { total: 1, items: [{ ...valid, person_name: {} }] },
  ];
  for (const value of cases) {
    let calls = 0;
    const client = new MountainContractsClient(config, async () => Response.json(++calls === 1 ? authConfig() : value));
    await assert.rejects(client.search("query", token(), userId), isCode("invalid_response"));
  }
});

test("HTML, malformed JSON, and oversized upstream bodies are rejected", async () => {
  for (const response of [
    new Response("<html>sign in</html>", { headers: { "content-type": "text/html" } }),
    new Response("{", { headers: { "content-type": "application/json" } }),
    new Response(JSON.stringify({ padding: "x".repeat(65536) }), { headers: { "content-type": "application/json" } }),
  ]) {
    const client = new MountainContractsClient(config, async () => response);
    await assert.rejects(client.search("query", token(), userId), isCode("invalid_response"));
  }
});

test("zero results are explicit and long field values cannot create extra message lines", async () => {
  let calls = 0;
  const client = new MountainContractsClient(config, async () => Response.json(++calls === 1 ? authConfig() : { total: 0, items: [] }));
  assert.equal(client.format(await client.search("none", token(), userId)), "該当する契約はありませんでした。");
  const rendered = client.format({ total: 8, items: [{
    id: randomUUID(), contractNo: "C-1\nforged", summary: "🏔".repeat(1000),
    companyName: null, personName: null, status: "active",
  }] });
  assert.doesNotMatch(rendered, /C-1\nforged/);
  assert.match(rendered, /C-1 forged/);
  assert.ok(rendered.length < 1000);
  assert.match(rendered, /残りの契約/);
});
