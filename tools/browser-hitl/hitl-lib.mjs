#!/usr/bin/env node

import { constants as fsConstants, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import process from "node:process";

process.umask(0o077);

export const TERMINAL_STATUSES = new Set(["CLOSED", "EXPIRED", "FAILED"]);
export const REUSABLE_STATUSES = new Set(["RESUMABLE", "RESUMED"]);

export class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

export function nowEpoch() {
  return Math.floor(Date.now() / 1000);
}

export function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function getBaseDir() {
  return path.resolve(
    process.env.BROWSER_HANDOFF_BASE_DIR ??
      path.join(os.homedir(), ".hermes", "browser-handoff"),
  );
}

export function getPaths() {
  const base = getBaseDir();
  const browser = path.join(base, "browser");
  return {
    base,
    browser,
    profile: path.join(browser, "profile"),
    xpra: path.join(browser, "xpra"),
    xpraSocket: path.join(browser, "xpra", "xpra.sock"),
    endpoint: path.join(browser, "endpoint.json"),
    agentLock: path.join(browser, "agent.lock"),
    ensureLock: path.join(browser, ".ensure.lock"),
    operationLock: path.join(browser, ".operation.lock"),
    logs: path.join(browser, "logs"),
    sessions: path.join(base, "sessions"),
  };
}

export function assertSessionId(sessionId) {
  if (
    typeof sessionId !== "string" ||
    sessionId === "." ||
    sessionId === ".." ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sessionId)
  ) {
    throw new CliError("invalid session id", 64);
  }
  return sessionId;
}

export function getSessionPaths(sessionId) {
  assertSessionId(sessionId);
  const directory = path.join(getPaths().sessions, sessionId);
  return {
    directory,
    metadata: path.join(directory, "session.json"),
    gatewayLog: path.join(directory, "gateway.log"),
    watcherLog: path.join(directory, "watcher.log"),
    artifacts: path.join(directory, "artifacts"),
  };
}

export async function ensureDir(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  return directory;
}

export async function pathExists(filePath) {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error instanceof SyntaxError) {
      throw new Error(`invalid JSON file: ${filePath}`);
    }
    throw error;
  }
}

export async function writeJsonAtomic(filePath, value) {
  await ensureDir(path.dirname(filePath));
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
  let handle;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, filePath);
    await fs.chmod(filePath, 0o600);
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
}

