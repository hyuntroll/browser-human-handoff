#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import {
  CliError,
  ensureDir,
  getPaths,
  mainError,
  pathExists,
  pidAlive,
  printJson,
  probeUnixHttp,
  readJson,
  requestJson,
  sleep,
  terminatePid,
  withFileLock,
  writeJsonAtomic,
  nowEpoch,
} from "./hitl-lib.mjs";

function headlessRequested(options = {}) {
  return options.headless === true || process.env.BROWSER_HANDOFF_HEADLESS === "1";
}

async function findExecutable(names) {
  for (const name of names) {
    if (name.includes(path.sep)) {
      try {
        await fs.access(name, fs.constants.X_OK);
        return name;
      } catch {
        continue;
      }
    }
    for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
      if (!directory) continue;
      const candidate = path.join(directory, name);
      try {
        await fs.access(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // Keep looking.
      }
    }
  }
  return null;
}

async function chromiumBinary() {
  const configured = process.env.BROWSER_HANDOFF_CHROMIUM_BIN;
  const binary = await findExecutable([
    ...(configured ? [configured] : []),
    "chromium-browser",
    "chromium",
    "google-chrome",
    "google-chrome-stable",
  ]);
  if (!binary) throw new Error("Chromium executable not found");
  return binary;
}

async function validEndpoint(endpoint) {
  if (
    !endpoint ||
    !pidAlive(endpoint.chromium_pid) ||
    typeof endpoint.cdp_http !== "string" ||
    typeof endpoint.cdp_ws !== "string"
  ) {
    return null;
  }
  try {
    const version = await requestJson(
      `${endpoint.cdp_http.replace(/\/$/, "")}/json/version`,
    );
    return version.webSocketDebuggerUrl === endpoint.cdp_ws ? endpoint : null;
  } catch {
    return null;
  }
}

async function xpraAlive(socketPath) {
  try {
    const stat = await fs.lstat(socketPath);
    if (!stat.isSocket()) return false;
    const status = await probeUnixHttp(socketPath, "/index.html");
    return status >= 200 && status < 400;
  } catch {
    return false;
  }
}

async function waitForXpra(socketPath, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await xpraAlive(socketPath)) return;
    await sleep(200);
  }
  throw new Error("Xpra HTML5 socket did not become ready");
}

async function freeDisplay() {
  for (let number = 100; number <= 199; number += 1) {
    if (!(await pathExists(`/tmp/.X11-unix/X${number}`))) return `:${number}`;
  }
  throw new Error("no free Xpra display is available in the range 100..199");
}

