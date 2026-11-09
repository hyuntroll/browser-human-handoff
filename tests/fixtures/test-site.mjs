import crypto from "node:crypto";
import http from "node:http";

const LOGIN_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Fixture Login</title>
</head>
<body>
  <h1>Fixture Login</h1>
  <form id="login-form" method="POST" action="/login">
    <input id="username" name="username" type="text" autocomplete="off" />
    <input id="password" name="password" type="password" autocomplete="off" />
    <input id="otp" name="otp" type="text" autocomplete="off" />
    <button id="submit" type="submit">Submit</button>
  </form>
</body>
</html>
`;

function parseCookies(cookieHeader = "") {
  const out = {};
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

function parseFormBody(rawBody, contentType = "") {
  const trimmed = rawBody.trim();
  if (contentType.includes("application/json") || trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return {};
    }
  }
  const params = new URLSearchParams(rawBody);
  return {
    username: params.get("username") ?? "",
    password: params.get("password") ?? "",
    otp: params.get("otp") ?? "",
  };
}

/**
 * Local test fixture HTTP server on 127.0.0.1:0.
 * - GET /login -> HTML form with #username, #password, #otp, button #submit posting to /login
 * - POST /login -> checks values against values configured in memory, sets cookie test_auth=<random>; Path=/; HttpOnly and redirects to /me
 * - GET /me -> returns 200 "logged-in" if cookie valid else 401 "anonymous"
 * Never logs request bodies or credentials.
 */
export async function startTestSite(initialExpected = {}) {
  let expected = { ...initialExpected };
  const validTokens = new Set();
  const loginWaiters = new Set();
  let lastSubmission = null;

  function matchesExpected(submitted) {
    for (const [key, expectedVal] of Object.entries(expected)) {
      if (expectedVal !== undefined && submitted[key] !== String(expectedVal)) {
        return false;
      }
    }
    return true;
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");

    if (req.method === "GET" && url.pathname === "/login") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(LOGIN_HTML);
      return;
    }

    if (req.method === "POST" && url.pathname === "/login") {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        const parsed = parseFormBody(raw, req.headers["content-type"] || "");
        const submission = {
          username: String(parsed.username ?? ""),
          password: String(parsed.password ?? ""),
          otp: String(parsed.otp ?? ""),
        };
        const matched = matchesExpected(submission);
        lastSubmission = { ...submission, matched };

        const ok = matched;
        if (ok) {
          const authToken = crypto.randomBytes(16).toString("hex");
          validTokens.add(authToken);
          res.writeHead(302, {
            "Set-Cookie": `test_auth=${authToken}; Path=/; HttpOnly`,
            Location: "/me",
            "Cache-Control": "no-store",
          });
          res.end();
        } else {
          res.writeHead(401, {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-store",
          });
          res.end("anonymous");
        }

        for (const waiter of loginWaiters) {
          waiter({ ok, submission });
        }
        loginWaiters.clear();
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/me") {
      const cookies = parseCookies(req.headers.cookie || "");
      if (cookies.test_auth && validTokens.has(cookies.test_auth)) {
        res.writeHead(200, {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end("logged-in");
      } else {
        res.writeHead(401, {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end("anonymous");
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("not-found");
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  function setExpected(nextExpected, { resetAuth = true } = {}) {
    expected = { ...nextExpected };
    lastSubmission = null;
    if (resetAuth) {
      validTokens.clear();
    }
  }

  return {
    server,
    port,
    baseUrl,
    setExpected,
    setCredentials: setExpected,
    resetAuth() {
      validTokens.clear();
      lastSubmission = null;
    },
    getLastSubmission() {
      return lastSubmission;
    },
    waitForLogin(timeoutMs = 10000) {
      if (lastSubmission) {
        return Promise.resolve({
          ok: matchesExpected(lastSubmission),
          submission: lastSubmission,
        });
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          loginWaiters.delete(onLogin);
          reject(new Error("Timed out waiting for POST /login on fixture site"));
        }, timeoutMs);
        function onLogin(result) {
          clearTimeout(timer);
          resolve(result);
        }
        loginWaiters.add(onLogin);
      });
    },
    async close() {
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

export default startTestSite;
