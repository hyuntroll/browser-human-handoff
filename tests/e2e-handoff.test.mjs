import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test, { after, before, describe } from "node:test";
import { chromium } from "playwright";
import { startTestSite } from "./fixtures/test-site.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const toolsDir = path.join(repoRoot, "tools", "browser-hitl");

/** @type {Array<{ script: string, args: string[], code: number | null, stdout: string, stderr: string, stdoutBuf: Buffer, stderrBuf: Buffer }>} */
const capturedChildren = [];

let baseDir = "";
/** @type {Awaited<ReturnType<typeof startTestSite>> | null} */
let fixture = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollUntil(fn, { timeoutMs = 6000, intervalMs = 100, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const val = await fn();
      if (val) return val;
    } catch (err) {
      lastErr = err;
    }
    await sleep(intervalMs);
  }
  if (lastErr) throw lastErr;
  throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms`);
}

function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 1) return false;
  try {
    process.kill(n, 0);
  } catch (err) {
    if (err && err.code === "ESRCH") return false;
    return true;
  }
  try {
    const stat = fs.readFileSync(`/proc/${n}/stat`, "utf8");
    const rparen = stat.lastIndexOf(")");
    if (rparen !== -1) {
      const state = stat.slice(rparen + 2, rparen + 3);
      if (state === "Z" || state === "X") return false;
    }
  } catch {
    // Process vanished between kill(0) and /proc read
    return false;
  }
  return true;
}

function safeKillPid(pid, signal = "SIGTERM") {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 1) return;
  try {
    process.kill(n, signal);
  } catch {
    // Ignore already-dead process
  }
}

function runCli(scriptName, args = [], opts = {}) {
  const scriptPath = path.join(toolsDir, scriptName);
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const env = {
    ...process.env,
    BROWSER_HANDOFF_BASE_DIR: baseDir,
    ...(opts.env || {}),
  };

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: repoRoot,
      env,
      stdio: [opts.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
    });

    const outChunks = [];
    const errChunks = [];

    child.stdout.on("data", (c) => outChunks.push(Buffer.from(c)));
    child.stderr.on("data", (c) => errChunks.push(Buffer.from(c)));

    const timer = setTimeout(() => {
      safeKillPid(child.pid, "SIGKILL");
      reject(new Error(`CLI timed out after ${timeoutMs}ms: ${scriptName} ${args.join(" ")}`));
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const stdoutBuf = Buffer.concat(outChunks);
      const stderrBuf = Buffer.concat(errChunks);
      const stdout = stdoutBuf.toString("utf8");
      const stderr = stderrBuf.toString("utf8");

      capturedChildren.push({
        script: scriptName,
        args: [...args],
        code,
        stdout,
        stderr,
        stdoutBuf,
        stderrBuf,
      });

      let json = null;
      const trimmed = stdout.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          json = JSON.parse(trimmed);
        } catch {
          json = null;
        }
      }

      resolve({ code, signal, stdout, stderr, stdoutBuf, stderrBuf, json });
    });

    if (opts.input !== undefined) {
      child.stdin.write(opts.input);
      child.stdin.end();
    }
  });
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readEndpoint() {
  return readJsonFile(path.join(baseDir, "browser", "endpoint.json"));
}

function readSession(sessionId) {
  return readJsonFile(path.join(baseDir, "sessions", sessionId, "session.json"));
}

function parseProcNetTcpFile(filePath, family) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw.trim().split("\n").slice(1);
  const entries = [];
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 10) continue;
    const [localAddrHex, localPortHex] = parts[1].split(":");
    const stateHex = parts[3].toUpperCase();
    const inode = parts[9];
    const localPort = Number.parseInt(localPortHex, 16);
    entries.push({
      family,
      localAddrHex: localAddrHex.toUpperCase(),
      localPort,
      stateHex,
      inode,
    });
  }
  return entries;
}

function getListeningSocketsForPort(port) {
  const targetPort = Number(port);
  const all = [
    ...parseProcNetTcpFile("/proc/net/tcp", "tcp"),
    ...parseProcNetTcpFile("/proc/net/tcp6", "tcp6"),
  ];
  return all.filter((e) => e.stateHex === "0A" && e.localPort === targetPort);
}

function assertPortListensOnlyOnLoopback(port, label) {
  const listeners = getListeningSocketsForPort(port);
  assert.ok(
    listeners.length > 0,
    `Expected ${label} port ${port} to have a LISTEN (0A) socket in /proc/net/tcp or /proc/net/tcp6`,
  );

  const hasIpv4Loopback = listeners.some(
    (l) =>
      (l.family === "tcp" && l.localAddrHex === "0100007F") ||
      (l.family === "tcp6" && l.localAddrHex === "0000000000000000FFFF00000100007F"),
  );
  assert.equal(
    hasIpv4Loopback,
    true,
    `Expected ${label} port ${port} local address to be 127.0.0.1 (0100007F), got: ${JSON.stringify(listeners)}`,
  );

  const wildcardAddresses = new Set([
    "00000000", // 0.0.0.0
    "00000000000000000000000000000000", // ::
    "0000000000000000FFFF000000000000", // ::ffff:0.0.0.0
  ]);
  for (const l of listeners) {
    assert.equal(
      wildcardAddresses.has(l.localAddrHex),
      false,
      `${label} port ${port} must NOT listen on 0.0.0.0/::, found: ${JSON.stringify(l)}`,
    );
  }
}

async function assertPortRefusesConnection(port, host = "127.0.0.1") {
  await pollUntil(
    async () => {
      try {
        await fetch(`http://${host}:${port}/`, { signal: AbortSignal.timeout(1000) });
        return false;
      } catch {
        return true;
      }
    },
    { timeoutMs: 5000, intervalMs: 100, label: `port ${port} refuses connection` },
  );
}

