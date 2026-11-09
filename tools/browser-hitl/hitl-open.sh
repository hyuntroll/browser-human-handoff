#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/hitl-lib.sh"

if [ "$#" -eq 0 ]; then
  set -- about:blank
fi
hitl_handoff_cli open "$@"
