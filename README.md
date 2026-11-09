# Browser Human Handoff

Persistent browser human handoff for sensitive steps such as login, OTP, CAPTCHA, and payment, with seamless state carryover and agent resume over Chrome DevTools Protocol (CDP).

## Status

This repository is experimental.

- It is a prototype for workflow design and local validation.
- It is not production-ready.
- Review network exposure and reverse-proxy settings before using outside local environments.

## What This Repo Does

This project manages **one persistent Chromium browser** shared between the agent and the human user, and opens **temporary per-step handoff gateways** only when automation reaches a sensitive step.

The intended flow is:

1. Automation ensures the persistent browser is running (`hitl-browser.mjs ensure`) and performs safe navigation via `browser-control.mjs`.
2. A sensitive browser step (login, OTP, CAPTCHA, payment) appears.
3. The agent opens a temporary handoff session (`hitl-handoff.mjs open`), which acquires an **agent lock** (`browser/agent.lock`) and spawns a per-session HTTP gateway and TTL watcher.
4. The agent sends the user the **one-time `handoff_url`**.
5. The user opens `handoff_url` (which exchanges the one-time token for an `HttpOnly; SameSite=Strict` session cookie) and completes the step in **Form Mode** or **Browser Mode** (and can switch between modes at any time).
6. The user clicks **완료** in the handoff UI (or the runtime runs `hitl-handoff.mjs done <session_id>`), which closes the temporary gateway, marks the session `RESUMABLE`, and releases the agent lock.
7. The agent resumes automation in the **same persistent Chromium profile**, where cookies and login state remain intact.

## Core Ideas

- **Persistent browser, temporary share.** One Chromium process and persistent profile (`browser/profile`) stay alive across tasks so authentication carries over, while the handoff gateway exists only during the sensitive step.
- **Form Mode vs. Browser Mode (with live switching).**
  - **Form Mode** (`--mode form --field ...`): renders a lightweight Korean form for fields like username, password, and OTP, filling selectors over CDP without streaming the full display.
  - **Browser Mode** (`--mode browser`): proxies the live Xpra HTML5 desktop view through the authenticated gateway for CAPTCHAs, WebAuthn/passkeys, or multi-step visual flows.
  - Users can switch modes on the fly via the gateway UI (`브라우저로 직접 하기` / `폼으로 돌아가기`, `POST /__handoff/mode`) or CLI (`hitl-handoff.mjs switch`).
- **One-time token link.** `handoff_url` (`/t/<token>`) is printed once on `open`. Only `sha256(token)` is persisted in `session.json`. First redemption issues an `hh_sess` cookie and redirects to `/__handoff/`; subsequent visits to `/t/<token>` return `403`/`410`.
- **Agent lock (`browser/agent.lock`).** Prevents the agent from interfering while a human is interacting with the browser (`browser-control.mjs` exits with code `75` while locked; concurrent `open` exits with code `73`).
- **Done signal & wait.** Clicking `완료` (`POST /__handoff/done`) or running `hitl-handoff.mjs done <id>` releases the agent lock, marks the session `RESUMABLE`, and stops the gateway. Agents can block with `hitl-handoff.mjs wait <id>`.
- **TTL watcher.** Each session runs a detached watcher (`hitl-watcher.mjs`). On expiry, it terminates **only** the session gateway (`status: EXPIRED`, `share_active: false`) and releases the agent lock while keeping the persistent browser and profile intact.
- **Runtime secret input (`--stdin` / `--fd` / `--file`).** Runtimes with their own secure secret UI can inject form values directly via `hitl-handoff.mjs fill <id>` using `--stdin`, `--fd N`, or `--file PATH` (mode `0600`/`0400`, deleted after reading). Secrets are never passed through chat or CLI argv.

## Repository Layout

