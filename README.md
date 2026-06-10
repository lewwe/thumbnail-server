# thumbnail-server

A simple web server/UI to:

- Show thumbnails of videos from a user-provided server folder path.
- Show animated hover previews (GIF, no audio).
- Send an OSC UDP message with the clicked video's index.

## Features

- UI-defined folder path.
- Clickable server-side folder browser for selecting paths.
- Optional recursive scanning of subfolders.
- Alphabetical file ordering.
- Zero-based index assignment.
- OSC target IP and port set in UI.
- OSC address default: `/d3/videoselect`.
- OSC payload: integer argument equal to clicked index.

## Supported video files

`mp4`, `mov`, `m4v`, `webm`, `mkv`, `avi`

## Run

```bash
npm install
npm start
```

Then open `http://<server-ip>:3000` in your browser.

## One-file Install For macOS Apple Silicon

Run this single command on your M-series Mac:

```bash
curl -fsSL https://raw.githubusercontent.com/lewwe/thumbnail-server/main/install-macos-arm64.sh | bash
```

What it does:

- Verifies macOS arm64.
- Installs Homebrew if missing.
- Installs `node` and `ffmpeg`.
- Writes the full app locally into `~/Applications/thumbnail-server` from inside the installer script itself.
- Installs npm dependencies.
- Starts the server.

Optional environment overrides:

```bash
PORT=3100 HOST=0.0.0.0 INSTALL_DIR="$HOME/Applications/thumbnail-server" curl -fsSL https://raw.githubusercontent.com/lewwe/thumbnail-server/main/install-macos-arm64.sh | bash
```

Optional repo overrides:

```bash
REPO_GIT_URL="https://github.com/lewwe/thumbnail-server.git" REPO_BRANCH="main" curl -fsSL https://raw.githubusercontent.com/lewwe/thumbnail-server/main/install-macos-arm64.sh | bash
```

Alternative script with the same embedded app payload:

```bash
curl -fsSL https://raw.githubusercontent.com/lewwe/thumbnail-server/main/install-macos-arm64-selfcontained.sh | bash
```

## Notes

- Folder path is resolved on the server machine.
- Enable "Scan subfolders recursively" in the UI if videos are inside nested folders.
- Generated thumbnail/preview files are cached in `previews/`.
- Preview generation uses `ffmpeg-static`.