function listFilesRecursiveExcludingProfile(dirPath) {
  const profileDir = path.resolve(baseDir, "browser", "profile");
  const results = [];

  function walk(current) {
    const resolved = path.resolve(current);
    if (resolved === profileDir || resolved.startsWith(`${profileDir}${path.sep}`)) {
      return;
    }
    let entries;
    try {
      entries = fs.readdirSync(resolved, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(resolved, entry.name);
      const resolvedFull = path.resolve(fullPath);
      if (resolvedFull === profileDir || resolvedFull.startsWith(`${profileDir}${path.sep}`)) {
        continue;
      }
      let stat;
      try {
        stat = fs.lstatSync(resolvedFull);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(resolvedFull);
      } else if (stat.isFile()) {
        results.push(resolvedFull);
      }
    }
  }

  walk(dirPath);
  return results;
}

describe("Persistent Browser Handoff E2E", { concurrency: false, timeout: 600_000 }, () => {
  before(async () => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-handoff-e2e-"));
    fs.chmodSync(baseDir, 0o700);
    fixture = await startTestSite();
  });

  after(async () => {
    try {
      await runCli("hitl-browser.mjs", ["stop"], { timeoutMs: 20_000 });
    } catch {
      // Ignore errors if stop was not reachable
    }

    // Kill any leftover gateway / watcher PIDs recorded in session.json files under baseDir
    try {
      const sessionsDir = path.join(baseDir, "sessions");
      if (fs.existsSync(sessionsDir)) {
        for (const id of fs.readdirSync(sessionsDir)) {
          const sessFile = path.join(sessionsDir, id, "session.json");
          if (!fs.existsSync(sessFile)) continue;
          try {
            const s = readJsonFile(sessFile);
            if (s.gateway?.pid) {
              safeKillPid(s.gateway.pid, "SIGTERM");
              safeKillPid(s.gateway.pid, "SIGKILL");
            }
            if (s.watcher_pid) {
              safeKillPid(s.watcher_pid, "SIGTERM");
              safeKillPid(s.watcher_pid, "SIGKILL");
            }
          } catch {
            // Ignore malformed session.json
          }
        }
      }
    } catch {
      // Ignore cleanup errors
    }

    // Also check endpoint.json in case hitl-browser.mjs stop left anything behind
    try {
      const epPath = path.join(baseDir, "browser", "endpoint.json");
      if (fs.existsSync(epPath)) {
        const ep = readJsonFile(epPath);
        if (ep.chromium_pid) {
          safeKillPid(ep.chromium_pid, "SIGTERM");
          safeKillPid(ep.chromium_pid, "SIGKILL");
        }
        if (ep.xpra_pid) {
          safeKillPid(ep.xpra_pid, "SIGTERM");
          safeKillPid(ep.xpra_pid, "SIGKILL");
        }
      }
    } catch {
      // Ignore
    }

    if (fixture) {
      await fixture.close();
    }

    if (baseDir && fs.existsSync(baseDir)) {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  test(
    "1. browser start once and reuse: ensure twice -> same chromium_pid and same cdp_ws; second has reused:true",
    { timeout: 60_000 },
    async () => {
      const first = await runCli("hitl-browser.mjs", ["ensure"]);
      assert.equal(first.code, 0, `first ensure failed: ${first.stderr}`);
      assert.ok(first.json, `expected JSON output from first ensure, got: ${first.stdout}`);
      assert.ok(
        Number.isInteger(first.json.chromium_pid) && first.json.chromium_pid > 1,
        `expected valid chromium_pid, got: ${first.json.chromium_pid}`,
      );
      assert.match(first.json.cdp_ws, /^ws:\/\/127\.0\.0\.1:\d+\//);
      assert.match(first.json.cdp_http, /^http:\/\/127\.0\.0\.1:\d+$/);

      const second = await runCli("hitl-browser.mjs", ["ensure"]);
      assert.equal(second.code, 0, `second ensure failed: ${second.stderr}`);
      assert.ok(second.json, `expected JSON output from second ensure, got: ${second.stdout}`);
      assert.equal(second.json.chromium_pid, first.json.chromium_pid);
      assert.equal(second.json.cdp_ws, first.json.cdp_ws);
      assert.equal(second.json.reused, true);
    },
  );

  test(
    "2. CDP only on 127.0.0.1: endpoint cdp_http host is 127.0.0.1 and /proc/net/tcp shows 0100007F only",
    { timeout: 60_000 },
    async () => {
      const endpoint = readEndpoint();
      const cdpUrl = new URL(endpoint.cdp_http);
      assert.equal(cdpUrl.hostname, "127.0.0.1");

      const cdpPort = Number(endpoint.cdp_port || cdpUrl.port);
      assert.ok(cdpPort > 0, `expected positive CDP port, got ${cdpPort}`);

      assertPortListensOnlyOnLoopback(cdpPort, "CDP");
    },
  );

  test(
    "3. login made in the browser carries over across CDP clients and browser-control.mjs",
    { timeout: 60_000 },
    async () => {
      const endpoint = readEndpoint();
      fixture.resetAuth();
      fixture.setCredentials({
        username: "carryover-user",
        password: "carryover-pass",
        otp: "654321",
      });

      // Client A: logs in on the fixture, then disconnects
      const browserA = await chromium.connectOverCDP(endpoint.cdp_http);
      try {
        const contextA = browserA.contexts()[0];
        assert.ok(contextA, "expected default browser context on client A");
        const pagesA = contextA.pages();
        const pageA = pagesA.length > 0 ? pagesA[pagesA.length - 1] : await contextA.newPage();

        await pageA.goto(`${fixture.baseUrl}/login`, { waitUntil: "domcontentloaded" });
        await pageA.fill("#username", "carryover-user");
        await pageA.fill("#password", "carryover-pass");
        await pageA.fill("#otp", "654321");
        await Promise.all([
          pageA.waitForURL((u) => u.pathname === "/me", { timeout: 10_000 }),
          pageA.click("#submit"),
        ]);
        const textA = await pageA.textContent("body");
        assert.match(textA ?? "", /logged-in/);
      } finally {
        await browserA.close();
      }

      // Client B: new connectOverCDP goes to /me and sees "logged-in"
      const browserB = await chromium.connectOverCDP(endpoint.cdp_http);
      try {
        const contextB = browserB.contexts()[0];
        assert.ok(contextB, "expected default browser context on client B");
        const pagesB = contextB.pages();
        const pageB = pagesB.length > 0 ? pagesB[pagesB.length - 1] : await contextB.newPage();

        await pageB.goto(`${fixture.baseUrl}/me`, { waitUntil: "domcontentloaded" });
        const textB = await pageB.textContent("body");
        assert.match(textB ?? "", /logged-in/);
      } finally {
        await browserB.close();
      }

      // browser-control.mjs goto <fixture>/me then content contains logged-in
      const gotoRes = await runCli("browser-control.mjs", ["goto", `${fixture.baseUrl}/me`]);
      assert.equal(gotoRes.code, 0, `browser-control goto failed: ${gotoRes.stderr}`);

      const contentRes = await runCli("browser-control.mjs", ["content"]);
      assert.equal(contentRes.code, 0, `browser-control content failed: ${contentRes.stderr}`);
      assert.match(contentRes.stdout, /logged-in/);
    },
  );

  test(
    "4. form mode: gateway POST /__handoff/form and CLI fill (--stdin, --file 0600, reject 0644, reject argv) with zero secret leakage",
    { timeout: 90_000 },
    async () => {
      const allSecrets = [];
      const makeSecret = (tag) => {
        const s = `secret_${tag}_${crypto.randomBytes(16).toString("hex")}`;
        allSecrets.push(s);
        return s;
      };

      // --- Path a) Gateway form submission ---
      fixture.resetAuth();
      const userA = makeSecret("userA");
      const passA = makeSecret("passA");
      const otpA = makeSecret("otpA");
      fixture.setCredentials({ username: userA, password: passA, otp: otpA });

      const openA = await runCli("hitl-handoff.mjs", [
        "open",
        `${fixture.baseUrl}/login`,
        "--mode",
        "form",
        "--field",
        "username=#username",
        "--field",
        "password=#password",
        "--field",
        "otp=#otp",
        "--submit",
        "#submit",
      ]);
      assert.equal(openA.code, 0, `open form session A failed: ${openA.stderr}`);
      const sessA = openA.json;
      assert.ok(sessA?.session_id, "expected session_id");
      assert.equal(sessA.mode, "form");
      assert.deepEqual(sessA.fields, ["username", "password", "otp"]);
      assert.ok(sessA.handoff_url, "expected handoff_url");

      try {
        const redeemA = await fetch(sessA.handoff_url, { redirect: "manual" });
        assert.equal(redeemA.status, 302);
        const setCookieA = redeemA.headers.get("set-cookie");
        assert.ok(setCookieA, "expected Set-Cookie from handoff_url");
        const cookieA = setCookieA.split(";")[0];
        const originA = new URL(sessA.handoff_url).origin;

        const formResp = await fetch(`${originA}/__handoff/form`, {
          method: "POST",
          headers: {
            Cookie: cookieA,
            "X-Handoff": "1",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            username: userA,
            password: passA,
            otp: otpA,
          }),
        });
        assert.equal(formResp.status, 200);
        const formBody = await formResp.json();
        assert.equal(formBody.ok, true);
        assert.deepEqual(formBody.filled, ["username", "password", "otp"]);

        const subA = await pollUntil(() => fixture.getLastSubmission(), {
          timeoutMs: 8000,
          label: "fixture POST /login for Path a",
        });
        assert.equal(subA.username, userA);
        assert.equal(subA.password, passA);
        assert.equal(subA.otp, otpA);
        assert.equal(subA.matched, true);
      } finally {
        await runCli("hitl-handoff.mjs", ["done", sessA.session_id]);
      }

      const verifyMeA = await runCli("browser-control.mjs", ["goto", `${fixture.baseUrl}/me`]);
      assert.equal(verifyMeA.code, 0, verifyMeA.stderr);
      const contentMeA = await runCli("browser-control.mjs", ["content"]);
      assert.equal(contentMeA.code, 0, contentMeA.stderr);
      assert.match(contentMeA.stdout, /logged-in/);

      // --- Path b.1) hitl-handoff.mjs fill <id> --stdin, 0644 rejection, argv rejection ---
      fixture.resetAuth();
      const userB1 = makeSecret("userB1");
      const passB1 = makeSecret("passB1");
      const otpB1 = makeSecret("otpB1");
      fixture.setCredentials({ username: userB1, password: passB1, otp: otpB1 });

      const openB1 = await runCli("hitl-handoff.mjs", [
        "open",
        `${fixture.baseUrl}/login`,
        "--mode",
        "form",
        "--field",
        "username=#username",
        "--field",
        "password=#password",
        "--field",
        "otp=#otp",
        "--submit",
        "#submit",
      ]);
      assert.equal(openB1.code, 0, `open form session B1 failed: ${openB1.stderr}`);
      const sessB1 = openB1.json;

      try {
        // Reject 0644 file
        const insecureFilePath = path.join(
          os.tmpdir(),
          `handoff-insecure-${crypto.randomBytes(6).toString("hex")}.json`,
        );
        const badFileUser = makeSecret("badFileUser");
        fs.writeFileSync(
          insecureFilePath,
          JSON.stringify({ username: badFileUser, password: passB1, otp: otpB1 }),
          { mode: 0o644 },
        );
        fs.chmodSync(insecureFilePath, 0o644);
        try {
          const badFileRes = await runCli("hitl-handoff.mjs", [
            "fill",
            sessB1.session_id,
            "--file",
            insecureFilePath,
          ]);
          assert.notEqual(badFileRes.code, 0, "fill with 0644 file must be rejected");
        } finally {
          if (fs.existsSync(insecureFilePath)) fs.unlinkSync(insecureFilePath);
        }

        // Reject argv-style value passing (never pass secrets on argv)
        const argvRes1 = await runCli("hitl-handoff.mjs", [
          "fill",
          sessB1.session_id,
          "username=foo",
        ]);
        assert.notEqual(argvRes1.code, 0, "argv positional values must be rejected");

        const argvRes2 = await runCli("hitl-handoff.mjs", [
          "fill",
          sessB1.session_id,
          "--username",
          "foo",
        ]);
        assert.notEqual(argvRes2.code, 0, "argv flag values must be rejected");

        // Fill via --stdin
        const stdinRes = await runCli(
          "hitl-handoff.mjs",
          ["fill", sessB1.session_id, "--stdin"],
          {
            input: JSON.stringify({
              username: userB1,
              password: passB1,
              otp: otpB1,
            }),
          },
        );
        assert.equal(stdinRes.code, 0, `fill --stdin failed: ${stdinRes.stderr}`);
        assert.equal(stdinRes.json?.ok, true);
        assert.deepEqual(stdinRes.json?.filled, ["username", "password", "otp"]);

        const subB1 = await pollUntil(() => fixture.getLastSubmission(), {
          timeoutMs: 8000,
          label: "fixture POST /login for Path b (--stdin)",
        });
        assert.equal(subB1.username, userB1);
        assert.equal(subB1.password, passB1);
        assert.equal(subB1.otp, otpB1);
        assert.equal(subB1.matched, true);
      } finally {
        await runCli("hitl-handoff.mjs", ["done", sessB1.session_id]);
      }

      // --- Path b.2) hitl-handoff.mjs fill <id> --file with 0600 file (and assert deleted afterwards) ---
      fixture.resetAuth();
      const userB2 = makeSecret("userB2");
      const passB2 = makeSecret("passB2");
      const otpB2 = makeSecret("otpB2");
      fixture.setCredentials({ username: userB2, password: passB2, otp: otpB2 });

      const openB2 = await runCli("hitl-handoff.mjs", [
        "open",
        `${fixture.baseUrl}/login`,
        "--mode",
        "form",
        "--field",
        "username=#username",
        "--field",
        "password=#password",
        "--field",
        "otp=#otp",
        "--submit",
        "#submit",
      ]);
      assert.equal(openB2.code, 0, `open form session B2 failed: ${openB2.stderr}`);
      const sessB2 = openB2.json;

      const secureFilePath = path.join(
        os.tmpdir(),
        `handoff-secure-${crypto.randomBytes(6).toString("hex")}.json`,
      );
      fs.writeFileSync(
        secureFilePath,
        JSON.stringify({ username: userB2, password: passB2, otp: otpB2 }),
        { mode: 0o600 },
      );
      fs.chmodSync(secureFilePath, 0o600);

      try {
        const fileRes = await runCli("hitl-handoff.mjs", [
          "fill",
          sessB2.session_id,
          "--file",
          secureFilePath,
        ]);
        assert.equal(fileRes.code, 0, `fill --file 0600 failed: ${fileRes.stderr}`);
        assert.equal(fileRes.json?.ok, true);
        assert.deepEqual(fileRes.json?.filled, ["username", "password", "otp"]);
        assert.equal(
          fs.existsSync(secureFilePath),
          false,
          "0600 secret file must be deleted after fill --file",
        );

        const subB2 = await pollUntil(() => fixture.getLastSubmission(), {
          timeoutMs: 8000,
          label: "fixture POST /login for Path b (--file)",
        });
        assert.equal(subB2.username, userB2);
        assert.equal(subB2.password, passB2);
        assert.equal(subB2.otp, otpB2);
        assert.equal(subB2.matched, true);
      } finally {
        if (fs.existsSync(secureFilePath)) fs.unlinkSync(secureFilePath);
        await runCli("hitl-handoff.mjs", ["done", sessB2.session_id]);
      }

      const verifyMeB2 = await runCli("browser-control.mjs", ["goto", `${fixture.baseUrl}/me`]);
      assert.equal(verifyMeB2.code, 0, verifyMeB2.stderr);
      const contentMeB2 = await runCli("browser-control.mjs", ["content"]);
      assert.equal(contentMeB2.code, 0, contentMeB2.stderr);
      assert.match(contentMeB2.stdout, /logged-in/);

      // --- Secret scan across all captured child stdout/stderr, every file under BASE_DIR except browser/profile/**, and session.json ---
      const filesToScan = listFilesRecursiveExcludingProfile(baseDir);
      assert.ok(filesToScan.length > 0, "expected files under BASE_DIR to scan");

      for (const secret of allSecrets) {
        const secretBuf = Buffer.from(secret, "utf8");

        for (const childEntry of capturedChildren) {
          assert.equal(
            childEntry.stdoutBuf.includes(secretBuf),
            false,
            `Secret leaked in stdout of ${childEntry.script} ${childEntry.args.join(" ")}`,
          );
          assert.equal(
            childEntry.stderrBuf.includes(secretBuf),
            false,
            `Secret leaked in stderr of ${childEntry.script} ${childEntry.args.join(" ")}`,
          );
        }

        for (const filePath of filesToScan) {
          const contentBuf = fs.readFileSync(filePath);
          assert.equal(
            contentBuf.includes(secretBuf),
            false,
            `Secret leaked in file ${filePath}`,
          );
        }

        for (const sid of [sessA.session_id, sessB1.session_id, sessB2.session_id]) {
          const sessBuf = fs.readFileSync(path.join(baseDir, "sessions", sid, "session.json"));
          assert.equal(
            sessBuf.includes(secretBuf),
            false,
            `Secret leaked in session.json for ${sid}`,
          );
        }
      }
    },
  );

  test(
    "5. gateway localhost only + one-time token + xpra unix socket proxy & WebSocket upgrade",
    { timeout: 60_000 },
    async (t) => {
      const openRes = await runCli("hitl-handoff.mjs", [
        "open",
        `${fixture.baseUrl}/login`,
        "--mode",
        "browser",
      ]);
      assert.equal(openRes.code, 0, `open browser session failed: ${openRes.stderr}`);
      const sess = openRes.json;
      assert.ok(sess?.session_id);
      assert.ok(sess?.handoff_url);

      try {
        const handoffUrl = new URL(sess.handoff_url);
        const tokenMatch = handoffUrl.pathname.match(/^\/t\/([^/]+)$/);
        assert.ok(tokenMatch, `expected /t/<token> path in ${sess.handoff_url}`);
        const rawToken = tokenMatch[1];

        // session.json must not contain the raw token
        const sessionFilePath = path.join(baseDir, "sessions", sess.session_id, "session.json");
        const sessionRaw = fs.readFileSync(sessionFilePath, "utf8");
        assert.equal(
          sessionRaw.includes(rawToken),
          false,
          "session.json must NOT contain the raw one-time token",
        );

        const sessionMeta = JSON.parse(sessionRaw);
        const expectedSha = crypto.createHash("sha256").update(rawToken).digest("hex");
        assert.equal(sessionMeta.token_sha256, expectedSha);

        // Gateway bind host 127.0.0.1 per /proc/net/tcp
        assert.equal(sessionMeta.gateway?.bind_host, "127.0.0.1");
        const gatewayPort = Number(sessionMeta.gateway?.port || handoffUrl.port);
        assert.ok(gatewayPort > 0);
        assertPortListensOnlyOnLoopback(gatewayPort, "Gateway");

        // First GET handoff_url -> 302 with Set-Cookie
        const firstGet = await fetch(sess.handoff_url, { redirect: "manual" });
        assert.equal(firstGet.status, 302);
        const setCookie = firstGet.headers.get("set-cookie");
        assert.ok(setCookie, "expected Set-Cookie header on first GET handoff_url");
        const cookiePair = setCookie.split(";")[0];

        // Second GET same url -> 403 or 410
        const secondGet = await fetch(sess.handoff_url, { redirect: "manual" });
        assert.ok(
          secondGet.status === 403 || secondGet.status === 410,
          `expected 403 or 410 on second GET handoff_url, got ${secondGet.status}`,
        );

        // Request without cookie to /__handoff/ -> 403
        const noCookieGet = await fetch(`${handoffUrl.origin}/__handoff/`, { redirect: "manual" });
        assert.equal(noCookieGet.status, 403);

        // Request with cookie to /__handoff/ -> 200
        const withCookieGet = await fetch(`${handoffUrl.origin}/__handoff/`, {
          headers: { Cookie: cookiePair },
        });
        assert.equal(withCookieGet.status, 200);

        // Xpra proxy assertions (skip only if share_available is false / DISPLAY or xpra unavailable)
        await t.test("xpra unix socket & HTML5/WebSocket proxy", async (st) => {
          if (!sess.share_available) {
            st.skip("DISPLAY/xpra share_available is false in this environment");
            return;
          }

          const endpoint = readEndpoint();
          assert.ok(endpoint.xpra_socket, "expected xpra_socket in endpoint.json");
          assert.equal(
            fs.existsSync(endpoint.xpra_socket),
            true,
            `xpra_socket file missing: ${endpoint.xpra_socket}`,
          );
          const sockStat = fs.statSync(endpoint.xpra_socket);
          assert.equal(sockStat.isSocket(), true, "xpra_socket must be a unix socket");
          const sockMode = sockStat.mode & 0o777;
          const dirMode = fs.statSync(path.dirname(endpoint.xpra_socket)).mode & 0o777;
          assert.ok(
            sockMode === 0o600 || dirMode === 0o700,
            `expected xpra_socket mode 0600 (${sockMode.toString(8)}) or dir mode 0700 (${dirMode.toString(8)})`,
          );

          // Assert no TCP listener belongs to xpra
          const listeningInodes = new Set(
            [
              ...parseProcNetTcpFile("/proc/net/tcp", "tcp"),
              ...parseProcNetTcpFile("/proc/net/tcp6", "tcp6"),
            ]
              .filter((e) => e.stateHex === "0A")
              .map((e) => e.inode),
          );

          const xpraPids = new Set();
          if (endpoint.xpra_pid) xpraPids.add(Number(endpoint.xpra_pid));
          for (const entry of fs.readdirSync("/proc")) {
            if (!/^\d+$/.test(entry)) continue;
            try {
              const cmdline = fs.readFileSync(`/proc/${entry}/cmdline`, "utf8");
              if (cmdline.includes(baseDir) && cmdline.includes("xpra")) {
                xpraPids.add(Number(entry));
                assert.equal(
                  cmdline.includes("--bind-tcp"),
                  false,
                  "xpra process must not be started with --bind-tcp",
                );
              }
            } catch {
              // Ignore inaccessible /proc entries
            }
          }

          for (const xpid of xpraPids) {
            try {
              for (const fd of fs.readdirSync(`/proc/${xpid}/fd`)) {
                try {
                  const target = fs.readlinkSync(`/proc/${xpid}/fd/${fd}`);
                  const m = target.match(/^socket:\[(\d+)\]$/);
                  if (m) {
                    assert.equal(
                      listeningInodes.has(m[1]),
                      false,
                      `xpra pid ${xpid} owns a TCP listening socket inode ${m[1]}`,
                    );
                  }
                } catch {
                  // Ignore vanished fd
                }
              }
            } catch {
              // Ignore vanished pid
            }
          }

          // With cookie, GET /index.html -> 200 containing "xpra" (case-insensitive)
          const indexResp = await fetch(`${handoffUrl.origin}/index.html`, {
            headers: {
              Cookie: cookiePair,
              "Accept-Encoding": "identity",
            },
          });
          assert.equal(indexResp.status, 200);
          const indexText = await indexResp.text();
          assert.match(indexText, /xpra/i);

          // WebSocket upgrade through gateway -> 101
          const wsKey = crypto.randomBytes(16).toString("base64");
          const upgradeRes = await new Promise((resolve, reject) => {
            const req = http.request({
              hostname: "127.0.0.1",
              port: gatewayPort,
              path: "/",
              method: "GET",
              headers: {
                Host: `127.0.0.1:${gatewayPort}`,
                Connection: "Upgrade",
                Upgrade: "websocket",
                "Sec-WebSocket-Version": "13",
                "Sec-WebSocket-Key": wsKey,
                "Sec-WebSocket-Protocol": "binary",
                Cookie: cookiePair,
              },
            });
            req.on("upgrade", (res, socket) => {
              socket.destroy();
              resolve({ statusCode: res.statusCode, headers: res.headers });
            });
            req.on("response", (res) => {
              res.resume();
              resolve({ statusCode: res.statusCode, headers: res.headers });
            });
            req.on("error", reject);
            req.end();
          });
          assert.equal(upgradeRes.statusCode, 101);
        });
      } finally {
        await runCli("hitl-handoff.mjs", ["close", sess.session_id]);
      }
    },
  );

  test(
    "6. done signal releases the agent lock (both gateway POST /__handoff/done and CLI done + wait)",
    { timeout: 60_000 },
    async () => {
      const lockFilePath = path.join(baseDir, "browser", "agent.lock");

      // Part A: Gateway POST /__handoff/done
      const open1 = await runCli("hitl-handoff.mjs", [
        "open",
        `${fixture.baseUrl}/login`,
        "--mode",
        "browser",
      ]);
      assert.equal(open1.code, 0, open1.stderr);
      const sess1 = open1.json;
      const meta1Before = readSession(sess1.session_id);
      const port1 = meta1Before.gateway.port;

      assert.equal(fs.existsSync(lockFilePath), true, "agent.lock should exist while session open");

      // browser-control.mjs title exits with code 75 while locked
      const lockedTitle = await runCli("browser-control.mjs", ["title"]);
      assert.equal(lockedTitle.code, 75, `expected exit code 75 while locked, got ${lockedTitle.code}`);
      assert.match(lockedTitle.stderr, /handoff in progress/i);

      // Redeem token and POST /__handoff/done
      const redeem1 = await fetch(sess1.handoff_url, { redirect: "manual" });
      assert.equal(redeem1.status, 302);
      const cookie1 = redeem1.headers.get("set-cookie").split(";")[0];
      const origin1 = new URL(sess1.handoff_url).origin;

      const doneResp = await fetch(`${origin1}/__handoff/done`, {
        method: "POST",
        headers: {
          Cookie: cookie1,
          "X-Handoff": "1",
        },
      });
      assert.equal(doneResp.status, 200);

      await pollUntil(() => !fs.existsSync(lockFilePath), {
        timeoutMs: 5000,
        label: "agent.lock removed after POST /__handoff/done",
      });

      const meta1After = readSession(sess1.session_id);
      assert.equal(meta1After.status, "RESUMABLE");
      assert.equal(meta1After.share_active, false);

      await assertPortRefusesConnection(port1);

      const unlockedTitle = await runCli("browser-control.mjs", ["title"]);
      assert.equal(unlockedTitle.code, 0, `expected exit 0 after done, got: ${unlockedTitle.stderr}`);

      // Part B: CLI hitl-handoff.mjs done <id> and wait <id>
      const open2 = await runCli("hitl-handoff.mjs", [
        "open",
        `${fixture.baseUrl}/login`,
        "--mode",
        "browser",
      ]);
      assert.equal(open2.code, 0, open2.stderr);
      const sess2 = open2.json;
      const meta2Before = readSession(sess2.session_id);
      const port2 = meta2Before.gateway.port;

      const waitPromise = runCli("hitl-handoff.mjs", [
        "wait",
        sess2.session_id,
        "--timeout",
        "15",
      ]);

      await sleep(400);

      const cliDone = await runCli("hitl-handoff.mjs", ["done", sess2.session_id]);
      assert.equal(cliDone.code, 0, `CLI done failed: ${cliDone.stderr}`);

      const waitRes = await waitPromise;
      assert.equal(waitRes.code, 0, `CLI wait failed: ${waitRes.stderr}`);
      assert.match(waitRes.stdout, /RESUMABLE/);

      assert.equal(fs.existsSync(lockFilePath), false, "agent.lock should be removed after CLI done");
      const meta2After = readSession(sess2.session_id);
      assert.equal(meta2After.status, "RESUMABLE");
      await assertPortRefusesConnection(port2);

      const unlockedTitle2 = await runCli("browser-control.mjs", ["title"]);
      assert.equal(unlockedTitle2.code, 0, unlockedTitle2.stderr);
    },
  );

  test(
    "7. TTL watcher expires only the share gateway while keeping the persistent browser alive",
    { timeout: 60_000 },
    async () => {
      const endpointBefore = readEndpoint();
      const openRes = await runCli("hitl-handoff.mjs", [
        "open",
        `${fixture.baseUrl}/login`,
        "--mode",
        "browser",
        "--ttl",
        "4",
      ]);
      assert.equal(openRes.code, 0, openRes.stderr);
      const sess = openRes.json;
      const metaBefore = readSession(sess.session_id);
      const gatewayPid = metaBefore.gateway.pid;
      const gatewayPort = metaBefore.gateway.port;

      assert.ok(isPidAlive(gatewayPid), "gateway pid should be alive initially");

      // Wait ~8s for TTL (4s) + watcher cycle
      await sleep(7500);
      await pollUntil(
        () => {
          const m = readSession(sess.session_id);
          return m.status === "EXPIRED" && !isPidAlive(gatewayPid);
        },
        { timeoutMs: 6000, intervalMs: 200, label: "TTL watcher expiry" },
      );

      assert.equal(isPidAlive(gatewayPid), false, "gateway pid should be dead after TTL expiry");
      await assertPortRefusesConnection(gatewayPort);

      const metaAfter = readSession(sess.session_id);
      assert.equal(metaAfter.status, "EXPIRED");
      assert.equal(metaAfter.share_active, false);

      const lockFilePath = path.join(baseDir, "browser", "agent.lock");
      assert.equal(fs.existsSync(lockFilePath), false, "agent.lock must be released on TTL expiry");

      const titleRes = await runCli("browser-control.mjs", ["title"]);
      assert.equal(titleRes.code, 0, `browser-control should succeed after TTL lock release: ${titleRes.stderr}`);

      // Persistent browser still alive and CDP /json/version still answers
      assert.equal(
        isPidAlive(endpointBefore.chromium_pid),
        true,
        "chromium_pid must remain alive after session TTL expiry",
      );
      const verResp = await fetch(`${endpointBefore.cdp_http}/json/version`);
      assert.equal(verResp.status, 200);
      const verJson = await verResp.json();
      assert.equal(verJson.webSocketDebuggerUrl, endpointBefore.cdp_ws);
    },
  );

  test(
    "8. permissions: directories are 0700 and metadata/log files are 0600",
    { timeout: 60_000 },
    async () => {
      const modeOf = (p) => fs.statSync(p).mode & 0o777;

      assert.equal(modeOf(baseDir), 0o700, "BASE_DIR must be 0700");
      assert.equal(modeOf(path.join(baseDir, "browser")), 0o700, "browser/ must be 0700");
      assert.equal(
        modeOf(path.join(baseDir, "browser", "profile")),
        0o700,
        "browser/profile must be 0700",
      );
      assert.equal(
        modeOf(path.join(baseDir, "browser", "endpoint.json")),
        0o600,
        "browser/endpoint.json must be 0600",
      );

      const browserLogsDir = path.join(baseDir, "browser", "logs");
      if (fs.existsSync(browserLogsDir)) {
        for (const name of fs.readdirSync(browserLogsDir)) {
          const logPath = path.join(browserLogsDir, name);
          if (fs.statSync(logPath).isFile()) {
            assert.equal(modeOf(logPath), 0o600, `browser log ${name} must be 0600`);
          }
        }
      }

      const sessionsDir = path.join(baseDir, "sessions");
      const sessionIds = fs.readdirSync(sessionsDir);
      assert.ok(sessionIds.length > 0, "expected at least one session directory");

      for (const id of sessionIds) {
        const sDir = path.join(sessionsDir, id);
        if (!fs.statSync(sDir).isDirectory()) continue;
        assert.equal(modeOf(sDir), 0o700, `sessions/${id} must be 0700`);

        const sJson = path.join(sDir, "session.json");
        assert.equal(modeOf(sJson), 0o600, `sessions/${id}/session.json must be 0600`);

        for (const entry of fs.readdirSync(sDir)) {
          if (entry.endsWith(".log")) {
            const logFile = path.join(sDir, entry);
            assert.equal(modeOf(logFile), 0o600, `sessions/${id}/${entry} must be 0600`);
          }
        }
      }
    },
  );

  test(
    "9. Switching: in form mode POST /__handoff/mode {mode:'browser'} -> session.mode browser; back to form",
    { timeout: 60_000 },
    async () => {
      const openRes = await runCli("hitl-handoff.mjs", [
        "open",
        `${fixture.baseUrl}/login`,
        "--mode",
        "form",
        "--field",
        "username=#username",
        "--field",
        "password=#password",
      ]);
      assert.equal(openRes.code, 0, openRes.stderr);
      const sess = openRes.json;
      assert.equal(sess.mode, "form");

      try {
        const redeem = await fetch(sess.handoff_url, { redirect: "manual" });
        assert.equal(redeem.status, 302);
        const cookie = redeem.headers.get("set-cookie").split(";")[0];
        const origin = new URL(sess.handoff_url).origin;

        // Switch to browser mode
        const toBrowser = await fetch(`${origin}/__handoff/mode`, {
          method: "POST",
          headers: {
            Cookie: cookie,
            "X-Handoff": "1",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ mode: "browser" }),
        });
        assert.equal(toBrowser.status, 200);
        assert.equal(readSession(sess.session_id).mode, "browser");

        // Switch back to form mode
        const toForm = await fetch(`${origin}/__handoff/mode`, {
          method: "POST",
          headers: {
            Cookie: cookie,
            "X-Handoff": "1",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ mode: "form" }),
        });
        assert.equal(toForm.status, 200);
        assert.equal(readSession(sess.session_id).mode, "form");
      } finally {
        await runCli("hitl-handoff.mjs", ["close", sess.session_id]);
      }
    },
  );
});
