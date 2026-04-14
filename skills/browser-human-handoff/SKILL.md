---
name: browser-human-handoff
description: Use a temporary human handoff browser session for sensitive steps, then resume control of the same Chromium session through CDP. Sessions expire automatically and should be closed after the task is complete.
allowed-tools: exec, browser, message, read, write, edit
---

# Browser Human Handoff v2.1

Use this skill when a browser task reaches a step that must be completed by the user directly.

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
- Never type those secrets on the user's behalf.
- Open the handoff only for the sensitive step.
- Handoff sessions are temporary and must not be kept open longer than needed.
- Close the handoff when the user says the step is complete.
- If a handoff session has expired, do not try to resume it. Open a new one instead if needed.

## Session model

A handoff session has:

- an Xpra HTML URL for the user
- a Chromium process running with remote debugging enabled
- a CDP endpoint so the agent can reconnect to the same browser session after the user finishes
- a TTL after which the session is considered expired

## Open procedure

1. Decide the target URL for the sensitive step.
2. Run:

   `bash tools/browser-hitl/hitl-open.sh "<TARGET_URL>"`

3. Parse the JSON output.
4. Extract:
   - `session_id`
   - `xpra_url`
   - `ttl_seconds`
   - `expires_at`
5. Send the user a short message that includes:
   - why the handoff is needed
   - the handoff link
   - when the session will expire or how long remains
   - the instruction to reply with `완료 <session_id>`

## Message template

민감한 브라우저 단계라 제가 대신 입력하면 안 됩니다.  
아래 링크로 접속해서 직접 처리해 주세요.  
이 세션은 `ttl_seconds`초 후 자동으로 만료됩니다.  
끝나면 `완료 <session_id>` 로 알려주세요.

`<link>`

## While waiting

Do not continue browser automation in that sensitive area until the user replies with the completion message.

## Resume procedure

When the user replies with `완료 <session_id>`:

1. Verify session state:

   `bash tools/browser-hitl/hitl-status.sh <session_id>`

2. Check both:
   - `alive == true`
   - `expired == false`
3. Reconnect to the same browser session with the control script.
4. Resume safe automation steps.
5. When the follow-up work is complete, close the session:

   `bash tools/browser-hitl/hitl-close.sh <session_id>`

## Expired session behavior

If the session is expired, tell the user that the previous handoff session is no longer valid and open a new one only if the task still requires it.

## Cleanup procedure

Run:

`bash tools/browser-hitl/hitl-cleanup.sh`

when checking for stale sessions or before creating a new handoff session if needed.
