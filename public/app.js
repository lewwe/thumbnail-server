const folderInput = document.getElementById("folderPath");
const ipInput = document.getElementById("oscIp");
const portInput = document.getElementById("oscPort");
const addressInput = document.getElementById("oscAddress");
const recursiveInput = document.getElementById("recursiveScan");
const sendPathAsOscInput = document.getElementById("sendPathAsOsc");
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

const STORAGE_KEY = "thumbnailServer.uiState.v1";

const PLACEHOLDER_PREVIEW =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 320 180'><rect width='320' height='180' fill='%23292b2d'/><text x='50%' y='50%' dominant-baseline='middle' text-anchor='middle' font-family='Trebuchet MS,Segoe UI,sans-serif' font-size='18' fill='%23d9dde0'>No Preview</text></svg>",
  );

let browseState = {
  currentPath: "/",
  parentPath: "/",
  canGoUp: false,
  directories: [],
};

function saveUiState() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        folderPath: folderInput.value,
        oscIp: ipInput.value,
        oscPort: portInput.value,
        oscAddress: addressInput.value,
        recursiveScan: recursiveInput.checked,
        sendPathAsOsc: sendPathAsOscInput.checked,
      }),
    );
  } catch (error) {
    // Ignore storage issues to keep the UI functional in restricted browsers.
  }
}

function restoreUiState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return;
    }
    const state = JSON.parse(raw);
    if (typeof state.folderPath === "string") {
      folderInput.value = state.folderPath;
    }
    if (typeof state.oscIp === "string") {
      ipInput.value = state.oscIp;
    }
    if (typeof state.oscPort === "string") {
      portInput.value = state.oscPort;
    }
    if (typeof state.oscAddress === "string") {
      addressInput.value = state.oscAddress;
    }
    if (typeof state.recursiveScan === "boolean") {
      recursiveInput.checked = state.recursiveScan;
    }
    if (typeof state.sendPathAsOsc === "boolean") {
      sendPathAsOscInput.checked = state.sendPathAsOsc;
    }
  } catch (error) {
    // Ignore malformed stored data.
  }
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? "#9f2c1f" : "#1c1e1f";
}

function createCard(video, delayMs) {
  const card = document.createElement("article");
  card.className = `card${video.isBroken ? " broken" : ""}`;
  card.style.animationDelay = `${delayMs}ms`;
  const hasPreview = Boolean(video.thumbUrl) && !video.isBroken;
  const thumbSrc = hasPreview ? video.thumbUrl : PLACEHOLDER_PREVIEW;
  const gifSrc = video.isBroken ? thumbSrc : (video.gifUrl || thumbSrc);
  const warningText = video.isBroken ? "Broken video" : "Preview unavailable";

  card.innerHTML = `
    <div class="preview">
      <img class="thumb" src="${thumbSrc}" alt="Thumbnail for ${video.fileName}" loading="lazy" />
      <img class="gif" src="${gifSrc}" alt="Preview for ${video.fileName}" loading="lazy" />
      ${video.isBroken ? '<div class="broken-mark" aria-label="Broken video">X</div>' : ""}
    </div>
    <div class="meta">
      <span class="index">#${video.index}</span>
      <div class="name">${video.fileName}</div>
      ${hasPreview ? "" : `<div class="preview-warning">${warningText}</div>`}
    </div>
  `;

  card.addEventListener("click", async () => {
    const ip = ipInput.value.trim();
    const port = Number(portInput.value);
    const address = addressInput.value.trim();
    const useFilePath = Boolean(sendPathAsOscInput.checked);
    const relativePath = String(video.relativePath || "").trim();

    if (!ip || Number.isNaN(port) || !address) {
      setStatus("Set OSC IP, port, and address first.", true);
      return;
    }

    if (useFilePath && !relativePath) {
      setStatus("Missing relative file path for OSC payload.", true);
      return;
    }

    const requestBody = {
      ip,
      port,
      address,
      useFilePath,
    };

    if (useFilePath) {
      requestBody.filePath = relativePath;
    } else {
      requestBody.index = video.index;
    }

    try {
      const response = await fetch("/api/send-osc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to send OSC");
      }

      if (useFilePath) {
        setStatus(`Sent OSC ${address} with path ${relativePath} to ${ip}:${port}`);
      } else {
        setStatus(`Sent OSC ${address} with index ${video.index} to ${ip}:${port}`);
      }
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

    if (data.previewFailedCount > 0) {
      setStatus(
        `Loaded ${data.count} videos${recursive ? " (recursive)" : ""}. ${data.previewFailedCount} file(s) could not be previewed.`,
        true,
      );
    } else {
      setStatus(`Loaded ${data.count} videos${recursive ? " (recursive)" : ""}. Hover thumbnails to preview, click to send OSC.`);
    }
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    loadBtn.disabled = false;
  }
}

loadBtn.addEventListener("click", loadVideos);
browseBtn.addEventListener("click", openBrowser);
closeBrowserBtn.addEventListener("click", closeBrowser);

[folderInput, ipInput, portInput, addressInput].forEach((input) => {
  input.addEventListener("input", saveUiState);
});
recursiveInput.addEventListener("change", saveUiState);
sendPathAsOscInput.addEventListener("change", saveUiState);

browserUpBtn.addEventListener("click", () => {
  if (browseState.canGoUp) {
    browsePath(browseState.parentPath);
  }
});

selectCurrentBtn.addEventListener("click", () => {
  folderInput.value = browseState.currentPath;
  saveUiState();
  closeBrowser();
  setStatus(`Selected folder: ${browseState.currentPath}`);
});

restoreUiState();
