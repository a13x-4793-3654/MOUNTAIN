import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { readConfig, readPort } from "../dist/config.js";

const credentials = () => ({
  CLIENT_ID: randomUUID(),
  CLIENT_SECRET: randomBytes(32).toString("base64url"),
  TENANT_ID: randomUUID(),
});

test("runtime requires all three credentials without printing their values", () => {
  for (const name of ["CLIENT_ID", "CLIENT_SECRET", "TENANT_ID"]) {
    const env = credentials();
    env[name] = " ";
    assert.throws(() => readConfig(env), new RegExp(`${name} is required`));
  }
});

test("runtime validates GUIDs and normalizes IDs without changing the secret", () => {
  const env = credentials();
  env.CLIENT_ID = env.CLIENT_ID.toUpperCase();
  env.TENANT_ID = env.TENANT_ID.toUpperCase();
  env.CLIENT_SECRET = ` ${env.CLIENT_SECRET} `;
  assert.deepEqual(readConfig(env), {
    clientId: env.CLIENT_ID.toLowerCase(),
    clientSecret: env.CLIENT_SECRET,
    tenantId: env.TENANT_ID.toLowerCase(),
    port: 3978,
  });
  for (const name of ["CLIENT_ID", "TENANT_ID"]) {
    assert.throws(() => readConfig({ ...env, [name]: "invalid" }), new RegExp(`${name} must be a GUID`));
  }
});

test("PORT accepts only valid TCP port numbers", () => {
  assert.equal(readPort({}), 3978);
  assert.equal(readPort({ PORT: "1" }), 1);
  assert.equal(readPort({ PORT: "65535" }), 65535);
  for (const value of ["", "0", "-1", "65536", "3.5", "1e3", " 3978", "abc"]) {
    assert.throws(() => readPort({ PORT: value }), /PORT must be an integer/);
  }
});

test("contract search is disabled unless both optional settings are supplied", () => {
  const env = credentials();
  assert.equal(readConfig({ ...env, MOUNTAIN_API_BASE_URL: "", MOUNTAIN_OAUTH_CONNECTION_NAME: "" }).contractSearch, undefined);
  assert.throws(() => readConfig({ ...env, MOUNTAIN_API_BASE_URL: "https://mountain.example.test" }),
    /MOUNTAIN_OAUTH_CONNECTION_NAME is required/);
  assert.throws(() => readConfig({ ...env, MOUNTAIN_OAUTH_CONNECTION_NAME: "mountain-api" }),
    /MOUNTAIN_API_BASE_URL is required/);
});

test("contract search accepts only an explicit HTTPS origin and a valid connection name", () => {
  const env = { ...credentials(), MOUNTAIN_API_BASE_URL: "https://MOUNTAIN.example.test/", MOUNTAIN_OAUTH_CONNECTION_NAME: "mountain-api" };
  assert.deepEqual(readConfig(env).contractSearch, {
    apiBaseUrl: "https://mountain.example.test",
    connectionName: "mountain-api",
    tenantId: env.TENANT_ID.toLowerCase(),
  });
  for (const value of ["not a url", "http://mountain.example.test", "https://user:password@mountain.example.test",
    "https://mountain.example.test/api", "https://mountain.example.test/?token=secret", "https://mountain.example.test/#fragment"]) {
    assert.throws(() => readConfig({ ...env, MOUNTAIN_API_BASE_URL: value }), /MOUNTAIN_API_BASE_URL must be an HTTPS origin/);
  }
  assert.throws(() => readConfig({ ...env, MOUNTAIN_OAUTH_CONNECTION_NAME: "invalid connection" }),
    /MOUNTAIN_OAUTH_CONNECTION_NAME must contain/);
});
