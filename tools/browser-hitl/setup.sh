#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
source "${SCRIPT_DIR}/hitl-lib.sh"

ENV_EXAMPLE="${ROOT_DIR}/.env.hitl.example"
ENV_LOCAL="${ROOT_DIR}/.env.hitl.local"
PACKAGE_JSON="${ROOT_DIR}/package.json"

INSTALL_OS_DEPS=0
INSTALL_NODE_DEPS=1
CHECK_ONLY=0

log() {
  printf '[hitl-setup] %s\n' "$*"
}

warn() {
  printf '[hitl-setup] %s\n' "$*" >&2
}

usage() {
  cat <<EOF
Usage: bash tools/browser-hitl/setup.sh [options]

Options:
  --check-only         Validate the local environment without installing anything
  --skip-node-deps     Do not run npm install
  --install-os-deps    Try to install xpra and Chromium with the detected package manager
  --help               Show this help text
EOF
}

have_cmd() {
  command -v "${1}" >/dev/null 2>&1
}

platform_name() {
  uname -s
}

install_os_dependencies() {
  local platform
  platform="$(platform_name)"

  case "${platform}" in
    Darwin)
      if ! have_cmd brew; then
        warn "Homebrew is required to auto-install macOS dependencies."
        warn "Install it first, then rerun with --install-os-deps."
        return 1
      fi

      local formulae=()
      for formula in bash curl openssl node xpra; do
        if ! brew list "${formula}" >/dev/null 2>&1; then
          formulae+=("${formula}")
        fi
      done

      if [ "${#formulae[@]}" -gt 0 ]; then
        log "Installing Homebrew formulae: ${formulae[*]}"
        brew install "${formulae[@]}"
      fi

      if ! detect_chromium_bin >/dev/null 2>&1; then
        log "Installing Chromium with Homebrew"
        brew install --cask chromium
      fi
      ;;
    Linux)
      if have_cmd apt-get; then
        log "Installing core dependencies with apt-get"
        sudo apt-get update
        sudo apt-get install -y --no-install-recommends \
          bash \
          curl \
          openssl \
          ca-certificates \
          nodejs \
          npm \
          xpra

        if ! detect_chromium_bin >/dev/null 2>&1; then
          if apt-cache show chromium >/dev/null 2>&1; then
            log "Installing Chromium with apt-get"
            sudo apt-get install -y --no-install-recommends chromium
          elif apt-cache show chromium-browser >/dev/null 2>&1; then
            log "Installing chromium-browser with apt-get"
            sudo apt-get install -y --no-install-recommends chromium-browser
          else
            warn "Chromium package was not found in apt repositories."
            return 1
          fi
        fi
      elif have_cmd dnf; then
        log "Installing core dependencies with dnf"
        sudo dnf install -y bash curl openssl ca-certificates nodejs npm xpra
        if ! detect_chromium_bin >/dev/null 2>&1; then
          log "Installing Chromium with dnf"
          sudo dnf install -y chromium
        fi
      else
        warn "Unsupported Linux package manager. Install xpra and Chromium manually."
        return 1
      fi
      ;;
    *)
      warn "Unsupported platform: ${platform}"
      return 1
      ;;
  esac
}

check_required_commands() {
  local missing=0

  for cmd in bash curl openssl od tr node; do
    if have_cmd "${cmd}"; then
      log "Found ${cmd}: $(command -v "${cmd}")"
    else
      warn "Missing required command: ${cmd}"
      missing=1
    fi
  done

  if have_cmd npm; then
    log "Found npm: $(command -v npm)"
  else
    warn "npm is missing. Node dependencies cannot be installed automatically."
    missing=1
  fi

  if have_cmd xpra; then
    log "Found xpra: $(command -v xpra)"
  else
    warn "xpra is missing."
    missing=1
  fi

  if [ -n "$(detect_chromium_bin)" ]; then
    log "Found Chromium-compatible browser: $(detect_chromium_bin)"
  else
    warn "Chromium, chromium-browser, or google-chrome is missing."
    missing=1
  fi

  return "${missing}"
}

ensure_env_file() {
  if [ ! -f "${ENV_EXAMPLE}" ]; then
    warn "Missing ${ENV_EXAMPLE}. Recreate the repository files first."
    return 1
  fi

  if [ ! -f "${ENV_LOCAL}" ]; then
    cp "${ENV_EXAMPLE}" "${ENV_LOCAL}"
    log "Created ${ENV_LOCAL}"
  else
    log "Keeping existing ${ENV_LOCAL}"
  fi
}

ensure_permissions() {
  chmod +x \
    "${SCRIPT_DIR}/setup.sh" \
    "${SCRIPT_DIR}/hitl-open.sh" \
    "${SCRIPT_DIR}/hitl-close.sh" \
    "${SCRIPT_DIR}/hitl-status.sh" \
    "${SCRIPT_DIR}/hitl-cleanup.sh" \
    "${SCRIPT_DIR}/browser-control.mjs"
  log "Ensured executable permissions on browser HITL scripts"
}

install_node_dependencies() {
  if [ ! -f "${PACKAGE_JSON}" ]; then
    warn "Missing ${PACKAGE_JSON}. Skipping npm install."
    return 1
  fi

  if ! have_cmd npm; then
    warn "npm is not available. Skipping npm install."
    return 1
  fi

  log "Installing Node dependencies from package.json"
  if [ -f "${ROOT_DIR}/package-lock.json" ]; then
    npm ci --no-fund --no-audit
  else
    npm install --no-fund --no-audit
  fi
}

print_next_steps() {
  cat <<EOF

Next steps
1. Edit ${ENV_LOCAL} and set OPENCLAW_PUBLIC_HOST for your reachable host or IP.
2. Load the environment before running HITL tools:
   set -a; source ${ENV_LOCAL}; set +a
3. Open a test session:
   bash tools/browser-hitl/hitl-open.sh "https://example.com"
4. Check the session:
   bash tools/browser-hitl/hitl-status.sh <session_id>
EOF
}

while [ $# -gt 0 ]; do
  case "${1}" in
    --check-only)
      CHECK_ONLY=1
      INSTALL_NODE_DEPS=0
      ;;
    --skip-node-deps)
      INSTALL_NODE_DEPS=0
      ;;
    --install-os-deps)
      INSTALL_OS_DEPS=1
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      warn "Unknown option: ${1}"
      usage
      exit 1
      ;;
  esac
  shift
done

log "Preparing browser human handoff v2.1 in ${ROOT_DIR}"

ensure_permissions
ensure_env_file

if [ "${INSTALL_OS_DEPS}" = "1" ]; then
  install_os_dependencies
fi

if ! check_required_commands; then
  warn "Some required dependencies are still missing."
  if [ "${CHECK_ONLY}" = "1" ]; then
    exit 1
  fi
fi

if [ "${INSTALL_NODE_DEPS}" = "1" ]; then
  if ! install_node_dependencies; then
    warn "Node dependency installation failed."
    exit 1
  fi
fi

if have_cmd npm && { [ -d "${ROOT_DIR}/node_modules/playwright-core" ] || [ -d "${ROOT_DIR}/node_modules/playwright" ]; }; then
  log "Playwright client library is installed in node_modules"
else
  warn "Playwright client library is not installed yet. Run npm install after network access is available."
fi

print_next_steps
