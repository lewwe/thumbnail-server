#!/usr/bin/env bash
set -euo pipefail

APP_NAME="thumbnail-server"
REPO_TAR_URL="${REPO_TAR_URL:-https://github.com/lewwe/thumbnail-server/archive/refs/heads/main.tar.gz}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/Applications/$APP_NAME}"
PORT="${PORT:-3000}"
HOST="${HOST:-0.0.0.0}"

log() {
  printf "\n[%s] %s\n" "$APP_NAME" "$1"
}

fail() {
  printf "\n[%s] ERROR: %s\n" "$APP_NAME" "$1" >&2
  exit 1
}

require_macos_arm64() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"

  [[ "$os" == "Darwin" ]] || fail "This installer only supports macOS."
  [[ "$arch" == "arm64" ]] || fail "This installer is for Apple Silicon (arm64)."
}

install_homebrew_if_missing() {
  if command -v brew >/dev/null 2>&1; then
    return
  fi

  log "Homebrew not found. Installing Homebrew..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

  if [[ -x "/opt/homebrew/bin/brew" ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  fi

  command -v brew >/dev/null 2>&1 || fail "Homebrew installation failed."
}

ensure_tools() {
  log "Installing required tools (git, node, ffmpeg)..."
  brew update
  brew install git node ffmpeg
}

download_and_extract() {
  log "Installing into: $INSTALL_DIR"
  rm -rf "$INSTALL_DIR"
  mkdir -p "$INSTALL_DIR"

  local tmp_tar
  tmp_tar="$(mktemp -t ${APP_NAME}.XXXXXX.tar.gz)"

  log "Downloading app package..."
  curl -fsSL "$REPO_TAR_URL" -o "$tmp_tar"

  log "Extracting package..."
  tar -xzf "$tmp_tar" -C "$INSTALL_DIR" --strip-components=1
  rm -f "$tmp_tar"
}

install_node_deps() {
  log "Installing Node dependencies..."
  cd "$INSTALL_DIR"
  npm install --omit=dev
}

write_run_script() {
  local run_script
  run_script="$INSTALL_DIR/run.command"

  cat >"$run_script" <<EOF
#!/usr/bin/env bash
set -euo pipefail
cd "$INSTALL_DIR"
export PORT="$PORT"
export HOST="$HOST"
exec npm start
EOF

  chmod +x "$run_script"
}

start_server() {
  log "Starting server on http://$HOST:$PORT"
  "$INSTALL_DIR/run.command"
}

main() {
  require_macos_arm64
  install_homebrew_if_missing
  ensure_tools
  download_and_extract
  install_node_deps
  write_run_script

  log "Install complete."
  log "Server folder browser sees folders on this Mac."
  start_server
}

main "$@"
