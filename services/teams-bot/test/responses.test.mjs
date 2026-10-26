import assert from "node:assert/strict";
import test from "node:test";
import { createReply } from "../dist/responses.js";

test("ping and help accept surrounding whitespace, slash prefixes, and letter case", () => {
  for (const text of ["ping", "/ping", " PING ", "\n/PiNg\n"]) {
    assert.equal(createReply(text), "pong");
  }
  for (const text of ["help", "/HELP", "", " \n "]) {
    assert.match(createReply(text), /接続確認用 Bot/);
    assert.match(createReply(text), /まだ対応していません/);
  }
});

test("ordinary text is echoed without interpreting it as a command", () => {
  assert.equal(createReply("  hello  "), "受信しました:\nhello");
  assert.equal(createReply("ping extra"), "受信しました:\nping extra");
  assert.equal(createReply("<b>hello</b>"), "受信しました:\n<b>hello</b>");
});

test("echo limits are enforced at 2000 Unicode code points without breaking emoji", () => {
  const full = "🏔".repeat(2000);
  assert.equal(createReply(full), `受信しました:\n${full}`);
  assert.equal(createReply(`${full}x`), `受信しました:\n${full}\n（先頭 2,000 文字のみ表示）`);
});
