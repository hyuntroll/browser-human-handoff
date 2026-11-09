---
name: browser-human-handoff
description: Use a persistent Chromium browser with temporary per-step human handoff gateways (Form Mode or Browser Mode) for sensitive steps, then resume automation over CDP once the user signals completion.
allowed-tools: exec, browser, message, read, write, edit
---

# Browser Human Handoff v3

Use this skill when a browser task reaches a sensitive step that must be completed by the user directly in the same persistent browser the agent uses.

## Trigger conditions

Start a handoff session only for:

- passwords
- OTP / MFA / 2FA
- CAPTCHA
- payment details
- any secret the user should not paste into chat
- any field the user explicitly wants to handle themselves

## Safety rules

- Never ask the user to paste passwords, OTP codes, payment details, or secrets into chat.
- Never pass secrets via command-line arguments (`argv`), environment variables, or logs.
- Never type secrets on the user's behalf from model context.
- If the host runtime provides an out-of-band secret input channel, pass values only via `hitl-handoff.mjs fill <session_id>` using `--stdin`, `--fd <N>`, or `--file <0600_path>` (never on `argv`).
- Honour the agent lock (`browser/agent.lock`): while a handoff session is `WAITING_FOR_USER`, `browser-control.mjs` is locked out and exits with code `75`.
- Keep the persistent browser running across steps so login cookies and session state carry over. Closing or expiring a handoff session stops only the temporary gateway share, not the browser.

## Session model

1. **Persistent Browser (`hitl-browser.mjs`)**
   - Manages a single persistent Chromium instance and profile (`browser/profile`) with CDP bound strictly to `127.0.0.1` (`--remote-debugging-port=0`) and Xpra bound to a `0600` Unix socket (`browser/xpra/xpra.sock`, no TCP listener).
   - Started automatically by `hitl-handoff.mjs open` or explicitly via `node tools/browser-hitl/hitl-browser.mjs ensure`.

2. **Handoff Modes & Switching (`hitl-handoff.mjs`)**
   - **Form Mode (`--mode form`)**: default when `--field name=css_selector` is provided. Serves a Korean HTML form where the user submits values directly to the gateway (`POST /__handoff/form`), which fills the page over CDP and optionally clicks `--submit css_selector`. Only field names are recorded in `session.json`.
   - **Browser Mode (`--mode browser`)**: default when no `--field` is given. Proxies the live Xpra HTML5 view (`/index.html` + WebSocket upgrade) through the session gateway for CAPTCHAs or visual interaction.
   - **Mode Switching**: the user can switch between Form Mode and Browser Mode at any time in the gateway UI (**브라우저로 직접 하기** / **폼으로 돌아가기**, `POST /__handoff/mode`) or via CLI (`node tools/browser-hitl/hitl-handoff.mjs switch <session_id> browser|form`).

3. **One-Time Link (`handoff_url`)**
   - `open` outputs `"handoff_url": "http://<PUBLIC_HOST>:<port>/t/<token>"` once on stdout.
   - Only `sha256(token)` is saved in `session.json` (never the raw token).
   - The first `GET /t/<token>` redeems the token, sets an `HttpOnly; SameSite=Strict` session cookie (`hh_sess`), and redirects (`302`) to `/__handoff/`. Subsequent visits to `/t/<token>` are rejected (`403`/`410`).

4. **Agent Lock, Done Signal & TTL Watcher**
   - Opening a session acquires `browser/agent.lock` (exit code `73` if another live session holds it). While locked, `browser-control.mjs` exits with code `75`.
   - When the user clicks the **완료** button (`POST /__handoff/done`) or the agent runs `node tools/browser-hitl/hitl-handoff.mjs done <session_id>`, the session becomes `RESUMABLE`, `agent.lock` is released, and the gateway server exits.
   - A per-session TTL watcher (`hitl-watcher.mjs`) monitors `expires_at`. On timeout, it stops **only** the gateway (`status: EXPIRED`, `share_active: false`) and releases `agent.lock` while keeping the persistent browser alive.

## Open procedure