export function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function randomId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(9).toString("base64url")}`;
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function constantTimeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export async function terminatePid(pid, escalationMs = 3000) {
  if (!pidAlive(pid)) return false;
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
    return false;
  }

  const deadline = Date.now() + escalationMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await sleep(100);
  }

  if (pidAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  return true;
}

export async function withFileLock(
  lockPath,
  operation,
  { timeoutMs = 15000, staleMs = 30000 } = {},
) {
  await ensureDir(path.dirname(lockPath));
  const owner = randomToken(18);
  const started = Date.now();
  let handle;

  while (!handle) {
    try {
      handle = await fs.open(lockPath, "wx", 0o600);
      await handle.writeFile(
        `${JSON.stringify({ owner, pid: process.pid, acquired_at: nowEpoch() })}\n`,
      );
      await handle.chmod(0o600);
    } catch (error) {
      if (error.code !== "EEXIST") {
        await handle?.close().catch(() => {});
        handle = null;
        if (handle === null && error.code !== "EEXIST") throw error;
      }

      if (error.code === "EEXIST") {
        try {
          const stat = await fs.stat(lockPath);
          if (Date.now() - stat.mtimeMs > staleMs) {
            await fs.unlink(lockPath).catch((unlinkError) => {
              if (unlinkError.code !== "ENOENT") throw unlinkError;
            });
          }
        } catch (statError) {
          if (statError.code !== "ENOENT") throw statError;
        }
      }

      if (Date.now() - started >= timeoutMs) {
        throw new CliError(`timed out waiting for lock: ${lockPath}`, 1);
      }
      await sleep(50);
    }
  }

  try {
    return await operation();
  } finally {
    await handle.close().catch(() => {});
    try {
      const current = JSON.parse(await fs.readFile(lockPath, "utf8"));
      if (current.owner === owner) await fs.unlink(lockPath);
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) {
        // Never remove a lock whose ownership cannot be established.
      }
    }
  }
}

export async function updateJsonAtomic(filePath, mutator) {
  return withFileLock(`${filePath}.update.lock`, async () => {
    const current = await readJson(filePath);
    if (current === null) throw new Error(`JSON file not found: ${filePath}`);
    const replacement = await mutator(current);
    const next = replacement === undefined ? current : replacement;
    await writeJsonAtomic(filePath, next);
    return next;
  });
}

export async function loadSession(sessionId) {
  const session = await readJson(getSessionPaths(sessionId).metadata);
  if (!session) throw new CliError(`session not found: ${sessionId}`, 1);
  return session;
}

export async function updateSession(sessionId, mutator) {
  return updateJsonAtomic(getSessionPaths(sessionId).metadata, mutator);
}

async function agentLockIsStale(lock) {
  if (!lock || typeof lock.session_id !== "string") return true;
  if (!Number.isFinite(lock.expires_at) || lock.expires_at <= nowEpoch()) {
    return true;
  }

  let session;
  try {
    session = await readJson(getSessionPaths(lock.session_id).metadata);
  } catch {
    return true;
  }
  if (!session) return true;
  return (
    TERMINAL_STATUSES.has(session.status) ||
    REUSABLE_STATUSES.has(session.status)
  );
}

export async function acquireAgentLock(sessionId, expiresAt) {
  const paths = getPaths();
  await ensureDir(paths.browser);
  return withFileLock(`${paths.agentLock}.guard`, async () => {
    const current = await readJson(paths.agentLock);
    if (current && !(await agentLockIsStale(current))) {
      throw new CliError(`agent lock busy: ${current.session_id}`, 73);
    }
    if (current) await fs.unlink(paths.agentLock).catch(() => {});

    const lock = {
      session_id: sessionId,
      acquired_at: nowEpoch(),
      expires_at: expiresAt,
    };
    await writeJsonAtomic(paths.agentLock, lock);
    return lock;
  });
}

export async function releaseAgentLock(sessionId) {
  const paths = getPaths();
  return withFileLock(`${paths.agentLock}.guard`, async () => {
    const current = await readJson(paths.agentLock);
    if (!current || current.session_id !== sessionId) return false;
    await fs.unlink(paths.agentLock);
    await fs.unlink(`${paths.agentLock}.update.lock`).catch(() => {});
    return true;
  });
}

export async function removeStaleAgentLock() {
  const paths = getPaths();
  if (!(await pathExists(paths.agentLock))) return false;
  return withFileLock(`${paths.agentLock}.guard`, async () => {
    const current = await readJson(paths.agentLock);
    if (!current || !(await agentLockIsStale(current))) return false;
    await fs.unlink(paths.agentLock).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    return true;
  });
}

export async function liveAgentLock() {
  const paths = getPaths();
  const lock = await readJson(paths.agentLock);
  if (!lock) return null;
  if (await agentLockIsStale(lock)) {
    await removeStaleAgentLock();
    return null;
  }
  return lock;
}

export async function waitForAgentLock(waitSeconds = 0) {
  const deadline = Date.now() + waitSeconds * 1000;
  for (;;) {
    const lock = await liveAgentLock();
    if (!lock) return;
    if (Date.now() >= deadline) {
      throw new CliError(`handoff in progress: ${lock.session_id}`, 75);
    }
    await sleep(500);
  }
}

export async function logEvent(filePath, event, fields = {}) {
  await ensureDir(path.dirname(filePath));
  const entry = { at: nowEpoch(), event, ...fields };
  await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.chmod(filePath, 0o600);
}

export async function requestJson(urlString, timeoutMs = 1500) {
  const url = new URL(urlString);
  const client = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.get(
      url,
      { headers: { accept: "application/json" } },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
          if (body.length > 1024 * 1024) request.destroy(new Error("response too large"));
        });
        response.on("end", () => {
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(`HTTP ${response.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error("invalid JSON response"));
          }
        });
      },
    );
    request.setTimeout(timeoutMs, () => request.destroy(new Error("request timed out")));
    request.on("error", reject);
  });
}

