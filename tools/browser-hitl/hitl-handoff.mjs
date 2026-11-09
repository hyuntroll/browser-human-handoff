#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { ensureBrowser } from "./hitl-browser.mjs";
import {
  CliError,
  TERMINAL_STATUSES,
  acquireAgentLock,
  ensureDir,
  fillKnownFields,
  formatPublicHost,
  getPaths,
  getSessionPaths,
  loadSession,
  mainError,
  nowEpoch,
  parsePositiveInteger,
  pathExists,
  pidAlive,
  printJson,
  randomId,
  randomToken,
  readJson,
  readSecureJsonInput,
  releaseAgentLock,
  removeStaleAgentLock,
  sha256,
  sleep,
  terminatePid,
  updateSession,
  withCdpPage,
  withFileLock,
  writeJsonAtomic,
} from "./hitl-lib.mjs";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

function takeValue(args, index, option) {
  const value = args[index + 1];
  if (value === undefined) throw new CliError(`${option} requires a value`, 64);
  return value;
}

function parseOpenArguments(args) {
  const options = {
    targetUrl: null,
    current: false,
    mode: null,
    fields: {},
    submitSelector: null,
    ttl: parsePositiveInteger(
      process.env.BROWSER_HANDOFF_TTL_SECONDS ?? "900",
      "BROWSER_HANDOFF_TTL_SECONDS",
    ),
    reason: null,
    headless: false,
  };
  const fieldNames = new Set();

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    switch (argument) {
      case "--current":
        options.current = true;
        break;
      case "--mode": {
        options.mode = takeValue(args, index, argument);
        index += 1;
        break;
      }
      case "--field": {
        const declaration = takeValue(args, index, argument);
        index += 1;
        const separator = declaration.indexOf("=");
        const name = separator > 0 ? declaration.slice(0, separator) : "";
        const selector = separator > 0 ? declaration.slice(separator + 1) : "";
        if (!name || !selector) {
          throw new CliError("--field must be name=css_selector", 64);
        }
        if (fieldNames.has(name)) throw new CliError(`duplicate field: ${name}`, 64);
        fieldNames.add(name);
        options.fields[name] = selector;
        break;
      }
      case "--submit":
        options.submitSelector = takeValue(args, index, argument);
        index += 1;
        break;
      case "--ttl":
        options.ttl = parsePositiveInteger(
          takeValue(args, index, argument),
          "--ttl",
        );
        index += 1;
        break;
      case "--reason":
        options.reason = takeValue(args, index, argument);
        index += 1;
        break;
      case "--headless":
        options.headless = true;
        break;
      default:
        if (argument.startsWith("-")) {
          throw new CliError(`unknown open option: ${argument}`, 64);
        }
        if (options.targetUrl !== null) {
          throw new CliError("open accepts only one target URL", 64);
        }
        options.targetUrl = argument;
    }
  }

  if (options.current && options.targetUrl !== null) {
    throw new CliError("--current cannot be combined with a target URL", 64);
  }
  if (!options.current && options.targetUrl === null) options.targetUrl = "about:blank";
  if (options.mode !== null && !["form", "browser"].includes(options.mode)) {
    throw new CliError("--mode must be form or browser", 64);
  }
  options.mode ??= fieldNames.size > 0 ? "form" : "browser";
  return options;
}

async function spawnDetached(scriptName, sessionId, logPath) {
  await ensureDir(path.dirname(logPath));
  const handle = await fs.open(logPath, "a", 0o600);
  await fs.chmod(logPath, 0o600);
  let child;
  const state = { error: false, exited: false };
  try {
    child = spawn(
      process.execPath,
      [path.join(moduleDirectory, scriptName), sessionId],
      {
        detached: true,
        env: { ...process.env },
        stdio: ["ignore", handle.fd, handle.fd],
      },
    );
    child.once("error", () => {
      state.error = true;
    });
    child.once("exit", () => {
      state.exited = true;
    });
    child.unref();
  } finally {
    await handle.close();
  }
  if (!child.pid) throw new Error(`failed to spawn ${scriptName}`);
  return { child, state };
}

async function waitForGateway(sessionId, spawned) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (spawned.state.error || spawned.state.exited) {
      throw new Error("gateway exited before becoming ready");
    }
    const session = await loadSession(sessionId);
    if (
      session.gateway?.pid === spawned.child.pid &&
      Number.isInteger(session.gateway.port) &&
      session.gateway.port > 0
    ) {
      return session;
    }
    await sleep(100);
  }
  throw new Error("gateway did not report its listening port");
}

