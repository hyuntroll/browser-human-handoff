#!/usr/bin/env node

import http from "node:http";
import net from "node:net";
import process from "node:process";
import {
  CliError,
  constantTimeEqual,
  fillKnownFields,
  formatPublicHost,
  getPaths,
  getSessionPaths,
  loadSession,
  logEvent,
  mainError,
  nowEpoch,
  parsePositiveInteger,
  randomToken,
  readJson,
  releaseAgentLock,
  sha256,
  updateSession,
} from "./hitl-lib.mjs";

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const sessionId = process.argv[2];
const paths = getSessionPaths(sessionId ?? "invalid");
let cookieHash = null;
let server;
let closing = false;
const sockets = new Set();
let actionChain = Promise.resolve();

function serialize(operation) {
  const result = actionChain.then(operation, operation);
  actionChain = result.catch(() => {});
  return result;
}

function expired(session) {
  return nowEpoch() >= session.expires_at;
}

function baseHeaders() {
  return {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
}

function sendJson(response, status, value) {
  if (response.destroyed) return;
  const body = JSON.stringify(value);
  response.writeHead(status, {
    ...baseHeaders(),
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function sendText(response, status, text) {
  if (response.destroyed) return;
  response.writeHead(status, {
    ...baseHeaders(),
    "Content-Type": "text/plain; charset=utf-8",
  });
  response.end(text);
}

function sendHtml(response, html) {
  response.writeHead(200, {
    ...baseHeaders(),
    "Content-Type": "text/html; charset=utf-8",
  });
  response.end(html);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function passwordLike(name) {
  return /pass|otp|token|secret|pin|code|cvv|cvc|card/i.test(name);
}

function renderPage(session, shareAvailable) {
  const fields = (session.fields ?? [])
    .map(
      (name) => `<label>${escapeHtml(name)}<input data-field="${escapeHtml(
        name,
      )}" name="${escapeHtml(name)}" type="${
        passwordLike(name) ? "password" : "text"
      }" autocomplete="off" autocapitalize="off" spellcheck="false"></label>`,
    )
    .join("\n");
  const hasFields = (session.fields ?? []).length > 0;
  const browserBody = shareAvailable
    ? '<iframe title="공유 브라우저" src="/index.html?floating_menu=no&show_menu=no&keyboard=yes"></iframe>'
    : "<p>이 브라우저에서는 화면 공유를 사용할 수 없습니다.</p>";
  const body =
    session.mode === "form"
      ? `<section id="form-view">
          <p>민감한 정보는 이 페이지에만 입력하세요.</p>
          <form id="secret-form">${fields}
            <button type="submit">제출</button>
          </form>
          <button id="to-browser" type="button">브라우저로 직접 하기</button>
          <button class="done" type="button">완료</button>
        </section>`
      : `<header><button class="done" type="button">완료</button>${
          hasFields ? '<button id="to-form" type="button">폼으로 돌아가기</button>' : ""
        }</header>${browserBody}`;

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>브라우저 전달</title>
<style>
html,body{width:100%;height:100%;margin:0;font-family:system-ui,sans-serif;background:#17191d;color:#f4f4f5}
body{display:flex;flex-direction:column}header{display:flex;gap:.5rem;padding:.6rem;background:#252932}
section{max-width:34rem;margin:3rem auto;padding:1.5rem}label{display:block;margin:1rem 0}
input{display:block;box-sizing:border-box;width:100%;padding:.7rem;margin-top:.35rem;font:inherit}
button{padding:.65rem 1rem;margin:.35rem .35rem 0 0;cursor:pointer}#status{min-height:1.5rem}
iframe{display:block;width:100%;height:100%;min-height:0;flex:1;border:0;background:white}
</style>
</head>
<body>${body}<p id="status" role="status" aria-live="polite"></p>
<script>
(() => {
  const status = document.getElementById("status");
  async function request(path, body) {
    const response = await fetch(path, {
      method: "POST",
      headers: {"Content-Type": "application/json", "X-Handoff": "1"},
      body: JSON.stringify(body || {})
    });
    if (!response.ok) throw new Error("request failed");
    return response.json();
  }
  document.getElementById("secret-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = {};
    document.querySelectorAll("[data-field]").forEach((input) => {
      values[input.dataset.field] = input.value;
    });
    try {
      await request("/__handoff/form", values);
      document.querySelectorAll("[data-field]").forEach((input) => { input.value = ""; });
      status.textContent = "제출했습니다.";
    } catch { status.textContent = "제출하지 못했습니다."; }
  });
  document.getElementById("to-browser")?.addEventListener("click", async () => {
    try { await request("/__handoff/mode", {mode: "browser"}); location.reload(); }
    catch { status.textContent = "전환하지 못했습니다."; }
  });
  document.getElementById("to-form")?.addEventListener("click", async () => {
    try { await request("/__handoff/mode", {mode: "form"}); location.reload(); }
    catch { status.textContent = "전환하지 못했습니다."; }
  });
  document.querySelectorAll(".done").forEach((button) => button.addEventListener("click", async () => {
    try {
      await request("/__handoff/done", {});
      status.textContent = "완료했습니다. 이 창을 닫아도 됩니다.";
      document.querySelectorAll("button,input").forEach((element) => { element.disabled = true; });
    } catch { status.textContent = "완료 처리하지 못했습니다."; }
  }));
})();
</script>
</body>
</html>`;
}

function requestCookies(request) {
  const result = new Map();
  for (const part of String(request.headers.cookie ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    result.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
  }
  return result;
}

function authenticated(request) {
  const cookie = requestCookies(request).get("hh_sess");
  return Boolean(
    cookieHash && cookie && constantTimeEqual(sha256(cookie), cookieHash),
  );
}

function secureCookieRequested() {
  try {
    if (process.env.BROWSER_HANDOFF_PUBLIC_BASE_URL) {
      return new URL(process.env.BROWSER_HANDOFF_PUBLIC_BASE_URL).protocol === "https:";
    }
  } catch {
    return false;
  }
  return (process.env.BROWSER_HANDOFF_PUBLIC_SCHEME ?? "http") === "https";
}

async function redeemToken(request, response, token) {
  if (request.method !== "GET") throw new HttpError(405, "method not allowed");
  let accepted = false;
  let rejectionStatus = 403;
  const cookieValue = randomToken(32);
  const suppliedHash = sha256(token);

  await updateSession(sessionId, (session) => {
    if (expired(session)) {
      rejectionStatus = 410;
      return;
    }
    if (
      session.status !== "WAITING_FOR_USER" ||
      !session.share_active ||
      session.token_used_at ||
      !constantTimeEqual(suppliedHash, session.token_sha256)
    ) {
      rejectionStatus = session.token_used_at ? 410 : 403;
      return;
    }
    session.token_used_at = nowEpoch();
    session.last_action = "token_used";
    accepted = true;
  });

  if (!accepted) {
    await logEvent(paths.gatewayLog, "token_rejected");
    throw new HttpError(rejectionStatus, "handoff link is not valid");
  }

  cookieHash = sha256(cookieValue);
  await logEvent(paths.gatewayLog, "token_ok");
  const secure = secureCookieRequested() ? "; Secure" : "";
  response.writeHead(302, {
    ...baseHeaders(),
    "Set-Cookie": `hh_sess=${cookieValue}; HttpOnly; SameSite=Strict; Path=/${secure}`,
    Location: "/__handoff/",
  });
  response.end();
}

async function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        tooLarge = true;
        chunks.length = 0;
      } else if (!tooLarge) {
        chunks.push(chunk);
      }
    });
    request.on("end", () => {
      if (tooLarge) {
        reject(new HttpError(413, "request too large"));
        return;
      }
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", () => reject(new HttpError(400, "invalid request")));
    request.setTimeout(10000, () => {
      reject(new HttpError(408, "request timed out"));
      request.destroy();
    });
  });
}

async function bodyValues(request) {
  const raw = await readBody(request);
  try {
    if (String(request.headers["content-type"] ?? "").includes("application/json")) {
      const parsed = JSON.parse(raw || "{}");
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
        throw new Error("invalid");
      }
      return parsed;
    }
    return Object.fromEntries(new URLSearchParams(raw));
  } catch {
    throw new HttpError(400, "invalid request body");
  }
}

async function requireCurrentWaitingSession() {
  const session = await loadSession(sessionId);
  if (expired(session)) throw new HttpError(410, "handoff expired");
  if (session.status !== "WAITING_FOR_USER" || !session.share_active) {
    throw new HttpError(410, "handoff is no longer active");
  }
  return session;
}

async function handleForm(request, response) {
  const values = await bodyValues(request);
  await serialize(async () => {
    const session = await requireCurrentWaitingSession();
    const filled = await fillKnownFields(session, values);
    await updateSession(sessionId, (current) => {
      if (current.status === "WAITING_FOR_USER") {
        current.form_filled_fields = [
          ...new Set([...(current.form_filled_fields ?? []), ...filled]),
        ];
        current.last_action = "form_filled";
      }
    });
    await logEvent(paths.gatewayLog, "form_filled", { fields: filled.join(",") });
    sendJson(response, 200, { ok: true, filled });
  });
}

async function handleMode(request, response) {
  const body = await bodyValues(request);
  if (body.mode !== "form" && body.mode !== "browser") {
    throw new HttpError(400, "invalid mode");
  }
  await serialize(async () => {
    const session = await requireCurrentWaitingSession();
    if (body.mode === "form" && !(session.fields ?? []).length) {
      throw new HttpError(400, "this handoff has no form fields");
    }
    await updateSession(sessionId, (current) => {
      if (current.status === "WAITING_FOR_USER") {
        current.mode = body.mode;
        current.last_action = "mode_changed";
      }
    });
    await logEvent(paths.gatewayLog, "mode_changed", { mode: body.mode });
    sendJson(response, 200, { ok: true, mode: body.mode });
  });
}

function shutdown(exitCode) {
  if (closing) return;
  closing = true;
  server?.close();
  for (const socket of sockets) socket.destroy();
  const force = setTimeout(() => process.exit(exitCode), 250);
  force.unref();
  server?.close(() => process.exit(exitCode));
}

async function handleDone(request, response) {
  request.resume();
  await serialize(async () => {
    await requireCurrentWaitingSession();
    await updateSession(sessionId, (session) => {
      if (session.status === "WAITING_FOR_USER") {
        session.status = "RESUMABLE";
        session.done_at = nowEpoch();
        session.share_active = false;
        session.last_action = "done";
      }
    });
    await releaseAgentLock(sessionId);
    await logEvent(paths.gatewayLog, "done");
    sendJson(response, 200, { ok: true, status: "RESUMABLE" });
    response.once("finish", () => shutdown(0));
  });
}

async function xpraSocketFor(session) {
  const endpoint = await readJson(getPaths().endpoint);
  if (
    !endpoint ||
    endpoint.cdp_http !== session.cdp_http ||
    endpoint.headless ||
    !endpoint.xpra_socket
  ) {
    throw new HttpError(503, "browser view is unavailable");
  }
  return endpoint.xpra_socket;
}

function forwardedHeaders(request) {
  const headers = { ...request.headers };
  const remaining = [...requestCookies(request).entries()]
    .filter(([name]) => name !== "hh_sess")
    .map(([name, value]) => `${name}=${value}`);
  if (remaining.length) headers.cookie = remaining.join("; ");
  else delete headers.cookie;
  return headers;
}

async function proxyHttp(request, response, session) {
  const socketPath = await xpraSocketFor(session);
  const upstream = http.request(
    {
      socketPath,
      method: request.method,
      path: request.url,
      headers: forwardedHeaders(request),
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    },
  );
  upstream.setTimeout(30000, () => upstream.destroy());
  upstream.on("error", () => {
    if (!response.headersSent) sendText(response, 502, "browser view unavailable");
    else response.destroy();
  });
  request.pipe(upstream);
}

async function handleRequest(request, response) {
  try {
    const session = await loadSession(sessionId);
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname.startsWith("/t/")) {
      if (expired(session)) throw new HttpError(410, "handoff expired");
      await redeemToken(request, response, url.pathname.slice(3));
      return;
    }
    if (expired(session)) throw new HttpError(410, "handoff expired");
    if (!authenticated(request)) throw new HttpError(403, "forbidden");
    if (!session.share_active) throw new HttpError(410, "handoff is no longer active");

    if (url.pathname === "/__handoff/") {
      if (request.method !== "GET") throw new HttpError(405, "method not allowed");
      let shareAvailable = false;
      try {
        await xpraSocketFor(session);
        shareAvailable = true;
      } catch {
        // The HTML page explains when browser view is unavailable.
      }
      sendHtml(response, renderPage(session, shareAvailable));
      return;
    }

    if (url.pathname.startsWith("/__handoff/")) {
      if (request.method !== "POST") throw new HttpError(405, "method not allowed");
      if (request.headers["x-handoff"] !== "1") throw new HttpError(403, "forbidden");
      if (url.pathname === "/__handoff/form") {
        await handleForm(request, response);
      } else if (url.pathname === "/__handoff/mode") {
        await handleMode(request, response);
      } else if (url.pathname === "/__handoff/done") {
        await handleDone(request, response);
      } else {
        throw new HttpError(404, "not found");
      }
      return;
    }

    await proxyHttp(request, response, session);
  } catch (error) {
    if (response.destroyed) return;
    if (error instanceof HttpError) {
      sendText(response, error.status, error.message);
    } else {
      await logEvent(paths.gatewayLog, "request_failed").catch(() => {});
      sendText(response, 500, "request failed");
    }
  }
}

function rejectUpgrade(socket, status) {
  socket.end(
    `HTTP/1.1 ${status}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n`,
  );
}

async function handleUpgrade(request, socket, head) {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  try {
    const session = await loadSession(sessionId);
    if (expired(session)) {
      rejectUpgrade(socket, "410 Gone");
      return;
    }
    if (!authenticated(request)) {
      rejectUpgrade(socket, "403 Forbidden");
      return;
    }
    if (!session.share_active) {
      rejectUpgrade(socket, "410 Gone");
      return;
    }
    const socketPath = await xpraSocketFor(session);
    const upstream = net.connect(socketPath);
    sockets.add(upstream);
    upstream.on("close", () => sockets.delete(upstream));
    upstream.once("connect", () => {
      const lines = [`${request.method} ${request.url} HTTP/${request.httpVersion}`];
      for (const [name, value] of Object.entries(forwardedHeaders(request))) {
        if (value !== undefined) {
          lines.push(`${name}: ${Array.isArray(value) ? value.join(", ") : value}`);
        }
      }
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  } catch {
    rejectUpgrade(socket, "502 Bad Gateway");
  }
}

async function main() {
  if (!sessionId) throw new CliError("usage: hitl-gateway.mjs <session_id>", 64);
  await loadSession(sessionId);
  const bindHost = process.env.BROWSER_HANDOFF_BIND_HOST ?? "127.0.0.1";
  const port = parsePositiveInteger(
    process.env.BROWSER_HANDOFF_GATEWAY_PORT ?? "0",
    "BROWSER_HANDOFF_GATEWAY_PORT",
    { allowZero: true, maximum: 65535 },
  );

  server = http.createServer(handleRequest);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request, socket, head) => {
    void handleUpgrade(request, socket, head);
  });
  server.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  await new Promise((resolve, reject) => {
    server.once("error", () => reject(new Error("gateway failed to listen")));
    server.listen(port, bindHost, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("gateway address unavailable");

  let ready = true;
  await updateSession(sessionId, (session) => {
    if (
      session.status !== "WAITING_FOR_USER" ||
      expired(session) ||
      !session.share_active
    ) {
      ready = false;
      return;
    }
    session.gateway = {
      pid: process.pid,
      bind_host: bindHost,
      port: address.port,
    };
    session.last_action = "gateway_ready";
  });
  if (!ready) {
    shutdown(1);
    return;
  }
  await logEvent(paths.gatewayLog, "gateway_ready");

  let signalHandling = false;
  const onSignal = () => {
    if (signalHandling) return;
    signalHandling = true;
    void (async () => {
      await updateSession(sessionId, (session) => {
        session.share_active = false;
      }).catch(() => {});
      await logEvent(paths.gatewayLog, "terminated").catch(() => {});
      shutdown(0);
    })();
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
}

main().catch((error) => {
  if (server) shutdown(1);
  else mainError(error);
});
