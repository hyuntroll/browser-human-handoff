# Browser Human Handoff

Temporary browser human handoff for sensitive steps such as login, OTP, CAPTCHA, and payment, with resume over Chrome DevTools Protocol after the user finishes.

## Status

This repository is experimental.

- It is a prototype for workflow design and local validation.
- It is not production-ready.
- It has known setup and portability issues that should be fixed before deployment.

## What This Repo Does

This project opens a temporary browser session only when automation reaches a sensitive step that should be handled by a human.

The intended flow is:

1. Automation runs normally.
2. A sensitive browser step appears.
3. A temporary Xpra session is opened.
4. The user connects to the shared browser and completes the step directly.
5. The agent reconnects to the same Chromium session through CDP.
6. Safe automation resumes.
7. The handoff session is closed immediately after the follow-up work is done.

## Core Ideas

- Temporary sessions only. Handoff sessions are not long-lived browser environments.
- TTL-based cleanup. Sessions expire automatically after a configured time window.
- Same-session resume. The user and the automation share the same Chromium session.
- Sensitive data stays out of chat. Passwords, OTP codes, and payment details should not be pasted into messages.

## Repository Layout

```text
.
├─ tools/browser-hitl/
│  ├─ setup.sh
│  ├─ hitl-lib.sh
│  ├─ hitl-open.sh
│  ├─ hitl-status.sh
│  ├─ hitl-close.sh
│  ├─ hitl-cleanup.sh
│  └─ browser-control.mjs
├─ skills/browser-human-handoff/
│  └─ SKILL.md
├─ .env.hitl.example
└─ package.json
```

## Quick Start

### 1. Prepare the environment

```bash
bash tools/browser-hitl/setup.sh --check-only
```

If you want the setup script to attempt dependency installation:

```bash
bash tools/browser-hitl/setup.sh --install-os-deps
```

The setup script is designed to help install the required runtime pieces together:

- `bash`
- `curl`
- `openssl`
- `node` / `npm`
- `xpra`
- a Chromium-compatible browser
- the Node CDP client package from `package.json`

### 2. Configure environment variables

The setup script creates `.env.hitl.local` from `.env.hitl.example`.

Example values:

```bash
OPENCLAW_PUBLIC_HOST=127.0.0.1
OPENCLAW_PUBLIC_SCHEME=http
OPENCLAW_HITL_TTL_SECONDS=900
```

Load them before running the tools:

```bash
set -a
source .env.hitl.local
set +a
```

### 3. Open a handoff session

```bash
bash tools/browser-hitl/hitl-open.sh "https://example.com"
```

### 4. Check session status

```bash
bash tools/browser-hitl/hitl-status.sh <session_id>
```

### 5. Resume safe automation

```bash
node tools/browser-hitl/browser-control.mjs <session_id> title
node tools/browser-hitl/browser-control.mjs <session_id> screenshot
```

### 6. Close the session

```bash
bash tools/browser-hitl/hitl-close.sh <session_id>
```

## Test

Run the mock-based smoke tests:

```bash
npm run test:hitl
```

These tests do not require a real Xpra or Chromium process. They validate the HITL lifecycle with mocked OS commands:

- session open
- session status
- manual close
- TTL cleanup
- browser-control guard rails for expired sessions

## Docker Test

There is also a test-oriented Dockerfile for reproducing the environment with the expected system packages installed.

Build the image:

```bash
docker build -t browser-hitl-test .
```

Run the smoke tests inside the container:

```bash
docker run --rm browser-hitl-test
```

## Session Lifecycle

The current design uses these states:

- `OPENING`
- `WAITING_FOR_USER`
- `RESUMABLE`
- `RESUMED`
- `CLOSED`
- `EXPIRED`
- `FAILED`

Session metadata is stored under `~/.openclaw-hitl/<session_id>/session.json`.

## Security Notes

- Do not ask users to paste passwords, OTP codes, payment details, or other secrets into chat.
- Do not log sensitive input values if you extend the scripts.
- Prefer internal networks, VPN, or authenticated reverse proxy access for Xpra exposure.
- Run under a non-root user if possible.

## Known Limitations

- Some macOS setups may still need `OPENCLAW_CHROMIUM_BIN` set explicitly if Chromium is installed in a nonstandard location.
- The included smoke tests use mocked OS commands, so a full end-to-end validation with real Xpra and Chromium is still recommended.
- The Docker test image has not been validated in this environment.
- Setup and runtime scripts are designed for local prototyping first, not broad distribution yet.

## Intended Use

This repository is best used for:

- local experiments
- design review
- proof-of-concept sharing
- discussion around temporary browser HITL workflows

This repository is not yet a good fit for:

- production deployment
- public SaaS exposure
- multi-user operations
- security-sensitive environments without additional hardening

## Related Skill

The workflow definition for agent usage lives in [`skills/browser-human-handoff/SKILL.md`](skills/browser-human-handoff/SKILL.md).
