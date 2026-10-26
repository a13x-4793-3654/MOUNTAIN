import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { App, ExpressAdapter } from "@microsoft/teams.apps";
import { ConsoleLogger } from "@microsoft/teams.common";
import { configureRoutes, createBot } from "../dist/app.js";

const directory = fileURLToPath(new URL("../", import.meta.url));
const config = {
  clientId: randomUUID(),
  clientSecret: randomBytes(32).toString("base64url"),
  tenantId: randomUUID(),
  port: 3978,
};

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function activity(overrides = {}) {
  return {
    type: "typing",
    id: randomUUID(),
    channelId: "msteams",
    serviceUrl: "https://smba.trafficmanager.net/teams",
    from: { id: "test-user", name: "Test user" },
    recipient: { id: `28:${config.clientId}`, name: "MOUNTAIN Bot" },
    conversation: {
      id: "test-conversation",
      conversationType: "personal",
      tenantId: config.tenantId,
    },
    channelData: { tenant: { id: config.tenantId } },
    ...overrides,
  };
}

test("HTTP exposes health and information pages but rejects unauthenticated activities", async (t) => {
  const server = createServer();
  const app = createBot(config, server);
  await app.initialize();
  const url = await listen(server);
  t.after(() => app.stop());

  const health = await fetch(`${url}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });
  assert.equal(health.headers.get("cache-control"), "no-store");
  assert.equal(health.headers.get("x-powered-by"), null);
  for (const path of ["/", "/privacy", "/terms"]) {
    const page = await fetch(`${url}${path}`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type"), /text\/html; charset=utf-8/);
    assert.match(await page.text(), /MOUNTAIN Teams Bot/);
  }

  for (const authorization of [undefined, "Bearer not-a-jwt"]) {
    const response = await fetch(`${url}/api/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authorization ? { Authorization: authorization } : {}),
      },
      body: JSON.stringify(activity()),
    });
    assert.equal(response.status, 401);
  }
});

test("production ignores the SDK environment variable for bypassing authentication", () => {
  const previous = process.env.DANGEROUSLY_ALLOW_UNAUTHENTICATED_REQUESTS;
  try {
    process.env.DANGEROUSLY_ALLOW_UNAUTHENTICATED_REQUESTS = "true";
    const app = createBot(config);
    assert.equal(app.options.dangerouslyAllowUnauthenticatedRequests, false);
  } finally {
    if (previous === undefined) delete process.env.DANGEROUSLY_ALLOW_UNAUTHENTICATED_REQUESTS;
    else process.env.DANGEROUSLY_ALLOW_UNAUTHENTICATED_REQUESTS = previous;
  }
});

test("authenticated activity routing accepts only Teams activities in the configured tenant", async () => {
  const app = createBot(config);
  await app.initialize();
  const token = {
    appId: config.clientId,
    from: "azure",
    fromId: config.clientId,
    serviceUrl: "https://smba.trafficmanager.net/teams",
    isExpired: () => false,
  };
  const foreignTenant = randomUUID();
  const cases = [
    [activity(), 200],
    [activity({ channelData: undefined }), 200],
    [activity({ channelData: { tenant: { id: config.tenantId.toUpperCase() } } }), 200],
    [activity({ channelId: "emulator" }), 403],
    [activity({ channelData: { tenant: { id: foreignTenant } } }), 403],
    [activity({ conversation: { id: "test", tenantId: foreignTenant } }), 403],
    [activity({ channelData: undefined, conversation: { id: "test" } }), 403],
  ];
  for (const [body, status] of cases) {
    const response = await app.process({ body, token });
    assert.equal(response.status, status);
  }
});

test("local round trip strips the bot mention and replies as plain text in the original thread", async (t) => {
  const sent = [];
  const connector = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    sent.push({ path: request.url, body: JSON.parse(Buffer.concat(chunks).toString()) });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ id: randomUUID() }));
  });
  const serviceUrl = await listen(connector);
  t.after(() => new Promise((resolve) => connector.close(resolve)));

  const server = createServer();
  const logger = new ConsoleLogger("test-bot", { level: "error" });
  const adapter = new ExpressAdapter(server, { logger });
  const app = new App({
    httpServerAdapter: adapter,
    dangerouslyAllowUnauthenticatedRequests: true,
    logger,
  });
  configureRoutes(app, adapter);
  await app.initialize();
  const url = await listen(server);
  t.after(() => app.stop());

  const threadId = randomUUID();
  const body = activity({
    type: "message",
    text: "<at>MOUNTAIN Bot</at> <b>hello</b>",
    serviceUrl,
    conversation: { id: `channel-conversation;messageid=${threadId}`, conversationType: "channel" },
    replyToId: threadId,
    entities: [{
      type: "mention",
      text: "<at>MOUNTAIN Bot</at>",
      mentioned: { id: `28:${config.clientId}`, name: "MOUNTAIN Bot" },
    }],
  });
  const response = await fetch(`${url}/api/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.text, "受信しました:\n<b>hello</b>");
  assert.equal(sent[0].body.textFormat, "plain");
  assert.match(decodeURIComponent(sent[0].path), new RegExp(`messageid=${threadId}`));
});

test("the production entry point fails closed when credentials are missing", () => {
  const result = spawnSync(process.execPath, ["dist/index.js"], {
    cwd: directory,
    env: {
      ...process.env,
      CLIENT_ID: "",
      CLIENT_SECRET: "",
      TENANT_ID: "",
      DANGEROUSLY_ALLOW_UNAUTHENTICATED_REQUESTS: "true",
    },
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /CLIENT_ID is required/);
});

test("the Playground entry point cannot start in production", () => {
  const result = spawnSync(process.execPath, ["dist/playground.js"], {
    cwd: directory,
    env: { ...process.env, NODE_ENV: "production" },
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /disabled in production/);
});
