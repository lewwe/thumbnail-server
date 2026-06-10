#!/usr/bin/env bash
set -euo pipefail

APP_NAME="thumbnail-server"
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
  log "Installing required tools (node, ffmpeg)..."
  brew update
  brew install node ffmpeg
}

write_app_files() {
  log "Installing into: $INSTALL_DIR"
  rm -rf "$INSTALL_DIR"
  mkdir -p "$INSTALL_DIR/public" "$INSTALL_DIR/previews"

  cat >"$INSTALL_DIR/package.json" <<'EOF'
{
  "name": "thumbnail-server",
  "version": "1.0.0",
  "description": "Video thumbnail browser with hover previews and OSC trigger",
  "main": "server.js",
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "express": "^4.21.2",
    "ffmpeg-static": "^5.2.0",
    "osc": "^2.4.5"
  }
}
EOF

  cat >"$INSTALL_DIR/server.js" <<'EOF'
const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const dgram = require("dgram");
const ffmpegPath = require("ffmpeg-static");
const osc = require("osc");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const PREVIEW_DIR = path.join(__dirname, "previews");
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"]);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/previews", express.static(PREVIEW_DIR));

app.get("/api/browse", async (req, res) => {
  try {
    const requested = String(req.query.path || "/").trim() || "/";
    const currentPath = path.resolve(requested);
    const stat = await fs.stat(currentPath);

    if (!stat.isDirectory()) {
      return res.status(400).json({ error: "Path must be a directory" });
    }

    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    const directories = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        name: entry.name,
        fullPath: path.join(currentPath, entry.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const parentPath = path.dirname(currentPath);
    const canGoUp = parentPath !== currentPath;

    return res.json({
      currentPath,
      parentPath,
      canGoUp,
      directories,
    });
  } catch (error) {
    if (error.code === "ENOENT") {
      return res.status(404).json({ error: "Path not found" });
    }
    return res.status(500).json({ error: error.message || "Unknown error" });
  }
});

function isVideoFile(fileName) {
  return VIDEO_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

function safeHash(input) {
  return crypto.createHash("sha1").update(input).digest("hex").slice(0, 16);
}

async function findVideos(folderPath) {
  const entries = await fs.readdir(folderPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && isVideoFile(entry.name))
    .map((entry) => path.join(folderPath, entry.name))
    .sort((a, b) => a.localeCompare(b));
}

async function findVideosRecursive(folderPath) {
  const stack = [folderPath];
  const videos = [];

  while (stack.length > 0) {
    const currentDir = stack.pop();
    const entries = await fs.readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && isVideoFile(entry.name)) {
        videos.push(fullPath);
      }
    }
  }

  return videos.sort((a, b) => a.localeCompare(b));
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg failed with code ${code}: ${stderr}`));
      }
    });
  });
}

async function ensurePreviewArtifacts(videoPath, stats) {
  const identity = `${videoPath}:${stats.size}:${stats.mtimeMs}`;
  const key = safeHash(identity);
  const thumbFile = `${key}.jpg`;
  const gifFile = `${key}.gif`;
  const thumbPath = path.join(PREVIEW_DIR, thumbFile);
  const gifPath = path.join(PREVIEW_DIR, gifFile);

  const checks = await Promise.allSettled([fs.access(thumbPath), fs.access(gifPath)]);
  const thumbExists = checks[0].status === "fulfilled";
  const gifExists = checks[1].status === "fulfilled";

  if (!thumbExists) {
    await runFfmpeg([
      "-y",
      "-ss",
      "00:00:01",
      "-i",
      videoPath,
      "-frames:v",
      "1",
      "-vf",
      "scale=320:-1",
      thumbPath,
    ]);
  }

  if (!gifExists) {
    await runFfmpeg([
      "-y",
      "-ss",
      "00:00:01",
      "-i",
      videoPath,
      "-t",
      "2.5",
      "-vf",
      "fps=10,scale=320:-1:flags=lanczos",
      gifPath,
    ]);
  }

  return {
    thumbUrl: `/previews/${thumbFile}`,
    gifUrl: `/previews/${gifFile}`,
  };
}

app.post("/api/videos", async (req, res) => {
  try {
    const folderPath = String(req.body.folderPath || "").trim();
    const recursive = Boolean(req.body.recursive);
    if (!folderPath) {
      return res.status(400).json({ error: "folderPath is required" });
    }

    const stat = await fs.stat(folderPath);
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: "folderPath must be a directory" });
    }

    const videos = recursive
      ? await findVideosRecursive(folderPath)
      : await findVideos(folderPath);
    const payload = [];

    for (let index = 0; index < videos.length; index += 1) {
      const videoPath = videos[index];
      const videoStats = await fs.stat(videoPath);
      const previews = await ensurePreviewArtifacts(videoPath, videoStats);

      payload.push({
        index,
        fileName: path.basename(videoPath),
        fullPath: videoPath,
        thumbUrl: previews.thumbUrl,
        gifUrl: previews.gifUrl,
      });
    }

    return res.json({ count: payload.length, recursive, videos: payload });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Unknown error" });
  }
});

app.post("/api/send-osc", async (req, res) => {
  try {
    const ip = String(req.body.ip || "").trim();
    const address = String(req.body.address || "").trim();
    const port = Number(req.body.port);
    const index = Number(req.body.index);

    if (!ip || !address || Number.isNaN(port) || Number.isNaN(index)) {
      return res.status(400).json({ error: "ip, port, address, and index are required" });
    }

    const packet = osc.writePacket({
      address,
      args: [{ type: "i", value: index }],
    });

    await new Promise((resolve, reject) => {
      const socket = dgram.createSocket("udp4");
      socket.on("error", (err) => {
        socket.close();
        reject(err);
      });
      socket.send(packet, port, ip, (err) => {
        socket.close();
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });

    return res.json({ sent: true, address, index, ip, port });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Failed to send OSC" });
  }
});

async function start() {
  await fs.mkdir(PREVIEW_DIR, { recursive: true });
  app.listen(PORT, HOST, () => {
    console.log(`Thumbnail server running on http://${HOST}:${PORT}`);
  });
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
EOF

  cat >"$INSTALL_DIR/public/index.html" <<'EOF'
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Video Thumbnail OSC Browser</title>
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <main class="page">
      <header>
        <h1>Video Thumbnail OSC Browser</h1>
        <p>Choose a folder on the server, hover to preview, click to send OSC.</p>
      </header>

      <section class="controls">
        <label>
          Video folder path (server):
          <div class="path-picker-row">
            <input id="folderPath" type="text" placeholder="/path/to/videos" />
            <button id="browseBtn" type="button" class="secondary">Browse</button>
          </div>
        </label>
        <label>
          OSC IP:
          <input id="oscIp" type="text" placeholder="192.168.1.10" />
        </label>
        <label>
          OSC Port:
          <input id="oscPort" type="number" placeholder="8000" />
        </label>
        <label>
          OSC Address:
          <input id="oscAddress" type="text" value="/d3/videoselect" />
        </label>
        <label class="check-row">
          <input id="recursiveScan" type="checkbox" />
          Scan subfolders recursively
        </label>
        <button id="loadBtn" type="button">Load Videos</button>
      </section>

      <section id="browserPanel" class="browser-panel hidden" aria-live="polite">
        <div class="browser-head">
          <strong id="browserCurrentPath">/</strong>
          <div class="browser-actions">
            <button id="browserUpBtn" type="button" class="secondary">Up</button>
            <button id="selectCurrentBtn" type="button" class="secondary">Use This Folder</button>
            <button id="closeBrowserBtn" type="button" class="secondary">Close</button>
          </div>
        </div>
        <div id="browserList" class="browser-list"></div>
      </section>

      <p id="status" class="status"></p>

      <section id="grid" class="grid"></section>
    </main>

    <script src="app.js"></script>
  </body>
