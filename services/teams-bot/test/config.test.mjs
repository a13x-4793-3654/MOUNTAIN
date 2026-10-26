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