async function runToLog(command, args, logPath, env = process.env, timeoutMs = 0) {
  await ensureDir(path.dirname(logPath));
  const handle = await fs.open(logPath, "a", 0o600);
  await fs.chmod(logPath, 0o600);
  let child;
  try {
    child = spawn(command, args, {
      env: { ...env },
      stdio: ["ignore", handle.fd, handle.fd],
      ...(timeoutMs > 0 ? { timeout: timeoutMs, killSignal: "SIGKILL" } : {}),
    });
  } finally {
    await handle.close();
  }

  return new Promise((resolve, reject) => {
    child.once("error", () => reject(new Error(`${path.basename(command)} failed to start`)));
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(command)} exited with status ${code ?? "unknown"}`));
    });
  });
}

async function startXpra(paths, display) {
  const xpra = await findExecutable([process.env.BROWSER_HANDOFF_XPRA_BIN ?? "xpra"]);
  if (!xpra) throw new Error("xpra executable not found");
  await ensureDir(paths.xpra);
  await ensureDir(paths.logs);
  await fs.unlink(paths.xpraSocket).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });

  const logPath = path.join(paths.logs, "xpra.log");
  const pidPath = path.join(paths.xpra, "server.pid");
  await runToLog(xpra, [
    "start",
    display,
    `--bind=${paths.xpraSocket}`,
    "--html=on",
    "--daemon=yes",
    "--exit-with-children=no",
    "--mdns=no",
    "--pulseaudio=no",
    "--notifications=no",
    "--webcam=no",
    "--printing=no",
    "--file-transfer=no",
    "--systemd-run=no",
    `--pidfile=${pidPath}`,
    `--log-file=${logPath}`,
  ], logPath);
  await waitForXpra(paths.xpraSocket);
  await fs.chmod(logPath, 0o600);
  await fs.chmod(pidPath, 0o600);
  const xpraPid = Number((await fs.readFile(pidPath, "utf8")).trim());
  if (!Number.isInteger(xpraPid) || xpraPid <= 0 || !pidAlive(xpraPid)) {
    throw new Error("Xpra did not record a live server pid");
  }
  return xpraPid;
}

async function stopXpra(display, xpraPid = null) {
  if (!display || !/^:\d+$/.test(display)) return;
  const paths = getPaths();
  const serverWasAlive = Number.isInteger(xpraPid) && pidAlive(xpraPid);
  const xpra = await findExecutable([process.env.BROWSER_HANDOFF_XPRA_BIN ?? "xpra"]);
  if (xpra) {
    try {
      await runToLog(
        xpra,
        ["stop", display],
        path.join(paths.logs, "xpra.log"),
        process.env,
        3000,
      );
    } catch {
      // Fall back to the recorded server pid below.
    }
  }
  if (serverWasAlive && pidAlive(xpraPid)) await terminatePid(xpraPid, 5000);
}

async function readDevToolsEndpoint(profile) {
  const activePortPath = path.join(profile, "DevToolsActivePort");
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const contents = await fs.readFile(activePortPath, "utf8");
      const [portLine, wsPath, ...rest] = contents.trim().split(/\r?\n/);
      const port = Number(portLine);
      if (
        Number.isInteger(port) &&
        port > 0 &&
        port <= 65535 &&
        wsPath?.startsWith("/") &&
        rest.length === 0
      ) {
        return {
          port,
          ws: `ws://127.0.0.1:${port}${wsPath}`,
        };
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        // Chrome may still be writing the file; retry until the deadline.
      }
    }
    await sleep(100);
  }
  throw new Error("DevToolsActivePort did not become ready");
}

async function launchBrowser({ headless, previousEndpoint }) {
  const paths = getPaths();
  await Promise.all([
    ensureDir(paths.base),
    ensureDir(paths.browser),
    ensureDir(paths.profile),
    ensureDir(paths.logs),
  ]);

  let display = null;
  let xpraStarted = false;
  let xpraPid = null;
  if (!headless) {
    if (
      previousEndpoint?.display &&
      (await xpraAlive(paths.xpraSocket))
    ) {
      display = previousEndpoint.display;
      xpraPid = previousEndpoint.xpra_pid ?? null;
    } else {
      display = await freeDisplay();
      xpraPid = await startXpra(paths, display);
      xpraStarted = true;
    }
  }

  const binary = await chromiumBinary();
  const activePortPath = path.join(paths.profile, "DevToolsActivePort");
  await fs.unlink(activePortPath).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });

  const chromiumLog = path.join(paths.logs, "chromium.log");
  const logHandle = await fs.open(chromiumLog, "a", 0o600);
  await fs.chmod(chromiumLog, 0o600);
  const args = [
    `--user-data-dir=${paths.profile}`,
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-dev-shm-usage",
    "--password-store=basic",
    "--start-maximized",
  ];
  if (headless) args.push("--headless=new");
  if (process.getuid?.() === 0) args.push("--no-sandbox");
  args.push("about:blank");

  let child;
  let launchError = null;
  let exited = false;
  try {
    child = spawn(binary, args, {
      detached: true,
      env: { ...process.env, ...(display ? { DISPLAY: display } : {}) },
      stdio: ["ignore", logHandle.fd, logHandle.fd],
    });
    child.once("error", () => {
      launchError = new Error("Chromium failed to start");
    });
    child.once("exit", () => {
      exited = true;
    });
    child.unref();
  } finally {
    await logHandle.close();
  }

  try {
    const deadline = Date.now() + 20000;
    let devtools;
    while (!devtools && Date.now() < deadline) {
      if (launchError) throw launchError;
      if (exited) throw new Error("Chromium exited before CDP became ready");
      try {
        devtools = await readDevToolsEndpoint(paths.profile);
      } catch (error) {
        if (Date.now() >= deadline) throw error;
      }
      if (!devtools) await sleep(100);
    }
    if (!devtools) throw new Error("DevToolsActivePort did not become ready");

    const cdpHttp = `http://127.0.0.1:${devtools.port}`;
    const version = await requestJson(`${cdpHttp}/json/version`, 2000);
    if (version.webSocketDebuggerUrl !== devtools.ws) {
      throw new Error("CDP websocket endpoint did not match DevToolsActivePort");
    }

    const endpoint = {
      display,
      xpra_socket: headless ? null : paths.xpraSocket,
      xpra_pid: xpraPid,
      chromium_pid: child.pid,
      cdp_port: devtools.port,
      cdp_http: cdpHttp,
      cdp_ws: devtools.ws,
      profile_dir: paths.profile,
      started_at: nowEpoch(),
      headless,
      share_available: !headless,
    };
    await writeJsonAtomic(paths.endpoint, endpoint);
    return endpoint;
  } catch (error) {
    if (child?.pid) await terminatePid(child.pid, 3000).catch(() => {});
    if (xpraStarted && display) await stopXpra(display, xpraPid);
    throw error;
  }
}

