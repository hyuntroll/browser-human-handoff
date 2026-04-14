#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Shared helpers keep metadata writes consistent across scripts.
source "${SCRIPT_DIR}/hitl-lib.sh"

TARGET_URL="${1:-about:blank}"

ensure_base_dir

if [ "${OPENCLAW_HITL_RUN_CLEANUP_BEFORE_OPEN:-1}" = "1" ]; then
  "${SCRIPT_DIR}/hitl-cleanup.sh" >/dev/null 2>&1 || true
fi

SESSION_ID="$(date +%s)-$(openssl rand -hex 4)"
SESSION_DIR="$(session_dir_for "${SESSION_ID}")"

PORT="$(random_in_range 20000 29999)"
DISPLAY_NUM="$(random_in_range 100 199)"
DISPLAY=":${DISPLAY_NUM}"
CDP_PORT="$(random_in_range 30000 39999)"
TTL_SECONDS="${OPENCLAW_HITL_TTL_SECONDS:-900}"
CREATED_AT="$(now_epoch)"
EXPIRES_AT="$((CREATED_AT + TTL_SECONDS))"

mkdir -p "${SESSION_DIR}"
chmod 700 "${SESSION_DIR}"

PUBLIC_HOST="${OPENCLAW_PUBLIC_HOST:-127.0.0.1}"
PUBLIC_SCHEME="${OPENCLAW_PUBLIC_SCHEME:-http}"

CHROMIUM_BIN="$(detect_chromium_bin || true)"
if [ -z "${CHROMIUM_BIN}" ]; then
  write_value "$(session_file "${SESSION_DIR}" status)" "FAILED"
  write_value "$(session_file "${SESSION_DIR}" created_at)" "${CREATED_AT}"
  write_value "$(session_file "${SESSION_DIR}" expires_at)" "${EXPIRES_AT}"
  write_value "$(session_file "${SESSION_DIR}" ttl_seconds)" "${TTL_SECONDS}"
  write_value "$(session_file "${SESSION_DIR}" target_url)" "${TARGET_URL}"
  write_value "$(session_file "${SESSION_DIR}" closed_reason)" "chromium_not_found"
  write_value "$(session_file "${SESSION_DIR}" last_action)" "open_failed"
  write_session_metadata "${SESSION_DIR}"
  echo "chromium executable not found" >&2
  exit 1
fi

XPRA_URL="${PUBLIC_SCHEME}://${PUBLIC_HOST}:${PORT}/"
CDP_URL="http://127.0.0.1:${CDP_PORT}"

write_value "$(session_file "${SESSION_DIR}" status)" "OPENING"
write_value "$(session_file "${SESSION_DIR}" display)" "${DISPLAY}"
write_value "$(session_file "${SESSION_DIR}" port)" "${PORT}"
write_value "$(session_file "${SESSION_DIR}" cdp_port)" "${CDP_PORT}"
write_value "$(session_file "${SESSION_DIR}" target_url)" "${TARGET_URL}"
write_value "$(session_file "${SESSION_DIR}" xpra_url)" "${XPRA_URL}"
write_value "$(session_file "${SESSION_DIR}" cdp_url)" "${CDP_URL}"
write_value "$(session_file "${SESSION_DIR}" created_at)" "${CREATED_AT}"
write_value "$(session_file "${SESSION_DIR}" expires_at)" "${EXPIRES_AT}"
write_value "$(session_file "${SESSION_DIR}" ttl_seconds)" "${TTL_SECONDS}"
write_value "$(session_file "${SESSION_DIR}" last_action)" "opening"
write_session_metadata "${SESSION_DIR}"

CHROMIUM_CMD="$(shell_join \
  "${CHROMIUM_BIN}" \
  "--no-sandbox" \
  "--disable-dev-shm-usage" \
  "--user-data-dir=${SESSION_DIR}/profile" \
  "--no-first-run" \
  "--no-default-browser-check" \
  "--new-window" \
  "--start-maximized" \
  "--remote-debugging-address=127.0.0.1" \
  "--remote-debugging-port=${CDP_PORT}" \
  "${TARGET_URL}")"

if ! xpra start "${DISPLAY}" \
  --bind-tcp=0.0.0.0:${PORT} \
  --html=on \
  --daemon=yes \
  --exit-with-children=yes \
  --start-child="${CHROMIUM_CMD}" \
  > "${SESSION_DIR}/xpra-start.log" 2>&1; then
  write_value "$(session_file "${SESSION_DIR}" status)" "FAILED"
  write_value "$(session_file "${SESSION_DIR}" closed_reason)" "xpra_start_failed"
  write_value "$(session_file "${SESSION_DIR}" last_action)" "open_failed"
  write_session_metadata "${SESSION_DIR}"
  echo "xpra failed to start" >&2
  exit 1
fi

sleep 4

for _ in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:${CDP_PORT}/json/version" > "${SESSION_DIR}/cdp-version.json" 2>/dev/null; then
    break
  fi
  sleep 1
done

if ! test -f "${SESSION_DIR}/cdp-version.json"; then
  write_value "$(session_file "${SESSION_DIR}" status)" "FAILED"
  write_value "$(session_file "${SESSION_DIR}" closed_reason)" "cdp_unavailable"
  write_value "$(session_file "${SESSION_DIR}" last_action)" "open_failed"
  write_session_metadata "${SESSION_DIR}"
  xpra stop "${DISPLAY}" >/dev/null 2>&1 || true
  echo "CDP endpoint did not come up" >&2
  if test -f "/run/user/$(id -u)/xpra/${DISPLAY}.log"; then
    cat "/run/user/$(id -u)/xpra/${DISPLAY}.log" >&2 || true
  fi
  exit 1
fi

write_value "$(session_file "${SESSION_DIR}" status)" "WAITING_FOR_USER"
write_value "$(session_file "${SESSION_DIR}" last_action)" "opened"
write_value "$(session_file "${SESSION_DIR}" last_url)" "${TARGET_URL}"
write_session_metadata "${SESSION_DIR}"

cat "$(session_file "${SESSION_DIR}" session.json)"
