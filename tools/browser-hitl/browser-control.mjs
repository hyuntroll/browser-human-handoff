#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  CliError,
  REUSABLE_STATUSES,
  TERMINAL_STATUSES,
  ensureDir,
  getPaths,
  getSessionPaths,
  loadSession,
  mainError,
  nowEpoch,
  parsePositiveInteger,
  pathExists,
  pidAlive,
  printJson,
  readJson,
  readSecureJsonInput,
  updateSession,
  waitForAgentLock,
  withCdpPage,
  withFileLock,
} from "./hitl-lib.mjs";

const ACTIONS = new Set([
  "url",
  "title",
  "goto",
  "screenshot",
  "click",
  "fill",
  "press",
  "content",
  "cookies",
]);

function usage() {
  return new CliError(
    "usage: browser-control.mjs <action> [args...] or <session_id> <action> [args...]",
    64,
  );
}

function parseFillInput(args) {
  let source = null;
  let keepFile = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--keep-file") {
      keepFile = true;
      continue;
    }
    let selected;
    if (argument === "--stdin") {
      selected = { kind: "stdin" };
    } else if (argument === "--fd" || argument === "--file") {
      const value = args[index + 1];
      if (value === undefined) throw new CliError(`${argument} requires a value`, 64);
      index += 1;
      selected =
        argument === "--fd"
          ? {
              kind: "fd",
              fd: parsePositiveInteger(value, "--fd", {
                allowZero: true,
                maximum: 1024,
              }),
            }
          : { kind: "file", filePath: value };
    } else {
      throw new CliError(
        "fill values must come from --stdin, --fd, or --file as {\"value\":...}",
        64,
      );
    }
    if (source) throw new CliError("choose exactly one secure input source", 64);
    source = selected;
  }
  if (!source) throw new CliError("choose exactly one secure input source", 64);
  if (keepFile && source.kind !== "file") {
    throw new CliError("--keep-file is valid only with --file", 64);
  }
  return { ...source, keepFile };
}

function requireArgument(args, index, label) {
  const value = args[index];
  if (value === undefined || value === "") {
    throw new CliError(`${label} is required`, 64);
  }
  return value;
}

async function resolveInvocation() {
  let [action, ...args] = process.argv.slice(2);
  if (!action) throw usage();
  let sessionId = null;

  try {
    const candidate = getSessionPaths(action);
    if (await pathExists(candidate.metadata)) {
      sessionId = action;
      action = args.shift();
    }
  } catch {
    // Action-first invocation does not name a session.
  }

  if (!action || !ACTIONS.has(action)) throw usage();
  return { sessionId, action, args };
}

async function validateLegacySession(sessionId) {
  if (!sessionId) return null;
  const session = await loadSession(sessionId);
  if (TERMINAL_STATUSES.has(session.status)) {
    throw new Error(`handoff session is not reusable: ${session.status}`);
  }
  if (!REUSABLE_STATUSES.has(session.status)) {
    throw new Error(`handoff session is not resumable: ${session.status}`);
  }
  if (session.cdp_http !== (await readJson(getPaths().endpoint))?.cdp_http) {
    throw new Error("session and persistent browser endpoints do not match");
  }
  return session;
}

async function screenshotPath(sessionId, requested) {
  if (requested) {
    const target = path.resolve(requested);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    return target;
  }
  const directory = sessionId
    ? getSessionPaths(sessionId).artifacts
    : path.join(getPaths().browser, "artifacts");
  await ensureDir(directory);
  return path.join(directory, `screenshot-${Date.now()}.png`);
}

async function performAction({ sessionId, action, args, fillValue }) {
  const endpoint = await readJson(getPaths().endpoint);
  if (!endpoint || !pidAlive(endpoint.chromium_pid)) {
    throw new Error("persistent browser is not running; run hitl-browser.mjs ensure");
  }

  const output = await withCdpPage(endpoint.cdp_http, async (page, browser) => {
    switch (action) {
      case "url":
        if (args.length) throw usage();
        return { value: page.url() };
      case "title":
        if (args.length) throw usage();
        return { value: await page.title() };
      case "goto": {
        const target = requireArgument(args, 0, "target URL");
        if (args.length !== 1) throw usage();
        await page.goto(target, { waitUntil: "domcontentloaded" });
        return { value: page.url() };
      }
      case "screenshot": {
        if (args.length > 1) throw usage();
        const target = await screenshotPath(sessionId, args[0]);
        await page.screenshot({ path: target, fullPage: true });
        await fs.chmod(target, 0o600);
        return { path: target };
      }
      case "click": {
        const selector = requireArgument(args, 0, "selector");
        if (args.length !== 1) throw usage();
        await page.click(selector);
        return { selector };
      }
      case "fill": {
        const selector = requireArgument(args, 0, "selector");
        if (args.length < 2) {
          throw new CliError("fill requires a selector and a secure input source", 64);
        }
        try {
          await page.fill(selector, fillValue);
        } catch {
          throw new Error("fill action failed");
        }
        return { selector, filled: true };
      }
      case "press": {
        const key = requireArgument(args, 0, "key");
        if (args.length !== 1) throw usage();
        await page.keyboard.press(key);
        return { key };
      }
      case "content":
        if (args.length) throw usage();
        return { value: await page.content() };
      case "cookies": {
        if (args.length) throw usage();
        const context = browser.contexts()[0];
        const cookies = await context.cookies();
        return {
          cookies: cookies.map((cookie) => ({
            name: cookie.name,
            domain: cookie.domain,
          })),
        };
      }
      default:
        throw usage();
    }
  });

  if (sessionId) {
    await updateSession(sessionId, (session) => {
      if (REUSABLE_STATUSES.has(session.status)) {
        session.status = "RESUMED";
        session.last_action = action;
        session.last_url = output.value && action !== "content" ? output.value : undefined;
        if (action === "screenshot") session.last_screenshot = output.path;
      }
    });
  }

  return {
    ...(sessionId ? { session_id: sessionId } : {}),
    action,
    ...(sessionId ? { status: "RESUMED" } : {}),
    ...output,
  };
}

async function main() {
  const invocation = await resolveInvocation();
  const { sessionId, action, args } = invocation;
  await validateLegacySession(sessionId);

  if (action === "fill") {
    const source = parseFillInput(args.slice(1));
    const input = await readSecureJsonInput(source);
    if (typeof input.value !== "string") {
      throw new CliError("secure fill input must contain a string value", 64);
    }
    invocation.fillValue = input.value;
  }

  const waitSeconds = parsePositiveInteger(
    process.env.BROWSER_HANDOFF_LOCK_WAIT_SECONDS ?? "0",
    "BROWSER_HANDOFF_LOCK_WAIT_SECONDS",
    { allowZero: true },
  );
  await waitForAgentLock(waitSeconds);

  const output = await withFileLock(getPaths().operationLock, async () => {
    await waitForAgentLock(0);
    await validateLegacySession(sessionId);
    return performAction(invocation);
  });
  printJson({ ...output, completed_at: nowEpoch() });
}

main().catch(mainError);
