import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), "utf8");

test("hitl-open defaults the share server to localhost and supports explicit bind/public hosts", () => {
  const openScript = read("tools/browser-hitl/hitl-open.sh");

  assert.match(openScript, /BROWSER_HANDOFF_BIND_HOST:-127\.0\.0\.1/);
  assert.match(openScript, /BROWSER_HANDOFF_PUBLIC_HOST:-127\.0\.0\.1/);
  assert.match(openScript, /--bind-tcp=\$\{BIND_HOST\}:\$\{PORT\}/);
  assert.doesNotMatch(openScript, /--bind-tcp=0\.0\.0\.0:\$\{PORT\}/);
});

test("hitl-open protects the xpra html endpoint with a per-session password file", () => {
  const openScript = read("tools/browser-hitl/hitl-open.sh");

  assert.match(openScript, /XPRA_PASSWORD=.*openssl rand/);
  assert.match(openScript, /BROWSER_HANDOFF_XPRA_PASSWORD/);
  assert.match(openScript, /xpra-password\.txt/);
  assert.match(openScript, /chmod 600/);
  assert.match(openScript, /auth=file,filename=\$\{XPRA_PASSWORD_FILE\}/);
  assert.match(openScript, /xpra_password/);
});

test("hitl-open launches Chromium through a wrapper so target URLs are not shell-interpolated", () => {
  const openScript = read("tools/browser-hitl/hitl-open.sh");

  assert.match(openScript, /start-chromium\.sh/);
  assert.match(openScript, /exec "\$CHROMIUM_BIN"/);
  assert.match(openScript, /"\$TARGET_URL"/);
  assert.doesNotMatch(openScript, /CHROMIUM_CMD="\$\{CHROMIUM_BIN\}[\s\S]*\$\{TARGET_URL\}"/);
});

test("close and cleanup terminate recorded Chromium child processes in addition to xpra", () => {
  const closeScript = read("tools/browser-hitl/hitl-close.sh");
  const cleanupScript = read("tools/browser-hitl/hitl-cleanup.sh");

  for (const script of [closeScript, cleanupScript]) {
    assert.match(script, /chromium_pid/);
    assert.match(script, /kill .*CHROMIUM_PID/);
  }
});

test("environment examples and setup docs use only the Browser Handoff variable prefix", () => {
  const envExample = read(".env.hitl.example");
  const setupScript = read("tools/browser-hitl/setup.sh");
  const openScript = read("tools/browser-hitl/hitl-open.sh");
  const libScript = read("tools/browser-hitl/hitl-lib.sh");

  for (const content of [envExample, setupScript, openScript, libScript]) {
    assert.match(content, /BROWSER_HANDOFF_/);
    assert.doesNotMatch(content, /HERMES_HITL_|OPENCLAW_/);
  }
});
