# Persistent Browser Handoff — Design (v3)

Goal: give agent runtimes without a human-handoff UI (e.g. Hermes) a safe way to let a
person do sensitive steps (login, OTP, captcha, payment) **in the same browser the agent
uses**, so the resulting login state carries over.

## Components (all under `tools/browser-hitl/`, Node >= 20, ESM, no new npm deps except `playwright`)

| File | Role |
|---|---|
| `hitl-lib.mjs` | Shared helpers: paths, `writeJsonAtomic(path, obj)` (mode 0600, tmp+rename), `ensureDir(path)` (mode 0700), random ids/tokens, sha256, pid alive check, agent-lock helpers, logger that only writes event names / non-secret fields. |
| `hitl-browser.mjs` | CLI `ensure | status | stop`. Manages ONE persistent browser. |
| `hitl-handoff.mjs` | CLI `open | status | done | switch | wait | close | cleanup | fill`. Manages handoff sessions. |
| `hitl-gateway.mjs` | Per-session HTTP gateway (one-time token -> cookie, form UI, browser view proxy to Xpra, done endpoint). Spawned detached by `open`. |
| `hitl-watcher.mjs` | Per-session TTL watcher. Spawned detached by `open`. On expiry stops ONLY the share (gateway), keeps the browser. |
| `browser-control.mjs` | Agent-side helper. Attaches to the persistent browser with `connectOverCDP`; honours the agent lock. |
| `hitl-open.sh`, `hitl-status.sh`, `hitl-close.sh`, `hitl-cleanup.sh` | Thin backwards-compatible bash wrappers around `hitl-handoff.mjs`. `hitl-lib.sh` may be reduced to what the wrappers need. |
| `setup.sh` | Keep; update Linux install hint (Debian trixie needs the xpra.org repo; package names `xpra xpra-html5 xpra-x11`), and chmod list. |

## Directory layout (`BASE_DIR = $BROWSER_HANDOFF_BASE_DIR or ~/.hermes/browser-handoff`, mode 0700)

```
BASE_DIR/
  browser/                 0700
    profile/               0700  fixed Chromium profile (cookies live here; never auto-deleted)
    xpra/                  0700  xpra socket dir; xpra.sock is a UNIX socket (0600). Xpra has NO TCP listener.
    endpoint.json          0600  {display, xpra_socket, xpra_pid?, chromium_pid, cdp_port, cdp_http:"http://127.0.0.1:<port>", cdp_ws, profile_dir, started_at}
    agent.lock             0600  present while a handoff holds the browser: {session_id, acquired_at, expires_at}
    logs/                  0700  chromium.log, xpra.log (no secrets ever written)
  sessions/<id>/           0700
    session.json           0600  NO secrets, NO raw tokens. See schema below.
    gateway.log            0600  event names only
    watcher.log            0600
```

## 1. Persistent browser (`hitl-browser.mjs ensure`)

* Reuse if `endpoint.json` exists, `chromium_pid` alive, and `GET cdp_http/json/version` returns a
  `webSocketDebuggerUrl` equal to `cdp_ws`. Print the same endpoint JSON (`"reused": true`).
* Otherwise start:
  1. Xpra display (if not already alive): pick a free display `:N` (N from 100..199 where
     `/tmp/.X11-unix/X<N>` does not exist), run
     `xpra start :N --bind=<BASE>/browser/xpra/xpra.sock --html=on --daemon=yes --exit-with-children=no
      --mdns=no --pulseaudio=no --notifications=no --webcam=no --printing=no --file-transfer=no
      --systemd-run=no --log-file=<BASE>/browser/logs/xpra.log` (no `--bind-tcp`, no `--auth=file`, no password).
     Wait until the unix socket exists and `xpra info` / an HTTP GET over the socket answers.
  2. Chromium detached (`spawn(..., {detached:true, stdio:[ignore, logfd, logfd]}).unref()`), env `DISPLAY=:N`, args:
     `--user-data-dir=<profile> --remote-debugging-address=127.0.0.1 --remote-debugging-port=0
      --no-first-run --no-default-browser-check --disable-dev-shm-usage --password-store=basic
      --start-maximized about:blank` (+ `--no-sandbox` only if running as root).
     Binary: `$BROWSER_HANDOFF_CHROMIUM_BIN` or first of chromium-browser, chromium, google-chrome, google-chrome-stable.
  3. Delete stale `<profile>/DevToolsActivePort` before launch; poll it (<= 20s); line 1 = port, line 2 = ws path.
     `cdp_ws = ws://127.0.0.1:<port><path>`. Verify `/json/version`.
  4. Write `endpoint.json` (0600). Print it as JSON on stdout.