</html>
EOF

  cat >"$INSTALL_DIR/public/app.js" <<'EOF'
const folderInput = document.getElementById("folderPath");
const ipInput = document.getElementById("oscIp");
const portInput = document.getElementById("oscPort");
const addressInput = document.getElementById("oscAddress");
const recursiveInput = document.getElementById("recursiveScan");
const browseBtn = document.getElementById("browseBtn");
const browserPanel = document.getElementById("browserPanel");
const browserCurrentPathEl = document.getElementById("browserCurrentPath");
const browserListEl = document.getElementById("browserList");
const browserUpBtn = document.getElementById("browserUpBtn");
const selectCurrentBtn = document.getElementById("selectCurrentBtn");
const closeBrowserBtn = document.getElementById("closeBrowserBtn");
const loadBtn = document.getElementById("loadBtn");
const statusEl = document.getElementById("status");
const gridEl = document.getElementById("grid");

let browseState = {
  currentPath: "/",
  parentPath: "/",
  canGoUp: false,
  directories: [],
};

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? "#9f2c1f" : "#1c1e1f";
}

function createCard(video, delayMs) {
  const card = document.createElement("article");
  card.className = "card";
  card.style.animationDelay = `${delayMs}ms`;

  card.innerHTML = `
    <div class="preview">
      <img class="thumb" src="${video.thumbUrl}" alt="Thumbnail for ${video.fileName}" loading="lazy" />
      <img class="gif" src="${video.gifUrl}" alt="Preview for ${video.fileName}" loading="lazy" />
    </div>
    <div class="meta">
      <span class="index">#${video.index}</span>
      <div class="name">${video.fileName}</div>
    </div>
  `;

  card.addEventListener("click", async () => {
    const ip = ipInput.value.trim();
    const port = Number(portInput.value);
    const address = addressInput.value.trim();

    if (!ip || Number.isNaN(port) || !address) {
      setStatus("Set OSC IP, port, and address first.", true);
      return;
    }

    try {
      const response = await fetch("/api/send-osc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ip,
          port,
          address,
          index: video.index,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to send OSC");
      }

      setStatus(`Sent OSC ${address} with index ${video.index} to ${ip}:${port}`);
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  return card;
}

async function browsePath(targetPath) {
  browserListEl.innerHTML = "<div class=\"browser-empty\">Loading folders...</div>";

  try {
    const response = await fetch(`/api/browse?path=${encodeURIComponent(targetPath)}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Failed to browse path");
    }

    browseState = data;
    browserCurrentPathEl.textContent = data.currentPath;
    browserUpBtn.disabled = !data.canGoUp;

    if (!data.directories.length) {
      browserListEl.innerHTML = "<div class=\"browser-empty\">No subfolders in this directory.</div>";
      return;
    }

    browserListEl.innerHTML = "";
    data.directories.forEach((dir) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "folder-item";
      btn.textContent = dir.name;
      btn.addEventListener("click", () => {
        browsePath(dir.fullPath);
      });
      browserListEl.appendChild(btn);
    });
  } catch (error) {
    browserListEl.innerHTML = `<div class=\"browser-empty\">${error.message}</div>`;
  }
}

function openBrowser() {
  const startPath = folderInput.value.trim() || "/";
  browserPanel.classList.remove("hidden");
  browsePath(startPath);
}

function closeBrowser() {
  browserPanel.classList.add("hidden");
}

async function loadVideos() {
  const folderPath = folderInput.value.trim();
  const recursive = Boolean(recursiveInput.checked);
  if (!folderPath) {
    setStatus("Please enter a folder path.", true);
    return;
  }

  loadBtn.disabled = true;
  setStatus(recursive ? "Scanning folder tree and generating previews..." : "Scanning folder and generating previews...");
  gridEl.innerHTML = "";

  try {
    const response = await fetch("/api/videos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folderPath, recursive }),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Failed to load videos");
    }

    if (!data.videos.length) {
      setStatus(recursive ? "No supported video files found in that folder tree." : "No supported video files found in that folder.");
      return;
    }

    data.videos.forEach((video, idx) => {
      gridEl.appendChild(createCard(video, idx * 35));
    });

    setStatus(`Loaded ${data.count} videos${recursive ? " (recursive)" : ""}. Hover thumbnails to preview, click to send OSC.`);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    loadBtn.disabled = false;
  }
}

loadBtn.addEventListener("click", loadVideos);
browseBtn.addEventListener("click", openBrowser);
closeBrowserBtn.addEventListener("click", closeBrowser);

browserUpBtn.addEventListener("click", () => {
  if (browseState.canGoUp) {
    browsePath(browseState.parentPath);
  }
});

selectCurrentBtn.addEventListener("click", () => {
  folderInput.value = browseState.currentPath;
  closeBrowser();
  setStatus(`Selected folder: ${browseState.currentPath}`);
});
EOF

  cat >"$INSTALL_DIR/public/styles.css" <<'EOF'
:root {
  --bg: #f0efe9;
  --panel: #ffffff;
  --ink: #1c1e1f;
  --accent: #bf3b2b;
  --accent-soft: #f6dfd7;
  --line: #d8d4cb;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: "Trebuchet MS", "Segoe UI", sans-serif;
  background:
    radial-gradient(circle at 20% 20%, #fff7ee 0%, rgba(255, 247, 238, 0) 35%),
    radial-gradient(circle at 80% 10%, #f0f4ff 0%, rgba(240, 244, 255, 0) 40%),
    var(--bg);
  color: var(--ink);
}

.page {
  max-width: 1200px;
  margin: 0 auto;
  padding: 1.5rem;
}

h1 {
  margin: 0;
  font-size: clamp(1.6rem, 3vw, 2.4rem);
}

header p {
  margin-top: 0.4rem;
}

.controls {
  margin-top: 1rem;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 0.8rem;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 14px;
  padding: 1rem;
}

label {
  display: flex;
  flex-direction: column;
  font-size: 0.9rem;
  gap: 0.4rem;
}

.check-row {
  flex-direction: row;
  align-items: center;
  gap: 0.55rem;
  font-weight: 600;
}

.check-row input {
  min-height: auto;
  width: 18px;
  height: 18px;
}

input,
button {
  border: 1px solid #c5c1b7;
  border-radius: 10px;
  min-height: 40px;
  padding: 0.5rem 0.75rem;
  font-size: 0.95rem;
}

.path-picker-row {
  display: flex;
  gap: 0.55rem;
}

.path-picker-row input {
  flex: 1;
}

.secondary {
  background: #f8f7f2;
  color: #26292a;
}

.secondary:hover {
  filter: brightness(0.98);
}

.browser-panel {
  margin-top: 0.8rem;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 14px;
  padding: 0.8rem;
}

.browser-panel.hidden {
  display: none;
}

.browser-head {
  display: flex;
  flex-wrap: wrap;
  gap: 0.6rem;
  justify-content: space-between;
  align-items: center;
}

.browser-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.45rem;
}

.browser-list {
  margin-top: 0.7rem;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 0.45rem;
}

.folder-item {
  background: #f7f5ee;
  color: #202325;
  text-align: left;
  padding: 0.45rem 0.6rem;
}

.folder-item::before {
  content: "[DIR] ";
}

.browser-empty {
  color: #666d72;
  font-size: 0.9rem;
}

button {
  background: var(--accent);
  color: #fff;
  font-weight: 700;
  cursor: pointer;
}

button:hover {
  filter: brightness(1.05);
}

.status {
  min-height: 1.2rem;
  margin: 0.9rem 0;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 1rem;
}

.card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 14px;
  overflow: hidden;
  cursor: pointer;
  transform: translateY(10px);
  opacity: 0;
  animation: rise 300ms ease forwards;
}

@keyframes rise {
  to {
    transform: translateY(0);
    opacity: 1;
  }
}

.preview {
  position: relative;
  aspect-ratio: 16 / 9;
  background: #111;
}

.preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.preview .gif {
  position: absolute;
  inset: 0;
  opacity: 0;
  transition: opacity 180ms ease;
}

.card:hover .preview .gif {
  opacity: 1;
}

.meta {
  padding: 0.7rem;
}

.index {
  display: inline-block;
  background: var(--accent-soft);
  color: var(--accent);
  border-radius: 999px;
  padding: 0.18rem 0.55rem;
  font-weight: 700;
  font-size: 0.82rem;
}

.name {
  margin-top: 0.55rem;
  font-size: 0.9rem;
  word-break: break-word;
}

@media (max-width: 700px) {
  .page {
    padding: 1rem;
  }
}
EOF
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
  write_app_files
  install_node_deps
  write_run_script

  log "Install complete."
  log "This installer is self-contained and does not download app source from GitHub."
  start_server
}

main "$@"
