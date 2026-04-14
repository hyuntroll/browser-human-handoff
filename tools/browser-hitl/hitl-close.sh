#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/hitl-lib.sh"

SESSION_ID="${1:?session id required}"
REASON="${2:-manual_close}"
SESSION_DIR="$(session_dir_for "${SESSION_ID}")"

if [ ! -d "${SESSION_DIR}" ]; then
  echo "session not found: ${SESSION_ID}" >&2
  exit 1
fi

DISPLAY_VAL="$(read_optional_file "$(session_file "${SESSION_DIR}" display)")"
if [ -n "${DISPLAY_VAL}" ]; then
  xpra stop "${DISPLAY_VAL}" >/dev/null 2>&1 || true
fi

write_value "$(session_file "${SESSION_DIR}" status)" "CLOSED"
write_value "$(session_file "${SESSION_DIR}" closed_reason)" "${REASON}"
write_value "$(session_file "${SESSION_DIR}" closed_at)" "$(now_epoch)"
write_value "$(session_file "${SESSION_DIR}" last_action)" "closed"
write_session_metadata "${SESSION_DIR}"

echo "closed ${SESSION_ID}"