function makeHandoffUrl(token, port) {
  const override = process.env.BROWSER_HANDOFF_PUBLIC_BASE_URL;
  if (override) {
    const url = new URL(override);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      throw new CliError("BROWSER_HANDOFF_PUBLIC_BASE_URL must be an HTTP(S) URL", 64);
    }
    return `${override.replace(/\/+$/, "")}/t/${token}`;
  }
  const bindHost = process.env.BROWSER_HANDOFF_BIND_HOST ?? "127.0.0.1";
  const publicHost = process.env.BROWSER_HANDOFF_PUBLIC_HOST ?? bindHost;
  const scheme = process.env.BROWSER_HANDOFF_PUBLIC_SCHEME ?? "http";
  if (!["http", "https"].includes(scheme)) {
    throw new CliError("BROWSER_HANDOFF_PUBLIC_SCHEME must be http or https", 64);
  }
  return `${scheme}://${formatPublicHost(publicHost)}:${port}/t/${token}`;
}

async function failOpen(sessionId, gatewayPid, watcherPid) {
  if (gatewayPid) await terminatePid(gatewayPid, 1000).catch(() => {});
  if (watcherPid) await terminatePid(watcherPid, 1000).catch(() => {});
  if (await pathExists(getSessionPaths(sessionId).metadata)) {
    await updateSession(sessionId, (session) => {
      session.share_active = false;
      if (!TERMINAL_STATUSES.has(session.status)) {
        session.status = "FAILED";
        session.closed_at = nowEpoch();
        session.closed_reason = "open_failed";
        session.last_action = "open_failed";
      }
    }).catch(() => {});
  }
  await releaseAgentLock(sessionId).catch(() => {});
}

async function openHandoff(args) {
  const options = parseOpenArguments(args);
  if (process.env.BROWSER_HANDOFF_RUN_CLEANUP_BEFORE_OPEN === "1") {
    await cleanupSessions();
  }

  const sessionId = randomId();
  const sessionPaths = getSessionPaths(sessionId);
  const createdAt = nowEpoch();
  const expiresAt = createdAt + options.ttl;
  if (!Number.isSafeInteger(expiresAt)) throw new CliError("--ttl is out of range", 64);
  const { endpoint } = await ensureBrowser({ headless: options.headless });
  const paths = getPaths();
  let lockHeld = false;
  let gatewayPid = null;
  let watcherPid = null;

  try {
    return await withFileLock(paths.operationLock, async () => {
      await acquireAgentLock(sessionId, expiresAt);
      lockHeld = true;
      let actualUrl;
      try {
        actualUrl = await withCdpPage(endpoint.cdp_http, async (page) => {
          if (!options.current) {
            await page.goto(options.targetUrl, {
              waitUntil: "domcontentloaded",
              timeout: 20000,
            });
          }
          return page.url();
        });

        await ensureDir(sessionPaths.directory);
        const token = randomToken(32);
        const session = {
          session_id: sessionId,
          status: "WAITING_FOR_USER",
          mode: options.mode,
          fields: Object.keys(options.fields),
          field_selectors: options.fields,
          submit_selector: options.submitSelector,
          target_url: actualUrl,
          reason: options.reason,
          created_at: createdAt,
          expires_at: expiresAt,
          ttl_seconds: options.ttl,
          gateway: {
            pid: null,
            bind_host: process.env.BROWSER_HANDOFF_BIND_HOST ?? "127.0.0.1",
            port: null,
          },
          watcher_pid: null,
          token_sha256: sha256(token),
          token_used_at: null,
          share_active: true,
          done_at: null,
          closed_at: null,
          closed_reason: null,
          last_action: "opened",
          cdp_http: endpoint.cdp_http,
          form_filled_fields: [],
        };
        await writeJsonAtomic(sessionPaths.metadata, session);

        const gateway = await spawnDetached(
          "hitl-gateway.mjs",
          sessionId,
          sessionPaths.gatewayLog,
        );
        gatewayPid = gateway.child.pid;
        await updateSession(sessionId, (current) => {
          current.gateway.pid = gatewayPid;
        });
        const ready = await waitForGateway(sessionId, gateway);

        const watcher = await spawnDetached(
          "hitl-watcher.mjs",
          sessionId,
          sessionPaths.watcherLog,
        );
        watcherPid = watcher.child.pid;
        await updateSession(sessionId, (current) => {
          current.watcher_pid = watcherPid;
        });

        return {
          output: {
            session_id: sessionId,
            status: "WAITING_FOR_USER",
            mode: ready.mode,
            fields: ready.fields,
            handoff_url: makeHandoffUrl(token, ready.gateway.port),
            expires_at: expiresAt,
            ttl_seconds: options.ttl,
            share_available: endpoint.share_available !== false,
          },
        };
      } catch (error) {
        await failOpen(sessionId, gatewayPid, watcherPid);
        lockHeld = false;
        throw error;
      }
    });
  } catch (error) {
    if (lockHeld) {
      await failOpen(sessionId, gatewayPid, watcherPid);
    }
    throw error;
  }
}