1. Decide the target URL (or `--current` to use the current page) and whether known input selectors can use **Form Mode** or require **Browser Mode**.
2. Run:

   - **Form Mode** (for known credential/OTP inputs):
     ```bash
     node tools/browser-hitl/hitl-handoff.mjs open "<TARGET_URL>" \
       --mode form \
       --field username=#username \
       --field password=#password \
       --field otp=#otp \
       --submit "#submit"
     ```
   - **Browser Mode** (for CAPTCHA, complex MFA, or visual flows):
     ```bash
     node tools/browser-hitl/hitl-handoff.mjs open "<TARGET_URL>" --mode browser
     ```

3. Parse the JSON output and extract:
   - `session_id`
   - `handoff_url`
   - `mode`
   - `ttl_seconds`
   - `expires_at`
   - `share_available`
4. Send the user a short message with `handoff_url`, the TTL, and instructions to click the **완료** button (or reply in chat when done).

## Message template

민감한 브라우저 단계라 제가 대신 입력하면 안 됩니다.  
아래 일회성 링크로 접속해서 직접 처리해 주세요 (화면에서 **브라우저로 직접 하기** / **폼으로 돌아가기**로 전환할 수도 있습니다).  
이 세션은 `ttl_seconds`초 후 자동으로 만료됩니다.  
처리가 끝나면 화면의 **완료** 버튼을 누르거나 `완료 <session_id>` 로 알려주세요.

`<handoff_url>`

## Runtime secret input (no model in the path)

When a host runtime collects secrets through its own secure UI without exposing them to the model, fill the active form session using one of:

- `--stdin` (pipe JSON object `{"username":"...","password":"...","otp":"..."}`):
  ```bash
  node tools/browser-hitl/hitl-handoff.mjs fill <session_id> --stdin
  ```
- `--fd <N>` (inherited file descriptor):
  ```bash
  node tools/browser-hitl/hitl-handoff.mjs fill <session_id> --fd 3
  ```
- `--file <PATH>` (regular file owned by current uid with mode `0600` or `0400`; automatically deleted after reading unless `--keep-file` is passed):
  ```bash
  node tools/browser-hitl/hitl-handoff.mjs fill <session_id> --file /path/to/secret.json
  ```

Never pass secret values on `argv`.

## While waiting

- Do not run `browser-control.mjs` while the handoff lock is active (it will fail with exit code `75: handoff in progress`).
- You can block until the user clicks **완료** (or the session expires) with:

  ```bash
  node tools/browser-hitl/hitl-handoff.mjs wait <session_id> --timeout 300
  ```

## Resume procedure

When `wait` returns `RESUMABLE` or the user replies with `완료 <session_id>`:

1. If the user replied in chat without clicking the **완료** button in the browser UI, release the lock and stop the gateway via CLI:

   ```bash
   node tools/browser-hitl/hitl-handoff.mjs done <session_id>
   ```

2. Verify session state if needed:

   ```bash
   node tools/browser-hitl/hitl-handoff.mjs status <session_id>
   ```

3. Control the persistent browser (the login cookies and session state are preserved in the same browser):

   ```bash
   node tools/browser-hitl/browser-control.mjs url
   node tools/browser-hitl/browser-control.mjs title
   node tools/browser-hitl/browser-control.mjs content
   node tools/browser-hitl/browser-control.mjs goto "<NEXT_URL>"
   node tools/browser-hitl/browser-control.mjs screenshot
   ```

4. Close the handoff session record when finished:

   ```bash
   node tools/browser-hitl/hitl-handoff.mjs close <session_id>
   ```

## Expired session behavior

If the session status is `EXPIRED`, the TTL watcher has already closed the gateway and released the agent lock while keeping the persistent browser open. Inform the user that the handoff link expired and open a new handoff session (`hitl-handoff.mjs open --current ...`) if the sensitive step still needs to be completed.

## Cleanup procedure

Run:

```bash
node tools/browser-hitl/hitl-handoff.mjs cleanup
```

to expire overdue sessions, remove stale locks, and prune terminal session directories older than 24 hours without deleting the persistent browser profile.
