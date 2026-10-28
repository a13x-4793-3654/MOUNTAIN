import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Teams manifest exposes only the connection-check bot and required template variables", async () => {
  const source = await readFile(new URL("../appPackage/manifest.json", import.meta.url), "utf8");
  const manifest = JSON.parse(source);
  const variables = [...source.matchAll(/\$\{\{(\w+)\}\}/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(variables)].sort(), ["BOT_DOMAIN", "CLIENT_ID", "TEAMS_APP_ID"]);
  assert.equal(manifest.bots.length, 1);
  assert.deepEqual(manifest.bots[0].scopes, ["personal", "team", "groupChat"]);
  assert.equal(manifest.supportsChannelFeatures, "tier1");
  assert.deepEqual(manifest.bots[0].commandLists[0].commands.map((command) => command.title), ["ping", "help"]);
  assert.equal(manifest.bots[0].supportsFiles, false);
  assert.equal(manifest.webApplicationInfo, undefined);
  assert.equal(manifest.authorization, undefined);
});

test("Teams app icons have the required PNG dimensions and transparent-capable outline format", async () => {
  for (const [name, size] of [["color.png", 192], ["outline.png", 32]]) {
    const png = await readFile(new URL(`../appPackage/${name}`, import.meta.url));
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
    assert.equal(png[25], 6);
  }
});

test("Toolkit lifecycle is limited to local packaging", async () => {
  const yaml = await readFile(new URL("../m365agents.yml", import.meta.url), "utf8");
  const actions = [...yaml.matchAll(/^\s+- uses: (\S+)/gm)].map((match) => match[1]);
  assert.deepEqual(actions, ["teamsApp/zipAppPackage"]);
  assert.doesNotMatch(yaml, /^(deploy|publish):/m);
});