async function stopGateway(session) {
  if (session.gateway?.pid) await terminatePid(session.gateway.pid, 3000).catch(() => {});
}

async function expireSession(sessionId) {
  const session = await loadSession(sessionId);
  await stopGateway(session);
  const updated = await updateSession(sessionId, (current) => {
    current.share_active = false;
    if (current.status === "WAITING_FOR_USER") {
      current.status = "EXPIRED";
      current.closed_at = nowEpoch();
      current.closed_reason = "ttl_expired";
      current.last_action = "expired";
    }
  });
  await releaseAgentLock(sessionId);
  return updated;
}

async function sessionStatus(sessionId) {
  let session = await loadSession(sessionId);
  if (session.status === "WAITING_FOR_USER" && nowEpoch() >= session.expires_at) {
    session = await expireSession(sessionId);
  }
  const endpoint = await readJson(getPaths().endpoint);
  return {
    ...session,
    gateway_alive: pidAlive(session.gateway?.pid),
    watcher_alive: pidAlive(session.watcher_pid),
    browser_alive: Boolean(
      endpoint &&
        endpoint.cdp_http === session.cdp_http &&
        pidAlive(endpoint.chromium_pid),
    ),
    share_available: Boolean(
      endpoint && !endpoint.headless && endpoint.cdp_http === session.cdp_http,
    ),
    expired: nowEpoch() >= session.expires_at,
    now: nowEpoch(),
  };
}

async function doneHandoff(sessionId) {
  let session = await loadSession(sessionId);
  if (session.status === "CLOSED") return sessionStatus(sessionId);
  await updateSession(sessionId, (current) => {
    current.share_active = false;
    if (current.status === "WAITING_FOR_USER") {
      current.status = "RESUMABLE";
      current.done_at = nowEpoch();
      current.last_action = "done";
    }
  });
  await releaseAgentLock(sessionId);
  session = await loadSession(sessionId);
  await stopGateway(session);
  return sessionStatus(sessionId);
}

async function closeHandoff(sessionId, reason = "manual_close") {
  let session = await loadSession(sessionId);
  await updateSession(sessionId, (current) => {
    current.share_active = false;
    if (current.status !== "CLOSED") {
      current.status = "CLOSED";
      current.closed_at = nowEpoch();
      current.closed_reason = reason;
      current.last_action = "closed";
    }
  });
  await releaseAgentLock(sessionId);
  session = await loadSession(sessionId);
  await stopGateway(session);
  if (session.watcher_pid) await terminatePid(session.watcher_pid, 1000).catch(() => {});
  return sessionStatus(sessionId);
}

async function switchHandoff(sessionId, mode) {
  if (!["form", "browser"].includes(mode)) {
    throw new CliError("switch requires form or browser mode", 64);
  }
  const session = await loadSession(sessionId);
  if (session.status !== "WAITING_FOR_USER") {
    throw new Error("only a waiting handoff can change mode");
  }
  if (mode === "form" && !(session.fields ?? []).length) {
    throw new Error("this handoff has no form fields");
  }
  await updateSession(sessionId, (current) => {
    if (current.status === "WAITING_FOR_USER") {
      current.mode = mode;
      current.last_action = "mode_changed";
    }
  });
  return sessionStatus(sessionId);
}

async function waitHandoff(sessionId, timeout) {
  const deadline = timeout === null ? null : Date.now() + timeout * 1000;
  for (;;) {
    let session = await loadSession(sessionId);
    if (session.status === "WAITING_FOR_USER" && nowEpoch() >= session.expires_at) {
      session = await expireSession(sessionId);
    }
    if (
      ["RESUMABLE", "RESUMED", "EXPIRED", "CLOSED", "FAILED"].includes(
        session.status,
      )
    ) {
      return sessionStatus(sessionId);
    }
    if (deadline !== null && Date.now() >= deadline) {
      throw new CliError("wait timed out", 1);
    }
    await sleep(250);
  }
}

