#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Shared helpers keep metadata writes consistent across scripts.
source "${SCRIPT_DIR}/hitl-lib.sh"

TARGET_URL="${1:-about:blank}"

ensure_base_dir

if [ "${BROWSER_HANDOFF_RUN_CLEANUP_BEFORE_OPEN:-1}" = "1" ]; then
  "${SCRIPT_DIR}/hitl-cleanup.sh" >/dev/null 2>&1 || true
fi

SESSION_ID="$(date +%s)-$(openssl rand -hex 4)"
SESSION_DIR="$(session_dir_for "${SESSION_ID}")"

PORT="$(random_in_range 20000 29999)"
DISPLAY_NUM="$(random_in_range 100 199)"
DISPLAY=":${DISPLAY_NUM}"
CDP_PORT="$(random_in_range 30000 39999)"
TTL_SECONDS="${BROWSER_HANDOFF_TTL_SECONDS:-900}"
CREATED_AT="$(now_epoch)"
EXPIRES_AT="$((CREATED_AT + TTL_SECONDS))"

mkdir -p "${SESSION_DIR}"
chmod 700 "${SESSION_DIR}"

BIND_HOST="${BROWSER_HANDOFF_BIND_HOST:-127.0.0.1}"
PUBLIC_HOST="${BROWSER_HANDOFF_PUBLIC_HOST:-127.0.0.1}"
PUBLIC_SCHEME="${BROWSER_HANDOFF_PUBLIC_SCHEME:-http}"
XPRA_PASSWORD="${BROWSER_HANDOFF_XPRA_PASSWORD:-$(openssl rand -base64 24 | tr -d '\n')}"
XPRA_PASSWORD_FILE="$(session_file "${SESSION_DIR}" xpra-password.txt)"
printf '%s\n' "${XPRA_PASSWORD}" > "${XPRA_PASSWORD_FILE}"
chmod 600 "${XPRA_PASSWORD_FILE}"

CHROMIUM_BIN="$(command -v chromium-browser || command -v chromium || command -v google-chrome || true)"
if [ -z "${CHROMIUM_BIN}" ]; then
  write_value "$(session_file "${SESSION_DIR}" status)" "FAILED"
  write_value "$(session_file "${SESSION_DIR}" created_at)" "${CREATED_AT}"
  write_value "$(session_file "${SESSION_DIR}" expires_at)" "${EXPIRES_AT}"
  write_value "$(session_file "${SESSION_DIR}" ttl_seconds)" "${TTL_SECONDS}"
  write_value "$(session_file "${SESSION_DIR}" target_url)" "${TARGET_URL}"
  write_value "$(session_file "${SESSION_DIR}" bind_host)" "${BIND_HOST}"
  write_value "$(session_file "${SESSION_DIR}" public_host)" "${PUBLIC_HOST}"
  write_value "$(session_file "${SESSION_DIR}" public_scheme)" "${PUBLIC_SCHEME}"
  write_value "$(session_file "${SESSION_DIR}" xpra_password)" "${XPRA_PASSWORD}"
  write_value "$(session_file "${SESSION_DIR}" xpra_password_file)" "${XPRA_PASSWORD_FILE}"
  write_value "$(session_file "${SESSION_DIR}" closed_reason)" "chromium_not_found"
  write_value "$(session_file "${SESSION_DIR}" last_action)" "open_failed"
  write_session_metadata "${SESSION_DIR}"
  echo "chromium executable not found" >&2
  exit 1
fi

XPRA_URL="${PUBLIC_SCHEME}://${PUBLIC_HOST}:${PORT}/"
CDP_URL="http://127.0.0.1:${CDP_PORT}"
CHROMIUM_WRAPPER="$(session_file "${SESSION_DIR}" start-chromium.sh)"

cat > "${CHROMIUM_WRAPPER}" <<'WRAPPER'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$$" > "${CHROMIUM_PID_FILE}"
exec "$CHROMIUM_BIN" \
  --no-sandbox \
  --disable-dev-shm-usage \
  --user-data-dir="${CHROMIUM_PROFILE_DIR}" \
  --no-first-run \
  --no-default-browser-check \
  --new-window \
  --start-maximized \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port="${CDP_PORT}" \
  "$TARGET_URL"
WRAPPER
chmod 700 "${CHROMIUM_WRAPPER}"

write_value "$(session_file "${SESSION_DIR}" status)" "OPENING"
write_value "$(session_file "${SESSION_DIR}" display)" "${DISPLAY}"
write_value "$(session_file "${SESSION_DIR}" port)" "${PORT}"
write_value "$(session_file "${SESSION_DIR}" cdp_port)" "${CDP_PORT}"
write_value "$(session_file "${SESSION_DIR}" target_url)" "${TARGET_URL}"
write_value "$(session_file "${SESSION_DIR}" xpra_url)" "${XPRA_URL}"
write_value "$(session_file "${SESSION_DIR}" xpra_password)" "${XPRA_PASSWORD}"
write_value "$(session_file "${SESSION_DIR}" xpra_password_file)" "${XPRA_PASSWORD_FILE}"
write_value "$(session_file "${SESSION_DIR}" cdp_url)" "${CDP_URL}"
write_value "$(session_file "${SESSION_DIR}" bind_host)" "${BIND_HOST}"
write_value "$(session_file "${SESSION_DIR}" public_host)" "${PUBLIC_HOST}"
write_value "$(session_file "${SESSION_DIR}" public_scheme)" "${PUBLIC_SCHEME}"
write_value "$(session_file "${SESSION_DIR}" created_at)" "${CREATED_AT}"
write_value "$(session_file "${SESSION_DIR}" expires_at)" "${EXPIRES_AT}"
write_value "$(session_file "${SESSION_DIR}" ttl_seconds)" "${TTL_SECONDS}"
write_value "$(session_file "${SESSION_DIR}" last_action)" "opening"
write_session_metadata "${SESSION_DIR}"

if ! CHROMIUM_BIN="${CHROMIUM_BIN}" \
  CHROMIUM_PROFILE_DIR="${SESSION_DIR}/profile" \
  CHROMIUM_PID_FILE="$(session_file "${SESSION_DIR}" chromium_pid)" \
  CDP_PORT="${CDP_PORT}" \
  TARGET_URL="${TARGET_URL}" \
  xpra start "${DISPLAY}" \
  --bind-tcp=${BIND_HOST}:${PORT} \
  --html=on \
  --daemon=yes \
  --exit-with-children=yes \
  --auth=file,filename=${XPRA_PASSWORD_FILE} \
  --start-child="${CHROMIUM_WRAPPER}" \
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
  terminate_chromium_child "${SESSION_DIR}"
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
