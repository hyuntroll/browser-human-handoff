#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_DIR="${BROWSER_HANDOFF_BASE_DIR:-${HOME}/.hermes/browser-handoff}"

hitl_handoff_cli() {
  exec node "${SCRIPT_DIR}/hitl-handoff.mjs" "$@"
}