async function cleanupSessions() {
  const paths = getPaths();
  await ensureDir(paths.sessions);
  const expired = [];
  const removed = [];
  const entries = await fs.readdir(paths.sessions, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let sessionPaths;
    try {
      sessionPaths = getSessionPaths(entry.name);
    } catch {
      continue;
    }
    const session = await readJson(sessionPaths.metadata);
    if (!session) continue;

    if (session.status === "WAITING_FOR_USER" && nowEpoch() >= session.expires_at) {
      await expireSession(entry.name);
      expired.push(entry.name);
      continue;
    }

    if (TERMINAL_STATUSES.has(session.status)) {
      const completedAt =
        session.closed_at ?? session.done_at ?? session.expires_at ?? session.created_at;
      if (nowEpoch() - completedAt >= 24 * 60 * 60) {
        await fs.rm(sessionPaths.directory, { recursive: true, force: true });
        removed.push(entry.name);
      }
    }
  }
  await removeStaleAgentLock();
  return { expired, removed };
}

function parseSecureInput(args) {
  let source = null;
  let keepFile = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--keep-file") {
      keepFile = true;
      continue;
    }
    let nextSource;
    if (argument === "--stdin") {
      nextSource = { kind: "stdin" };
    } else if (argument === "--fd") {
      const value = takeValue(args, index, argument);
      index += 1;
      nextSource = {
        kind: "fd",
        fd: parsePositiveInteger(value, "--fd", { allowZero: true, maximum: 1024 }),
      };
    } else if (argument === "--file") {
      nextSource = { kind: "file", filePath: takeValue(args, index, argument) };
      index += 1;
    } else {
      throw new CliError("fill accepts values only through --stdin, --fd, or --file", 64);
    }
    if (source) throw new CliError("choose exactly one secure input source", 64);
    source = nextSource;
  }
  if (!source) throw new CliError("choose exactly one secure input source", 64);
  if (keepFile && source.kind !== "file") {
    throw new CliError("--keep-file is valid only with --file", 64);
  }
  return { ...source, keepFile };
}

async function fillHandoff(sessionId, args) {
  let session = await loadSession(sessionId);
  if (session.status !== "WAITING_FOR_USER") {
    throw new Error("runtime fill requires a WAITING_FOR_USER session");
  }
  if (nowEpoch() >= session.expires_at) {
    await expireSession(sessionId);
    throw new Error("handoff session has expired");
  }
  const source = parseSecureInput(args);
  const values = await readSecureJsonInput(source);
  session = await loadSession(sessionId);
  if (session.status !== "WAITING_FOR_USER" || nowEpoch() >= session.expires_at) {
    throw new Error("handoff session is no longer active");
  }
  const filled = await fillKnownFields(session, values);
  await updateSession(sessionId, (current) => {
    if (current.status === "WAITING_FOR_USER") {
      current.form_filled_fields = [
        ...new Set([...(current.form_filled_fields ?? []), ...filled]),
      ];
      current.last_action = "form_filled";
    }
  });
  return { ok: true, filled };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "open": {
      const { output } = await openHandoff(args);
      printJson(output);
      break;
    }
    case "status": {
      if (args.length !== 1) throw new CliError("usage: hitl-handoff.mjs status <id>", 64);
      printJson(await sessionStatus(args[0]));
      break;
    }
    case "done": {
      if (args.length !== 1) throw new CliError("usage: hitl-handoff.mjs done <id>", 64);
      printJson(await doneHandoff(args[0]));
      break;
    }
    case "switch": {
      if (args.length === 3 && args[1] === "--mode") args.splice(1, 1);
      if (args.length !== 2) {
        throw new CliError("usage: hitl-handoff.mjs switch <id> <form|browser>", 64);
      }
      printJson(await switchHandoff(args[0], args[1]));
      break;
    }
    case "wait": {
      if (![1, 3].includes(args.length) || (args.length === 3 && args[1] !== "--timeout")) {
        throw new CliError("usage: hitl-handoff.mjs wait <id> [--timeout seconds]", 64);
      }
      const timeout =
        args.length === 3
          ? parsePositiveInteger(args[2], "--timeout", { allowZero: true })
          : null;
      printJson(await waitHandoff(args[0], timeout));
      break;
    }
    case "close": {
      if (args.length < 1 || args.length > 2) {
        throw new CliError("usage: hitl-handoff.mjs close <id> [reason]", 64);
      }
      printJson(await closeHandoff(args[0], args[1]));
      break;
    }
    case "cleanup":
      if (args.length) throw new CliError("usage: hitl-handoff.mjs cleanup", 64);
      printJson(await cleanupSessions());
      break;
    case "fill":
      if (!args[0]) throw new CliError("usage: hitl-handoff.mjs fill <id> <input option>", 64);
      printJson(await fillHandoff(args[0], args.slice(1)));
      break;
    default:
      throw new CliError(
        "usage: hitl-handoff.mjs <open|status|done|switch|wait|close|cleanup|fill> [args...]",
        64,
      );
  }
}

main().catch(mainError);