```text
.
├─ docs/
│  └─ persistent-handoff-design.md
├─ tools/browser-hitl/
│  ├─ hitl-lib.mjs
│  ├─ hitl-browser.mjs
│  ├─ hitl-handoff.mjs
│  ├─ hitl-gateway.mjs
│  ├─ hitl-watcher.mjs
│  ├─ browser-control.mjs
│  ├─ hitl-open.sh
│  ├─ hitl-status.sh
│  ├─ hitl-close.sh
│  ├─ hitl-cleanup.sh
│  ├─ hitl-lib.sh
│  └─ setup.sh
├─ skills/browser-human-handoff/
│  └─ SKILL.md
├─ tests/
│  ├─ hitl-phase1.test.mjs
│  ├─ e2e-handoff.test.mjs
│  └─ fixtures/test-site.mjs
├─ .env.hitl.example
└─ package.json
```

## Quick Start

### 1. Prepare the environment

```bash
bash tools/browser-hitl/setup.sh --check-only
```

If you want the setup script to attempt OS dependency installation (on Debian trixie, use the xpra.org repository for `xpra xpra-html5 xpra-x11`):

```bash
bash tools/browser-hitl/setup.sh --install-os-deps
```

### 2. Configure environment variables

The setup script creates `.env.hitl.local` from `.env.hitl.example`.

Example values:

```bash
BROWSER_HANDOFF_BIND_HOST=127.0.0.1
BROWSER_HANDOFF_PUBLIC_HOST=127.0.0.1
BROWSER_HANDOFF_PUBLIC_SCHEME=http
BROWSER_HANDOFF_TTL_SECONDS=900
# Optional full URL override when fronting the gateway with Tailscale Serve / reverse proxy:
# BROWSER_HANDOFF_PUBLIC_BASE_URL=https://handoff.example.ts.net
```

Load them before running the tools:

```bash
set -a
source .env.hitl.local
set +a
```

### 3. Ensure the persistent browser

```bash
node tools/browser-hitl/hitl-browser.mjs ensure
node tools/browser-hitl/hitl-browser.mjs status
```

Use `--headless` (or `BROWSER_HANDOFF_HEADLESS=1`) in CI/headless environments where Xpra is not needed (`share_available` will be `false`).

### 4. Open a handoff session

**Form Mode** (default when `--field` is given):

```bash
node tools/browser-hitl/hitl-handoff.mjs open "https://example.com/login" \
  --mode form \
  --field username=#username \
  --field password=#password \
  --field otp=#otp \
  --submit "#submit" \
  --ttl 900
```

**Browser Mode** (interactive Xpra HTML5 view proxied through the gateway):

```bash
node tools/browser-hitl/hitl-handoff.mjs open "https://example.com/login" --mode browser
```

Use `--current` instead of a target URL to hand off the currently open page without navigating.

### 5. Complete or fill the handoff

- **Via the Gateway UI:** Open the printed `handoff_url` (single-use `/t/<token>`). Fill the form or interact with the browser view (switching modes if needed), then click **완료** to release the agent lock.
- **Via Runtime Secret Input (no model in the path):**

  ```bash
  # From stdin pipe:
  printf '{"username":"alice","password":"...","otp":"123456"}' \
    | node tools/browser-hitl/hitl-handoff.mjs fill <session_id> --stdin

  # From a 0600 file (deleted automatically after reading unless --keep-file is set):
  node tools/browser-hitl/hitl-handoff.mjs fill <session_id> --file /path/to/secrets.json

  # From an inherited file descriptor:
  node tools/browser-hitl/hitl-handoff.mjs fill <session_id> --fd 3
  ```

- **Wait or complete via CLI:**

  ```bash
  node tools/browser-hitl/hitl-handoff.mjs wait <session_id> --timeout 300
  node tools/browser-hitl/hitl-handoff.mjs done <session_id>
  ```

### 6. Resume safe automation

Once the handoff is `RESUMABLE` and the agent lock is released, control the persistent browser directly:

```bash
node tools/browser-hitl/browser-control.mjs title
node tools/browser-hitl/browser-control.mjs url
node tools/browser-hitl/browser-control.mjs goto "https://example.com/dashboard"
node tools/browser-hitl/browser-control.mjs content
node tools/browser-hitl/browser-control.mjs cookies
node tools/browser-hitl/browser-control.mjs screenshot
```

