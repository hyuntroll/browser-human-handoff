#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_DIR="${OPENCLAW_HITL_BASE_DIR:-${HOME}/.openclaw-hitl}"

ensure_base_dir() {
  mkdir -p "${BASE_DIR}"
  chmod 700 "${BASE_DIR}" 2>/dev/null || true
}

session_dir_for() {
  local session_id="${1:?session id required}"
  printf '%s/%s\n' "${BASE_DIR}" "${session_id}"
}

session_file() {
  local session_dir="${1:?session dir required}"
  local name="${2:?session file name required}"
  printf '%s/%s\n' "${session_dir}" "${name}"
}

read_optional_file() {
  local path="${1:?path required}"
  if [ -f "${path}" ]; then
    cat "${path}"
  fi
}

write_value() {
  local path="${1:?path required}"
  local value="${2-}"
  printf '%s\n' "${value}" > "${path}"
}

now_epoch() {
  date +%s
}

random_in_range() {
  local min="${1:?minimum required}"
  local max="${2:?maximum required}"
  local span=$((max - min + 1))
  local random_num

  random_num="$(od -An -N2 -tu2 /dev/urandom | tr -d ' ')"
  printf '%s\n' "$((min + (random_num % span)))"
}

json_escape() {
  local value="${1-}"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  value="${value//$'\r'/\\r}"
  value="${value//$'\t'/\\t}"
  printf '%s' "${value}"
}

json_string_or_null() {
  local value="${1-}"
  if [ -n "${value}" ]; then
    printf '"%s"' "$(json_escape "${value}")"
  else
    printf 'null'
  fi
}

json_number_or_null() {
  local value="${1-}"
  if [ -n "${value}" ]; then
    printf '%s' "${value}"
  else
    printf 'null'
  fi
}

status_is_terminal() {
  local status="${1-}"
  case "${status}" in
    CLOSED|EXPIRED|FAILED)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

write_session_metadata() {
  local session_dir="${1:?session dir required}"
  local session_id
  session_id="$(basename "${session_dir}")"

  local status display xpra_port cdp_port target_url xpra_url cdp_url
  local created_at expires_at ttl_seconds closed_at last_action last_url
  local last_screenshot closed_reason

  status="$(read_optional_file "$(session_file "${session_dir}" status)")"
  display="$(read_optional_file "$(session_file "${session_dir}" display)")"
  xpra_port="$(read_optional_file "$(session_file "${session_dir}" port)")"
  cdp_port="$(read_optional_file "$(session_file "${session_dir}" cdp_port)")"
  target_url="$(read_optional_file "$(session_file "${session_dir}" target_url)")"
  xpra_url="$(read_optional_file "$(session_file "${session_dir}" xpra_url)")"
  cdp_url="$(read_optional_file "$(session_file "${session_dir}" cdp_url)")"
  created_at="$(read_optional_file "$(session_file "${session_dir}" created_at)")"
  expires_at="$(read_optional_file "$(session_file "${session_dir}" expires_at)")"
  ttl_seconds="$(read_optional_file "$(session_file "${session_dir}" ttl_seconds)")"
  closed_at="$(read_optional_file "$(session_file "${session_dir}" closed_at)")"
  last_action="$(read_optional_file "$(session_file "${session_dir}" last_action)")"
  last_url="$(read_optional_file "$(session_file "${session_dir}" last_url)")"
  last_screenshot="$(read_optional_file "$(session_file "${session_dir}" last_screenshot)")"
  closed_reason="$(read_optional_file "$(session_file "${session_dir}" closed_reason)")"

  cat > "$(session_file "${session_dir}" session.json)" <<JSON
{
  "session_id": "$(json_escape "${session_id}")",
  "status": $(json_string_or_null "${status}"),
  "created_at": $(json_number_or_null "${created_at}"),
  "expires_at": $(json_number_or_null "${expires_at}"),
  "closed_at": $(json_number_or_null "${closed_at}"),
  "ttl_seconds": $(json_number_or_null "${ttl_seconds}"),
  "target_url": $(json_string_or_null "${target_url}"),
  "xpra_url": $(json_string_or_null "${xpra_url}"),
  "cdp_url": $(json_string_or_null "${cdp_url}"),
  "display": $(json_string_or_null "${display}"),
  "xpra_port": $(json_number_or_null "${xpra_port}"),
  "cdp_port": $(json_number_or_null "${cdp_port}"),
  "last_action": $(json_string_or_null "${last_action}"),
  "last_url": $(json_string_or_null "${last_url}"),
  "last_screenshot": $(json_string_or_null "${last_screenshot}"),
  "closed_reason": $(json_string_or_null "${closed_reason}"),
  "session_dir": "$(json_escape "${session_dir}")"
}
JSON
}
