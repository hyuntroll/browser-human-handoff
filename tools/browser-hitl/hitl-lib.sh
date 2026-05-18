#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_DIR="${BROWSER_HANDOFF_BASE_DIR:-${HOME}/.hermes/browser-handoff}"

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

terminate_chromium_child() {
  local session_dir="${1:?session dir required}"
  local chromium_pid
  chromium_pid="$(read_optional_file "$(session_file "${session_dir}" chromium_pid)")"

  if [ -n "${chromium_pid}" ] && printf '%s' "${chromium_pid}" | grep -Eq '^[0-9]+$'; then
    if kill -0 "${chromium_pid}" >/dev/null 2>&1; then
      kill "${chromium_pid}" >/dev/null 2>&1 || true
      sleep 1
      if kill -0 "${chromium_pid}" >/dev/null 2>&1; then
        kill -9 "${chromium_pid}" >/dev/null 2>&1 || true
      fi
    fi
  fi
}

write_session_metadata() {
  local session_dir="${1:?session dir required}"
  local session_id
  session_id="$(basename "${session_dir}")"

  local status display xpra_port cdp_port target_url xpra_url cdp_url
  local created_at expires_at ttl_seconds closed_at last_action last_url
  local last_screenshot closed_reason chromium_pid xpra_password xpra_password_file
  local bind_host public_host public_scheme

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
  chromium_pid="$(read_optional_file "$(session_file "${session_dir}" chromium_pid)")"
  xpra_password="$(read_optional_file "$(session_file "${session_dir}" xpra_password)")"
  xpra_password_file="$(read_optional_file "$(session_file "${session_dir}" xpra_password_file)")"
  bind_host="$(read_optional_file "$(session_file "${session_dir}" bind_host)")"
  public_host="$(read_optional_file "$(session_file "${session_dir}" public_host)")"
  public_scheme="$(read_optional_file "$(session_file "${session_dir}" public_scheme)")"

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
  "xpra_password": $(json_string_or_null "${xpra_password}"),
  "xpra_password_file": $(json_string_or_null "${xpra_password_file}"),
  "cdp_url": $(json_string_or_null "${cdp_url}"),
  "display": $(json_string_or_null "${display}"),
  "bind_host": $(json_string_or_null "${bind_host}"),
  "public_host": $(json_string_or_null "${public_host}"),
  "public_scheme": $(json_string_or_null "${public_scheme}"),
  "xpra_port": $(json_number_or_null "${xpra_port}"),
  "cdp_port": $(json_number_or_null "${cdp_port}"),
  "chromium_pid": $(json_number_or_null "${chromium_pid}"),
  "last_action": $(json_string_or_null "${last_action}"),
  "last_url": $(json_string_or_null "${last_url}"),
  "last_screenshot": $(json_string_or_null "${last_screenshot}"),
  "closed_reason": $(json_string_or_null "${closed_reason}"),
  "session_dir": "$(json_escape "${session_dir}")"
}
JSON
}