* `--headless` flag / `BROWSER_HANDOFF_HEADLESS=1`: skip Xpra, launch Chromium with `--headless=new`
  (for CI/tests of non-display parts). Browser mode must then report `share_available:false`.
* `status`: print endpoint + `alive` booleans. `stop`: kill Chromium (TERM, then KILL), `xpra stop :N`, remove endpoint.json. Never delete the profile.
* Use a simple lock file (`browser/.ensure.lock`, O_EXCL, stale after 60s) so two concurrent `ensure` calls start only one browser.

## 2. Handoff session (`hitl-handoff.mjs open`)

```
node tools/browser-hitl/hitl-handoff.mjs open <target_url|--current>
     [--mode form|browser]            default: form if --field given, else browser
     [--field name=css_selector]...   e.g. --field username=#user --field password=#pass --field otp=#otp
     [--submit css_selector]          optional element to click after filling
     [--ttl seconds]                  default $BROWSER_HANDOFF_TTL_SECONDS or 900
     [--reason text]
```

Steps: `ensure` browser -> acquire agent lock (fail with exit 73 if another live session holds it) ->
navigate a page to target_url over CDP (reuse the last page of the default context; `--current` = don't navigate) ->
create session dir -> generate one-time token (32 random bytes, base64url) -> store ONLY `sha256(token)` ->
spawn gateway (detached) and wait until it reports its port in session.json -> spawn watcher (detached) ->
print JSON to stdout:

```json
{ "session_id": "...", "status": "WAITING_FOR_USER", "mode": "form", "fields": ["username","password","otp"],
  "handoff_url": "http://<PUBLIC_HOST>:<gateway_port>/t/<token>",   // printed ONCE, here only
  "expires_at": 1730000000, "ttl_seconds": 900, "share_available": true }
```

The token link is not a secret of the human (it is single-use, short-TTL); it is the only thing the
agent passes to the person. It must NOT be written to session.json or any log.

`session.json` schema (0600): session_id, status (`WAITING_FOR_USER|RESUMABLE|RESUMED|CLOSED|EXPIRED|FAILED`),
mode, fields (names) , field_selectors, submit_selector, target_url, created_at, expires_at, ttl_seconds,
gateway {pid, bind_host, port}, watcher_pid, token_sha256, token_used_at, share_active (bool),
done_at, closed_at, closed_reason, last_action, cdp_http (from endpoint), form_filled_fields (names only).

Env: `BROWSER_HANDOFF_BIND_HOST` (default 127.0.0.1 — gateway listen addr), `BROWSER_HANDOFF_PUBLIC_HOST` (host in link, default = bind host),
`BROWSER_HANDOFF_PUBLIC_SCHEME` (default http), `BROWSER_HANDOFF_PUBLIC_BASE_URL` (optional full override e.g. https://handoff.example.ts.net, used when a reverse proxy/Tailscale serve fronts the gateway),
`BROWSER_HANDOFF_GATEWAY_PORT` (default 0 = random free port).

## 3. Gateway (`hitl-gateway.mjs <session_id>`)

* `http.createServer` listening on `BIND_HOST:PORT` (default 127.0.0.1:0); write actual port to session.json.
* `GET /t/<token>`: constant-time compare sha256(token) with token_sha256; reject if already used, expired,
  or share inactive -> 403 (410 is fine for used). On success: mark `token_used_at` (persist BEFORE responding),
  create random cookie value, keep its sha256 in memory, `Set-Cookie: hh_sess=<v>; HttpOnly; SameSite=Strict; Path=/`
  (+`Secure` when public scheme is https), 302 -> `/__handoff/`.
* All other routes require the cookie, else 403. Expired -> 410.
* `GET /__handoff/` : HTML page (Korean UI). Form mode: inputs for each field (`type=password` for password/otp-like
  names), buttons `제출` (submit -> POST /__handoff/form), `브라우저로 직접 하기` (POST /__handoff/mode {mode:"browser"}),
  `완료` (POST /__handoff/done). Browser mode: a top bar with `완료` and `폼으로 돌아가기` (only if fields exist) and
  an iframe to `/index.html?floating_menu=no&...` (Xpra HTML5 client served via proxy). If share unavailable
  (headless) show a message.
* `POST /__handoff/form` (JSON or urlencoded): connect to cdp_http with playwright `connectOverCDP`, find the page
  (last page of first context), `page.fill(selector, value)` for each known field, click submit selector if set,
  disconnect (`browser.close()` on a CDP-connected browser only disconnects). Record only field NAMES in
  `form_filled_fields`. Never log or echo values. Responds `{ok:true, filled:[names]}`.
* `POST /__handoff/mode` -> update session.mode. `POST /__handoff/done` -> status RESUMABLE, done_at, release agent lock,
  share_active=false, respond, then close server and exit.
* State-changing POSTs require cookie + header `X-Handoff: 1` (CSRF guard) — the page JS sends it.
* Everything else (Xpra HTML assets + WebSocket upgrade) is proxied to the Xpra unix socket:
  HTTP via `http.request({socketPath})`; `server.on('upgrade')` -> `net.connect(socketPath)`, re-send the request
  line + headers, then pipe both ways. Strip the `hh_sess` cookie before forwarding.
* Logs: event names only (`token_ok`, `token_rejected`, `form_filled fields=username,password`, `done`, ...).
* SIGTERM -> close server, set share_active=false, exit 0.

## 4. Watcher (`hitl-watcher.mjs <session_id>`)

Loop every 1s: read session.json. If status terminal or done -> exit. If now >= expires_at: SIGTERM gateway pid
(then SIGKILL after 3s), set status EXPIRED (if still WAITING_FOR_USER), share_active=false, closed_reason `ttl_expired`,
release agent lock if held by this session, exit. Never touches the browser or Xpra display.
Also: if the gateway pid dies unexpectedly, set share_active=false (keep status).

## 5. Agent lock

`browser/agent.lock` JSON {session_id, acquired_at, expires_at}. Considered stale (and removable) when the
session is terminal / RESUMABLE, or expires_at passed, or session dir missing.
`browser-control.mjs` before any action: if a live lock exists -> wait up to `BROWSER_HANDOFF_LOCK_WAIT_SECONDS`
(default 0) polling 500ms, then exit code 75 with stderr `handoff in progress: <session_id>`.
`hitl-handoff.mjs wait <id> [--timeout s]` blocks until the session is RESUMABLE/EXPIRED/CLOSED and prints status.
`hitl-handoff.mjs done <id>` = agent-side/CLI completion signal (same effect as POST /__handoff/done; also stops the gateway).

## 6. Runtime-provided form values (no model in the path)

For runtimes that have their own secure form UI, `hitl-handoff.mjs fill <id>` reads a JSON object
`{"username":"...","password":"...","otp":"..."}` from exactly one of:
* `--stdin` (pipe), * `--fd N` (inherited file descriptor), * `--file PATH` (must be a regular file owned by the
  current uid with mode 0600 or 0400; deleted after reading unless `--keep-file`).
It never accepts values on argv. Fills over CDP exactly like the gateway form. Output: `{ok, filled:[names]}` only.
Requires the session to be WAITING_FOR_USER (the human-side channel) — it bypasses the agent lock by design.

## 7. browser-control.mjs (agent side)

New usage: `node tools/browser-hitl/browser-control.mjs <action> [args...]` attaching to `browser/endpoint.json`.
Backwards compat: if the first arg is an existing session id, accept `<session_id> <action> ...` and also mark the
session RESUMED. Actions: url, title, goto, screenshot, click, fill, press, content, cookies (names+domains only,
never values). Honour the agent lock (section 5). Disconnect, never kill the browser.

## 8. close / cleanup

`close <id>`: stop gateway + watcher if alive, status CLOSED, release lock. Browser keeps running.
`cleanup`: for every session past expiry and not terminal -> same as watcher expiry; remove stale lock;
delete session dirs older than 24h that are terminal. Never deletes the browser profile.
`hitl-browser.mjs stop` is the only thing that stops the browser. Optional `hitl-browser.mjs reset-profile --yes`
(stopped browser only) deletes the profile.

## Exit codes
0 ok, 1 error, 64 usage, 73 lock busy, 75 handoff in progress (agent locked).
