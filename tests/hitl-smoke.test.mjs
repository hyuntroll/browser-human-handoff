import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, chmod, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const repoRoot = process.cwd();

async function makeExecutable(filePath, contents) {
  await writeFile(filePath, contents, "utf8");
  await chmod(filePath, 0o755);
}

async function createMockCommands(rootDir) {
  const binDir = path.join(rootDir, "mock-bin");
  await mkdir(binDir, { recursive: true });

  await makeExecutable(
    path.join(binDir, "chromium"),
    `#!/usr/bin/env bash
set -euo pipefail
exit 0
`,
  );

  await makeExecutable(
    path.join(binDir, "xpra"),
    `#!/usr/bin/env bash
set -euo pipefail

LOG_DIR="\${MOCK_LOG_DIR:?mock log dir required}"
mkdir -p "\${LOG_DIR}"

COMMAND="\${1:-}"
shift || true

printf '%s\\n' "\${COMMAND}" >> "\${LOG_DIR}/xpra-commands.log"

case "\${COMMAND}" in
  start)
    printf '%s\\0' "$@" > "\${LOG_DIR}/xpra-start.args"
    exit 0
    ;;
  stop)
    printf '%s\\0' "$@" > "\${LOG_DIR}/xpra-stop.args"
    exit 0
    ;;
  *)
    echo "unexpected xpra command: \${COMMAND}" >&2
    exit 1
    ;;
esac
`,
  );

  await makeExecutable(
    path.join(binDir, "curl"),
    `#!/usr/bin/env bash
set -euo pipefail

LAST_ARG=""
for arg in "$@"; do
  LAST_ARG="\${arg}"
done

case "\${LAST_ARG}" in
  http://127.0.0.1:*/json/version)
    if [ "\${MOCK_CDP_ALIVE:-1}" = "1" ]; then
      printf '{"Browser":"Mock Chromium"}\\n'
      exit 0
    fi
    ;;
esac

exit 22
`,
  );

  return binDir;
}

async function createHarness(t) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "hitl-smoke-"));
  const mockLogDir = path.join(rootDir, "mock-log");
  const binDir = await createMockCommands(rootDir);
  const sessionRoot = path.join(rootDir, "sessions");

  await mkdir(mockLogDir, { recursive: true });
  await mkdir(sessionRoot, { recursive: true });

  t.after(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    OPENCLAW_HITL_BASE_DIR: sessionRoot,
    OPENCLAW_PUBLIC_HOST: "127.0.0.1",
    OPENCLAW_PUBLIC_SCHEME: "http",
    OPENCLAW_HITL_TTL_SECONDS: "60",
    OPENCLAW_HITL_RUN_CLEANUP_BEFORE_OPEN: "0",
    MOCK_LOG_DIR: mockLogDir,
    MOCK_CDP_ALIVE: "1",
  };

  return { rootDir, mockLogDir, sessionRoot, env };
}

function runCommand(command, args, env) {
  return spawnSync(command, args, {
    cwd: repoRoot,
    env,
    encoding: "utf8",
  });
}

async function readSessionJson(sessionRoot, sessionId) {
  const filePath = path.join(sessionRoot, sessionId, "session.json");
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw);
}

test("hitl-open creates a waiting session and hitl-status reports it as alive", async (t) => {
  const harness = await createHarness(t);

  const openResult = runCommand(
    "bash",
    ["tools/browser-hitl/hitl-open.sh", "https://example.com/login?step=otp&name=alpha beta"],
    harness.env,
  );

  assert.equal(openResult.status, 0, openResult.stderr);

  const opened = JSON.parse(openResult.stdout);
  assert.equal(opened.status, "WAITING_FOR_USER");
  assert.equal(opened.target_url, "https://example.com/login?step=otp&name=alpha beta");
  assert.match(opened.session_id, /^\d+-[0-9a-f]{8}$/);

  const statusResult = runCommand(
    "bash",
    ["tools/browser-hitl/hitl-status.sh", opened.session_id],
    harness.env,
  );

  assert.equal(statusResult.status, 0, statusResult.stderr);

  const status = JSON.parse(statusResult.stdout);
  assert.equal(status.alive, true);
  assert.equal(status.expired, false);
  assert.equal(status.status, "WAITING_FOR_USER");

  const sessionJson = await readSessionJson(harness.sessionRoot, opened.session_id);
  assert.equal(sessionJson.status, "WAITING_FOR_USER");
  assert.equal(sessionJson.last_action, "opened");
});

test("hitl-close marks the session closed and stores the closed reason", async (t) => {
  const harness = await createHarness(t);

  const openResult = runCommand("bash", ["tools/browser-hitl/hitl-open.sh", "https://example.com"], harness.env);
  assert.equal(openResult.status, 0, openResult.stderr);

  const opened = JSON.parse(openResult.stdout);
  const closeResult = runCommand(
    "bash",
    ["tools/browser-hitl/hitl-close.sh", opened.session_id, "test_completed"],
    harness.env,
  );

  assert.equal(closeResult.status, 0, closeResult.stderr);
  assert.match(closeResult.stdout, new RegExp(`closed ${opened.session_id}`));

  const sessionJson = await readSessionJson(harness.sessionRoot, opened.session_id);
  assert.equal(sessionJson.status, "CLOSED");
  assert.equal(sessionJson.closed_reason, "test_completed");
  assert.equal(sessionJson.last_action, "closed");
});

test("hitl-cleanup expires stale sessions after their TTL window", async (t) => {
  const harness = await createHarness(t);

  const openResult = runCommand("bash", ["tools/browser-hitl/hitl-open.sh", "https://example.com"], harness.env);
  assert.equal(openResult.status, 0, openResult.stderr);

  const opened = JSON.parse(openResult.stdout);
  const sessionDir = path.join(harness.sessionRoot, opened.session_id);

  await writeFile(path.join(sessionDir, "expires_at"), `${Math.floor(Date.now() / 1000) - 5}\n`, "utf8");

  const cleanupResult = runCommand("bash", ["tools/browser-hitl/hitl-cleanup.sh"], harness.env);
  assert.equal(cleanupResult.status, 0, cleanupResult.stderr);
  assert.match(cleanupResult.stdout, new RegExp(`expired ${opened.session_id}`));

  const sessionJson = await readSessionJson(harness.sessionRoot, opened.session_id);
  assert.equal(sessionJson.status, "EXPIRED");
  assert.equal(sessionJson.closed_reason, "ttl_expired");
  assert.equal(sessionJson.last_action, "expired_closed");
});

test("browser-control refuses expired sessions before attempting a Playwright connection", async (t) => {
  const harness = await createHarness(t);
  const sessionId = "expired-session";
  const sessionDir = path.join(harness.sessionRoot, sessionId);

  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    path.join(sessionDir, "session.json"),
    JSON.stringify(
      {
        session_id: sessionId,
        status: "WAITING_FOR_USER",
        cdp_url: "http://127.0.0.1:35555",
        expires_at: Math.floor(Date.now() / 1000) - 1,
      },
      null,
      2,
    ),
    "utf8",
  );

  const controlResult = runCommand(
    "node",
    ["tools/browser-hitl/browser-control.mjs", sessionId, "title"],
    harness.env,
  );

  assert.equal(controlResult.status, 1);
  assert.match(controlResult.stderr, /handoff session has expired/);
});
