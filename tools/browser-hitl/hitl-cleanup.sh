#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/hitl-lib.sh"

ensure_base_dir

NOW="$(now_epoch)"

for SESSION_DIR in "${BASE_DIR}"/*; do
  [ -d "${SESSION_DIR}" ] || continue

  SESSION_ID="$(basename "${SESSION_DIR}")"
  EXPIRES_AT="$(read_optional_file "$(session_file "${SESSION_DIR}" expires_at)")"
  STATUS="$(read_optional_file "$(session_file "${SESSION_DIR}" status)")"
  CLOSED_REASON="$(read_optional_file "$(session_file "${SESSION_DIR}" closed_reason)")"

  [ -n "${EXPIRES_AT}" ] || continue

  if [ "${NOW}" -lt "${EXPIRES_AT}" ]; then
    continue
  fi

  if [ "${STATUS}" = "CLOSED" ]; then
    continue
  fi

  DISPLAY_VAL="$(read_optional_file "$(session_file "${SESSION_DIR}" display)")"
  if [ -n "${DISPLAY_VAL}" ]; then
    xpra stop "${DISPLAY_VAL}" >/dev/null 2>&1 || true
  fi

  if [ "${STATUS}" != "FAILED" ]; then
    write_value "$(session_file "${SESSION_DIR}" status)" "EXPIRED"
    write_value "$(session_file "${SESSION_DIR}" closed_reason)" "ttl_expired"
  elif [ -z "${CLOSED_REASON}" ]; then
    write_value "$(session_file "${SESSION_DIR}" closed_reason)" "ttl_expired"
  fi
  write_value "$(session_file "${SESSION_DIR}" closed_at)" "${NOW}"
  write_value "$(session_file "${SESSION_DIR}" last_action)" "expired_closed"
  write_session_metadata "${SESSION_DIR}"

  echo "expired ${SESSION_ID}"
done