export async function probeUnixHttp(socketPath, requestPath = "/", timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const request = http.get({ socketPath, path: requestPath }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode ?? 0));
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("request timed out")));
    request.on("error", reject);
  });
}

export function parsePositiveInteger(value, label, { allowZero = false, maximum } = {}) {
  const text = String(value);
  if (!/^\d+$/.test(text)) throw new CliError(`${label} must be an integer`, 64);
  const number = Number(text);
  const minimum = allowZero ? 0 : 1;
  if (
    !Number.isSafeInteger(number) ||
    number < minimum ||
    (maximum !== undefined && number > maximum)
  ) {
    throw new CliError(`${label} is out of range`, 64);
  }
  return number;
}

export async function readSecureJsonInput({ kind, fd, filePath, keepFile = false }) {
  let raw;
  if (kind === "file") {
    let handle;
    try {
      handle = await fs.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const stat = await handle.stat();
      const mode = stat.mode & 0o777;
      if (
        !stat.isFile() ||
        stat.uid !== process.getuid() ||
        (mode !== 0o600 && mode !== 0o400)
      ) {
        throw new CliError("input file must be a regular 0600/0400 file owned by this user", 64);
      }
      raw = await handle.readFile("utf8");
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError("could not read secure input file", 1);
    } finally {
      await handle?.close().catch(() => {});
    }
    if (!keepFile) await fs.unlink(filePath);
  } else {
    const inputFd = kind === "stdin" ? 0 : fd;
    if (!Number.isInteger(inputFd) || inputFd < 0) {
      throw new CliError("invalid input file descriptor", 64);
    }
    try {
      raw = readFileSync(inputFd, "utf8");
    } catch {
      throw new CliError("could not read secure form input", 1);
    }
  }

  if (Buffer.byteLength(raw, "utf8") > 1024 * 1024) {
    throw new CliError("secure form input is too large", 64);
  }
  try {
    const value = JSON.parse(raw);
    if (!value || Array.isArray(value) || typeof value !== "object") {
      throw new Error("not an object");
    }
    return value;
  } catch {
    throw new CliError("secure form input must be a JSON object", 64);
  }
}

export async function withCdpPage(cdpHttp, operation) {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    throw new Error("playwright is required to control the persistent browser");
  }

  let browser;
  try {
    browser = await chromium.connectOverCDP(cdpHttp);
    const context = browser.contexts()[0];
    const pages = context?.pages() ?? [];
    const page = pages.at(-1);
    if (!page) throw new Error("no browser page is available");
    page.setDefaultTimeout(10000);
    return await operation(page, browser);
  } finally {
    await browser?.close().catch(() => {});
  }
}

export async function fillKnownFields(session, values) {
  const names = [];
  for (const name of Object.keys(session.field_selectors ?? {})) {
    if (Object.hasOwn(values, name)) {
      if (typeof values[name] !== "string") {
        throw new CliError("form field values must be strings", 64);
      }
      names.push(name);
    }
  }

  try {
    await withCdpPage(session.cdp_http, async (page) => {
      for (const name of names) {
        await page.fill(session.field_selectors[name], values[name]);
      }
      if (session.submit_selector) await page.click(session.submit_selector);
    });
  } catch {
    throw new CliError("form fill failed", 1);
  }
  return names;
}

export function formatPublicHost(host) {
  if (host.includes(":") && !host.startsWith("[")) return `[${host}]`;
  return host;
}

export function mainError(error) {
  const message = error instanceof Error ? error.message : "unexpected error";
  process.stderr.write(`${message}\n`);
  process.exitCode = error instanceof CliError ? error.exitCode : 1;
}