export async function ensureBrowser(options = {}) {
  const paths = getPaths();
  await Promise.all([ensureDir(paths.base), ensureDir(paths.browser)]);
  return withFileLock(
    paths.ensureLock,
    async () => {
      const previous = await readJson(paths.endpoint);
      const reusable = await validEndpoint(previous);
      if (reusable) return { endpoint: reusable, reused: true };
      if (previous && pidAlive(previous.chromium_pid)) {
        throw new Error("recorded Chromium is alive but its CDP endpoint is invalid");
      }
      const endpoint = await launchBrowser({
        headless: headlessRequested(options),
        previousEndpoint: previous,
      });
      return { endpoint, reused: false };
    },
    { timeoutMs: 90000, staleMs: 60000 },
  );
}

async function browserStatus() {
  const endpoint = await readJson(getPaths().endpoint);
  if (!endpoint) {
    return {
      available: false,
      alive: false,
      chromium_alive: false,
      cdp_alive: false,
      xpra_alive: false,
      share_available: false,
    };
  }
  const valid = await validEndpoint(endpoint);
  const xpraUp = endpoint.headless ? false : await xpraAlive(endpoint.xpra_socket);
  return {
    ...endpoint,
    available: true,
    alive: Boolean(valid),
    chromium_alive: pidAlive(endpoint.chromium_pid),
    cdp_alive: Boolean(valid),
    xpra_alive: xpraUp,
    share_available: !endpoint.headless && xpraUp,
  };
}

async function stopBrowser() {
  const paths = getPaths();
  const endpoint = await readJson(paths.endpoint);
  if (!endpoint) return { stopped: false, alive: false };
  if (endpoint.chromium_pid) await terminatePid(endpoint.chromium_pid, 5000);
  if (endpoint.display) await stopXpra(endpoint.display, endpoint.xpra_pid);
  await fs.unlink(paths.endpoint).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  return { stopped: true, alive: false };
}

async function resetProfile(yes) {
  if (!yes) throw new CliError("reset-profile requires --yes", 64);
  const paths = getPaths();
  const endpoint = await readJson(paths.endpoint);
  if (endpoint && pidAlive(endpoint.chromium_pid)) {
    throw new Error("stop the persistent browser before resetting its profile");
  }
  await fs.rm(paths.profile, { recursive: true, force: true });
  await ensureDir(paths.profile);
  return { profile_reset: true };
}

function parseHeadless(args) {
  const headless = args.includes("--headless");
  const rest = args.filter((argument) => argument !== "--headless");
  if (rest.length) throw new CliError("usage: hitl-browser.mjs ensure [--headless]", 64);
  return headless;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "ensure": {
      const result = await ensureBrowser({ headless: parseHeadless(args) });
      printJson({ ...result.endpoint, reused: result.reused });
      break;
    }
    case "status":
      if (args.length) throw new CliError("usage: hitl-browser.mjs status", 64);
      printJson(await browserStatus());
      break;
    case "stop":
      if (args.length) throw new CliError("usage: hitl-browser.mjs stop", 64);
      printJson(await stopBrowser());
      break;
    case "reset-profile":
      printJson(await resetProfile(args.length === 1 && args[0] === "--yes"));
      break;
    default:
      throw new CliError(
        "usage: hitl-browser.mjs <ensure|status|stop|reset-profile> [options]",
        64,
      );
  }
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  main().catch(mainError);
}