For backwards compatibility, `browser-control.mjs <session_id> <action> [args...]` is also supported and marks the session `RESUMED`.

### 7. Close sessions, clean up, or stop the browser

```bash
# Close a handoff session (stops its gateway/watcher, keeps persistent browser running)
node tools/browser-hitl/hitl-handoff.mjs close <session_id>

# Expire overdue sessions, clear stale locks, and prune terminal sessions older than 24h
node tools/browser-hitl/hitl-handoff.mjs cleanup

# Stop the persistent Chromium + Xpra display (preserves browser/profile)
node tools/browser-hitl/hitl-browser.mjs stop
```

## Session Lifecycle & Directory Layout

Session states:

- `WAITING_FOR_USER`
- `RESUMABLE`
- `RESUMED`
- `CLOSED`
- `EXPIRED`
- `FAILED`

State and runtime files live under `BASE_DIR` (`$BROWSER_HANDOFF_BASE_DIR` or `~/.hermes/browser-handoff`, mode `0700`):

```text
BASE_DIR/                        (0700)
  browser/                       (0700)
    profile/                     (0700) persistent Chromium profile (never auto-deleted)
    xpra/                        (0700) xpra.sock UNIX socket (0600, no TCP listener)
    endpoint.json                (0600) persistent browser & CDP metadata
    agent.lock                   (0600) present while a handoff session holds the browser
    logs/                        (0700) chromium.log, xpra.log (0600, no secrets)
  sessions/<id>/                 (0700)
    session.json                 (0600) session state, token_sha256, filled field names only
    gateway.log                  (0600) event names only
    watcher.log                  (0600)
```

### Exit Codes

- `0` — OK
- `1` — General error
- `64` — Usage error (e.g. invalid arguments or attempting to pass secrets via argv)
- `73` — Lock busy (another live handoff session already holds `agent.lock`)
- `75` — Handoff in progress (`browser-control.mjs` blocked by an active `agent.lock`)

## Security Notes

- **Never pass secrets through chat or CLI argv.** Passwords, OTP codes, and payment details must only be entered via the gateway UI or passed to `hitl-handoff.mjs fill` via `--stdin`, `--fd`, or a `0600`/`0400` `--file`.
- **Loopback & Unix sockets only by default.** Chromium CDP binds strictly to `127.0.0.1` (`--remote-debugging-port=0`). Xpra binds only to a local Unix socket (`xpra.sock`, mode `0600`) with no TCP listener. The session gateway binds to `127.0.0.1` by default.
- **One-time token & CSRF protection.** `handoff_url` can only be redeemed once; raw tokens are never written to disk (`session.json` stores only `token_sha256`). State-changing gateway `POST` routes require both the `hh_sess` cookie and `X-Handoff: 1`.
- **Secret-free logs and metadata.** Logs and `session.json` record only event names and filled field names (`form_filled_fields`), never secret values, raw tokens, or cookie values.

## Known Limitations

- macOS Chromium detection may require setting `BROWSER_HANDOFF_CHROMIUM_BIN` for non-standard install locations.
- Remote user access to the local gateway requires an authenticated tunnel or reverse proxy (such as Tailscale Serve with `BROWSER_HANDOFF_PUBLIC_BASE_URL` or SSH port forwarding).
- Designed for single-agent persistent profile workflows, not multi-tenant concurrent browser isolation.

## Intended Use

This repository is best used for:

- local agent-human handoff workflows
- persistent login/session carryover across automation runs
- design validation of zero-secret-in-context HITL pipelines

This repository is not yet a good fit for:

- unauthenticated public internet exposure
- multi-tenant SaaS environments without container isolation

## Related Skill

The workflow definition for agent usage lives in [`skills/browser-human-handoff/SKILL.md`](skills/browser-human-handoff/SKILL.md).
