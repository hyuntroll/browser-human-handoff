#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/hitl-lib.sh"

SESSION_ID="${1:?session id required}"
SESSION_DIR="$(session_dir_for "${SESSION_ID}")"

if [ ! -d "${SESSION_DIR}" ]; then
  echo "session not found: ${SESSION_ID}" >&2
  exit 1
fi

CDP_PORT="$(read_optional_file "$(session_file "${SESSION_DIR}" cdp_port)")"
CREATED_AT="$(read_optional_file "$(session_file "${SESSION_DIR}" created_at)")"
EXPIRES_AT="$(read_optional_file "$(session_file "${SESSION_DIR}" expires_at)")"
NOW="$(now_epoch)"
STATUS="$(read_optional_file "$(session_file "${SESSION_DIR}" status)")"

ALIVE="false"
if [ -n "${CDP_PORT}" ] && curl -fsS "http://127.0.0.1:${CDP_PORT}/json/version" > /dev/null 2>&1; then
  ALIVE="true"
fi

EXPIRED="false"
if [ -n "${EXPIRES_AT}" ] && [ "${NOW}" -ge "${EXPIRES_AT}" ]; then
  EXPIRED="true"
  if ! status_is_terminal "${STATUS}"; then
    write_value "$(session_file "${SESSION_DIR}" status)" "EXPIRED"
    write_value "$(session_file "${SESSION_DIR}" last_action)" "expired"
    STATUS="EXPIRED"
  fi
fi

write_session_metadata "${SESSION_DIR}"

XPRA_URL="$(read_optional_file "$(session_file "${SESSION_DIR}" xpra_url)")"
CDP_URL="$(read_optional_file "$(session_file "${SESSION_DIR}" cdp_url)")"
TTL_SECONDS="$(read_optional_file "$(session_file "${SESSION_DIR}" ttl_seconds)")"
TARGET_URL="$(read_optional_file "$(session_file "${SESSION_DIR}" target_url)")"
DISPLAY_VAL="$(read_optional_file "$(session_file "${SESSION_DIR}" display)")"
XPRA_PORT="$(read_optional_file "$(session_file "${SESSION_DIR}" port)")"
CLOSED_AT="$(read_optional_file "$(session_file "${SESSION_DIR}" closed_at)")"
CLOSED_REASON="$(read_optional_file "$(session_file "${SESSION_DIR}" closed_reason)")"
LAST_ACTION="$(read_optional_file "$(session_file "${SESSION_DIR}" last_action)")"
LAST_URL="$(read_optional_file "$(session_file "${SESSION_DIR}" last_url)")"
LAST_SCREENSHOT="$(read_optional_file "$(session_file "${SESSION_DIR}" last_screenshot)")"

cat <<JSON
{
  "session_id": "$(json_escape "${SESSION_ID}")",
  "status": $(json_string_or_null "${STATUS}"),
  "alive": ${ALIVE},
  "expired": ${EXPIRED},
  "target_url": $(json_string_or_null "${TARGET_URL}"),
  "xpra_url": $(json_string_or_null "${XPRA_URL}"),
  "cdp_url": $(json_string_or_null "${CDP_URL}"),
  "display": $(json_string_or_null "${DISPLAY_VAL}"),
  "xpra_port": $(json_number_or_null "${XPRA_PORT}"),
  "cdp_port": $(json_number_or_null "${CDP_PORT}"),
  "ttl_seconds": $(json_number_or_null "${TTL_SECONDS}"),
  "created_at": $(json_number_or_null "${CREATED_AT}"),
  "expires_at": $(json_number_or_null "${EXPIRES_AT}"),
  "closed_at": $(json_number_or_null "${CLOSED_AT}"),
  "closed_reason": $(json_string_or_null "${CLOSED_REASON}"),
  "last_action": $(json_string_or_null "${LAST_ACTION}"),
  "last_url": $(json_string_or_null "${LAST_URL}"),
  "last_screenshot": $(json_string_or_null "${LAST_SCREENSHOT}"),
  "now": ${NOW}
}
JSON
