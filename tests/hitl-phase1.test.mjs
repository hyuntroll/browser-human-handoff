import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const toolsDir = path.join(repoRoot, "tools", "browser-hitl");
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), "utf8");

function listToolFiles() {
  return fs
    .readdirSync(toolsDir)
    .filter((name) => name.endsWith(".mjs") || name.endsWith(".sh"))
    .map((name) => ({
      name,
      content: fs.readFileSync(path.join(toolsDir, name), "utf8"),
    }));
}

test("xpra is never bound to TCP in tools/browser-hitl", () => {
  for (const file of listToolFiles()) {
    assert.doesNotMatch(
      file.content,
      /--bind-tcp/,
      `${file.name} must not use --bind-tcp`,
    );
  }
});

test("hitl-browser launches Chromium with --remote-debugging-port=0 on 127.0.0.1", () => {
  const browserScript = read("tools/browser-hitl/hitl-browser.mjs");

  assert.match(browserScript, /--remote-debugging-port=0/);
  assert.match(browserScript, /--remote-debugging-address=127\.0\.0\.1/);
});

test("session writes never include xpra_password", () => {
  for (const file of listToolFiles()) {
    assert.doesNotMatch(
      file.content,
      /xpra_password/,
      `${file.name} must not write or reference xpra_password`,
    );
  }
});

test("environment examples and setup docs use only the Browser Handoff variable prefix", () => {
  const envExample = read(".env.hitl.example");
  const setupScript = read("tools/browser-hitl/setup.sh");

  for (const content of [envExample, setupScript]) {
    assert.match(content, /BROWSER_HANDOFF_/);
    assert.doesNotMatch(content, /HERMES_HITL_|OPENCLAW_/);
  }
});
