const folderInput = document.getElementById("folderPath");
const ipInput = document.getElementById("oscIp");
const portInput = document.getElementById("oscPort");
const addressInput = document.getElementById("oscAddress");
const recursiveInput = document.getElementById("recursiveScan");
const sendPathAsOscInput = document.getElementById("sendPathAsOsc");
const asciiSafeOscPathInput = document.getElementById("asciiSafeOscPath");
const viewModeInput = document.getElementById("viewMode");
const instanceButtons = Array.from(document.querySelectorAll(".instance-btn"));
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
const RENDER_CHUNK_SIZE = 80;
const MAX_ANIMATION_STAGGER_MS = 700;
const PAGE_NAVIGATION_STEP = 8;
const INSTANCE_COUNT = 4;
const previewRequestCache = new Map();

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

let activeInstanceId = 1;
let instanceStates = createInstanceStates();
let lastLoadedVideos = [];
let lastSentVideoPath = null;

function createDefaultSettings(layerId = 1) {
  return {
    folderPath: "",
    oscIp: "",
    oscPort: "",
    oscAddress: `/d3/videoselect/${layerId}`,
    recursiveScan: true,
    sendPathAsOsc: true,
    asciiSafeOscPath: false,
    viewMode: "all",
  };
}

function createInstanceStates() {
  return Array.from({ length: INSTANCE_COUNT }, (_unused, index) => ({
    id: index + 1,
    settings: createDefaultSettings(index + 1),
    videos: [],
    lastSentVideoPath: null,
    statusMessage: "",
    statusIsError: false,
  }));
}

function getActiveInstanceState() {
  return instanceStates[activeInstanceId - 1];
}

function readSettingsFromInputs() {
  return {
    folderPath: folderInput.value,
    oscIp: ipInput.value,
    oscPort: portInput.value,
    oscAddress: addressInput.value,
    recursiveScan: recursiveInput.checked,
    sendPathAsOsc: sendPathAsOscInput.checked,
    asciiSafeOscPath: asciiSafeOscPathInput.checked,
    viewMode: viewModeInput.value,
  };
}

function applySettingsToInputs(settings, layerId = activeInstanceId) {
  const merged = { ...createDefaultSettings(layerId), ...(settings || {}) };
  folderInput.value = merged.folderPath;
  ipInput.value = merged.oscIp;
  portInput.value = merged.oscPort;
  addressInput.value = merged.oscAddress;
  recursiveInput.checked = Boolean(merged.recursiveScan);
  sendPathAsOscInput.checked = Boolean(merged.sendPathAsOsc);
  asciiSafeOscPathInput.checked = Boolean(merged.asciiSafeOscPath);
  viewModeInput.value = merged.viewMode;
}

function syncActiveInstanceState() {
  const state = getActiveInstanceState();
  if (!state) {
    return;
  }

  state.settings = readSettingsFromInputs();
  state.videos = lastLoadedVideos;
  state.lastSentVideoPath = lastSentVideoPath;
  state.statusMessage = statusEl.textContent;
  state.statusIsError = statusEl.dataset.error === "true";
}

function replicateLayer1SharedFields() {
  if (activeInstanceId !== 1) {
    return;
  }

  const layer1 = instanceStates[0];
  if (!layer1 || !layer1.settings) {
    return;
  }

  const { folderPath, oscIp, oscPort } = layer1.settings;
  for (let idx = 1; idx < instanceStates.length; idx += 1) {
    const state = instanceStates[idx];
    state.settings = {
      ...state.settings,
      folderPath,
      oscIp,
      oscPort,
    };
  }
}

function updateInstanceButtons() {
  instanceButtons.forEach((button) => {
    const buttonInstanceId = Number(button.dataset.instanceId);
    button.classList.toggle("active", buttonInstanceId === activeInstanceId);
  });
}

function isTypingTarget(target) {
  if (!target) {
    return false;
  }
  const tag = String(target.tagName || "").toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

function getNavigableCards() {
  return Array.from(gridEl.querySelectorAll(".card")).filter((card) => card.offsetParent !== null);
}

function markKeyboardActiveCard(card) {
  gridEl.querySelectorAll(".card.keyboard-active").forEach((el) => {
    el.classList.remove("keyboard-active");
    el.tabIndex = -1;
  });

  if (!card) {
    return;
  }

  card.classList.add("keyboard-active");
  card.tabIndex = 0;
}

function focusCard(card, options = {}) {
  const { scroll = true } = options;
  if (!card) {
    return;
  }
  markKeyboardActiveCard(card);
  card.focus({ preventScroll: true });
  if (scroll) {
    card.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
}

async function switchInstance(nextInstanceId) {
  if (nextInstanceId === activeInstanceId) {
    return;
  }

  syncActiveInstanceState();
  activeInstanceId = nextInstanceId;

  const state = getActiveInstanceState();
  applySettingsToInputs(state.settings);
  lastLoadedVideos = state.videos || [];
  lastSentVideoPath = state.lastSentVideoPath || null;
  closeBrowser();
  updateInstanceButtons();
  saveUiState();

  if (lastLoadedVideos.length > 0) {
    await renderCurrentView();
    setStatus(state.statusMessage || `Switched to layer ${nextInstanceId}.`, state.statusIsError);
    return;
  }

  gridEl.innerHTML = "";
  gridEl.classList.toggle("folder-groups-mode", viewModeInput.value === "folder");
  setStatus(state.statusMessage || `Switched to layer ${nextInstanceId}. Load videos for this layer.`);
}

function restoreKeyboardCardAfterRender() {
  const cards = getNavigableCards();
  if (!cards.length) {
    return;
  }

  const preferred = lastSentVideoPath
    ? cards.find((card) => card.dataset.videoPath === lastSentVideoPath)
    : null;
  markKeyboardActiveCard(preferred || cards[0]);
}

function getCurrentKeyboardCard() {
  const focusedCard = document.activeElement && document.activeElement.classList.contains("card")
    ? document.activeElement
    : null;
  if (focusedCard) {
    return focusedCard;
  }
  return gridEl.querySelector(".card.keyboard-active");
}

function handleGridKeyboardNavigation(event) {
  if (isTypingTarget(event.target)) {
    return;
  }

  const cards = getNavigableCards();
  if (!cards.length) {
    return;
  }

  const key = event.key;
  const current = getCurrentKeyboardCard() || cards[0];
  let index = cards.indexOf(current);
  if (index < 0) {
    index = 0;
  }

  if (key === "ArrowRight" || key === "ArrowDown") {
    event.preventDefault();
    focusCard(cards[Math.min(cards.length - 1, index + 1)]);
    return;
  }

  if (key === "ArrowLeft" || key === "ArrowUp") {
    event.preventDefault();
    focusCard(cards[Math.max(0, index - 1)]);
    return;
  }

  if (key === "Home") {
    event.preventDefault();
    focusCard(cards[0]);
    return;
  }

  if (key === "End") {
    event.preventDefault();
    focusCard(cards[cards.length - 1]);
    return;
  }

  if (key === "PageDown") {
    event.preventDefault();
    focusCard(cards[Math.min(cards.length - 1, index + PAGE_NAVIGATION_STEP)]);
    return;
  }

  if (key === "PageUp") {
    event.preventDefault();
    focusCard(cards[Math.max(0, index - PAGE_NAVIGATION_STEP)]);
    return;
  }

  if (key === " ") {
    event.preventDefault();
    current.click();
    return;
  }

  if (key === "b" || key === "B") {
    event.preventDefault();
    void sendNoneOscMessage();
  }
}

function saveUiState() {
  try {
    syncActiveInstanceState();
    replicateLayer1SharedFields();
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        activeInstanceId,
        instances: instanceStates.map((state) => state.settings),
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
      applySettingsToInputs(getActiveInstanceState().settings);
      updateInstanceButtons();
      return;
    }
    const state = JSON.parse(raw);
    if (Array.isArray(state.instances)) {
      state.instances.slice(0, INSTANCE_COUNT).forEach((settings, index) => {
        instanceStates[index].settings = { ...createDefaultSettings(index + 1), ...(settings || {}) };
      });
    } else {
      instanceStates[0].settings = {
        ...createDefaultSettings(1),
        ...(state || {}),
      };
    }
    if (Number.isInteger(state.activeInstanceId) && state.activeInstanceId >= 1 && state.activeInstanceId <= INSTANCE_COUNT) {
      activeInstanceId = state.activeInstanceId;
    }
    applySettingsToInputs(getActiveInstanceState().settings);
    updateInstanceButtons();
  } catch (error) {
    // Ignore malformed stored data.
    applySettingsToInputs(getActiveInstanceState().settings);
    updateInstanceButtons();
  }
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? "#9f2c1f" : "#1c1e1f";
  statusEl.dataset.error = isError ? "true" : "false";
  const state = getActiveInstanceState();
  if (state) {
    state.statusMessage = message;
    state.statusIsError = isError;
  }
}

function nextAnimationFrame() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function getVideoFolderKey(video) {
  if (typeof video.relativeDir === "string" && video.relativeDir.trim()) {
    return video.relativeDir;
  }

  const relativePath = String(video.relativePath || "");
  const slashIndex = relativePath.lastIndexOf("/");
  if (slashIndex <= 0) {
    return "/";
  }
  return relativePath.slice(0, slashIndex);
}

function groupVideosByFolder(videos) {
  const groups = new Map();
  videos.forEach((video) => {
    const folderKey = getVideoFolderKey(video);
    const existing = groups.get(folderKey);
    if (existing) {
      existing.push(video);
      return;
    }
    groups.set(folderKey, [video]);
  });

  return Array.from(groups.entries())
    .map(([folder, groupedVideos]) => ({ folder, videos: groupedVideos }))
    .sort((a, b) => a.folder.localeCompare(b.folder));
}

function toAsciiSafePath(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7E]/g, "_");
}

async function sendOscRequest(requestBody) {
  const response = await fetch("/api/send-osc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Failed to send OSC");
  }

  return data;
}

async function sendNoneOscMessage() {
  const ip = ipInput.value.trim();
  const port = Number(portInput.value);
  const address = addressInput.value.trim();

  if (!ip || Number.isNaN(port) || !address) {
    setStatus("Set OSC IP, port, and address first.", true);
    return;
  }

  try {
    await sendOscRequest({
      ip,
      port,
      address,
      useFilePath: true,
      filePath: "/none",
    });
    setStatus(`Sent OSC ${address} with path /none to ${ip}:${port}`);
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function ensurePreview(video, options = {}) {
  const { generateGif = false } = options;
  const requestKey = `${video.fullPath}:${generateGif ? "gif" : "thumb"}`;
  const existingRequest = previewRequestCache.get(requestKey);
  if (existingRequest) {
    return existingRequest;
  }

  const request = (async () => {
    const response = await fetch("/api/previews/ensure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videoPath: video.fullPath, generateGif }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Failed to generate preview");
    }
    if (data.thumbUrl) {
      video.thumbUrl = data.thumbUrl;
      video.thumbReady = true;
    }
    if (data.gifUrl) {
      video.gifUrl = data.gifUrl;
      video.gifReady = true;
    }
    return data;
  })().finally(() => {
    previewRequestCache.delete(requestKey);
  });

  previewRequestCache.set(requestKey, request);
  return request;
}

function createCard(video, delayMs) {
  const card = document.createElement("article");
  card.className = `card${video.isBroken ? " broken" : ""}`;
  card.tabIndex = -1;
  card.dataset.videoPath = video.fullPath;
  if (video.fullPath === lastSentVideoPath) {
    card.classList.add("last-sent");
  }
  card.style.animationDelay = `${delayMs}ms`;
  const hasThumb = Boolean(video.thumbUrl) && !video.isBroken;
  const hasGif = Boolean(video.gifUrl) && !video.isBroken;
  const thumbSrc = hasThumb ? video.thumbUrl : PLACEHOLDER_PREVIEW;
  const gifSrc = hasGif ? video.gifUrl : thumbSrc;
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
      ${hasThumb ? "" : `<div class="preview-warning">${warningText}</div>`}
    </div>
  `;

  const previewEl = card.querySelector(".preview");
  const thumbEl = card.querySelector(".thumb");
  const gifEl = card.querySelector(".gif");
  const warningEl = card.querySelector(".preview-warning");

  const refreshPreviewState = () => {
    if (video.thumbUrl) {
      thumbEl.src = video.thumbUrl;
      if (!video.gifUrl) {
        gifEl.src = video.thumbUrl;
      }
    }
    if (video.gifUrl) {
      gifEl.src = video.gifUrl;
    }
    if (video.thumbUrl && warningEl) {
      warningEl.remove();
    }
  };

  card.requestVisiblePreview = async () => {
    if (video.isBroken || video.thumbUrl) {
      return;
    }
    try {
      await ensurePreview(video, { generateGif: false });
      refreshPreviewState();
    } catch (_error) {
      // Ignore item-level preview errors so one bad file does not break the grid.
    }
  };

  previewEl.addEventListener("mouseenter", async () => {
    if (video.isBroken || video.gifUrl) {
      return;
    }
    try {
      await ensurePreview(video, { generateGif: true });
      refreshPreviewState();
    } catch (_error) {
      // Ignore hover preview failures and keep static thumbnail/placeholder.
    }
  });

  card.addEventListener("click", async () => {
    const ip = ipInput.value.trim();
    const port = Number(portInput.value);
    const address = addressInput.value.trim();
    const useFilePath = Boolean(sendPathAsOscInput.checked);
    const useAsciiSafePath = Boolean(asciiSafeOscPathInput.checked);
    const relativePath = String((useFilePath ? (video.baseRelativePath || video.relativePath) : video.relativePath) || "").trim();
    const oscPath = useAsciiSafePath ? toAsciiSafePath(relativePath) : relativePath;

    if (!ip || Number.isNaN(port) || !address) {
      setStatus("Set OSC IP, port, and address first.", true);
      return;
    }

    if (useFilePath && !oscPath) {
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
      requestBody.filePath = oscPath;
    } else {
      requestBody.index = video.index;
    }

    try {
      await sendOscRequest(requestBody);

      document.querySelectorAll(".card.last-sent").forEach((el) => {
        el.classList.remove("last-sent");
      });
      card.classList.add("last-sent");
      lastSentVideoPath = video.fullPath;
      getActiveInstanceState().lastSentVideoPath = lastSentVideoPath;
      markKeyboardActiveCard(card);

      if (useFilePath) {
        setStatus(`Sent OSC ${address} with path ${oscPath} to ${ip}:${port}`);
      } else {
        setStatus(`Sent OSC ${address} with index ${video.index} to ${ip}:${port}`);
      }
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  card.addEventListener("focus", () => {
    markKeyboardActiveCard(card);
  });

  return card;
}

const visiblePreviewObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) {
        return;
      }
      const card = entry.target;
      visiblePreviewObserver.unobserve(card);
      if (typeof card.requestVisiblePreview === "function") {
        card.requestVisiblePreview();
      }
    });
  },
  { rootMargin: "300px" },
);

async function renderVideoCards(videos, targetEl = gridEl) {
  for (let start = 0; start < videos.length; start += RENDER_CHUNK_SIZE) {
    const end = Math.min(start + RENDER_CHUNK_SIZE, videos.length);
    const fragment = document.createDocumentFragment();

    for (let idx = start; idx < end; idx += 1) {
      const stagger = Math.min(idx * 16, MAX_ANIMATION_STAGGER_MS);
      const card = createCard(videos[idx], stagger);
      fragment.appendChild(card);
      visiblePreviewObserver.observe(card);
    }

    targetEl.appendChild(fragment);
    await nextAnimationFrame();
  }
}

async function renderFolderSections(videos) {
  const grouped = groupVideosByFolder(videos);
  const sectionElements = [];

  for (let index = 0; index < grouped.length; index += 1) {
    const group = grouped[index];
    const section = document.createElement("details");
    section.className = "folder-section";
    section.open = index === 0;

    const summary = document.createElement("summary");
    summary.className = "folder-summary";
    summary.textContent = `Folder: ${group.folder} (${group.videos.length})`;

    const folderGrid = document.createElement("div");
    folderGrid.className = "folder-grid";

    section.appendChild(summary);
    section.appendChild(folderGrid);
    gridEl.appendChild(section);
    sectionElements.push(section);

    section.addEventListener("toggle", () => {
      if (!section.open) {
        return;
      }
      sectionElements.forEach((otherSection) => {
        if (otherSection !== section && otherSection.open) {
          otherSection.open = false;
        }
      });
    });

    await renderVideoCards(group.videos, folderGrid);
  }

  return grouped.length;
}

async function renderCurrentView() {
  gridEl.innerHTML = "";
  if (!lastLoadedVideos.length) {
    return;
  }

  const isFolderMode = viewModeInput.value === "folder";
  gridEl.classList.toggle("folder-groups-mode", isFolderMode);

  if (!isFolderMode) {
    await renderVideoCards(lastLoadedVideos);
    restoreKeyboardCardAfterRender();
    setStatus(`Showing all ${lastLoadedVideos.length} loaded videos.`);
    return;
  }

  const folderCount = await renderFolderSections(lastLoadedVideos);
  restoreKeyboardCardAfterRender();
  setStatus(`Showing ${lastLoadedVideos.length} videos across ${folderCount} folders. Expand a folder to browse.`);
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
  lastSentVideoPath = null;
  getActiveInstanceState().lastSentVideoPath = null;
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
      lastLoadedVideos = [];
      getActiveInstanceState().videos = [];
      gridEl.classList.remove("folder-groups-mode");
      setStatus(recursive ? "No supported video files found in that folder tree." : "No supported video files found in that folder.");
      return;
    }

    lastLoadedVideos = data.videos;
    getActiveInstanceState().videos = lastLoadedVideos;
    await renderCurrentView();

    if (data.previewFailedCount > 0) {
      setStatus(
        `Loaded ${data.count} videos${recursive ? " (recursive)" : ""}. ${data.previewFailedCount} file(s) could not be previewed.`,
        true,
      );
    } else if (data.previewPendingCount > 0) {
      setStatus(
        `Loaded ${data.count} videos${recursive ? " (recursive)" : ""}. ${data.previewPendingCount} preview(s) will generate as you scroll/hover.`,
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
instanceButtons.forEach((button) => {
  button.addEventListener("click", async () => {
    const nextInstanceId = Number(button.dataset.instanceId);
    if (!Number.isInteger(nextInstanceId) || nextInstanceId < 1 || nextInstanceId > INSTANCE_COUNT) {
      return;
    }
    await switchInstance(nextInstanceId);
  });
});

[folderInput, ipInput, portInput, addressInput].forEach((input) => {
  input.addEventListener("input", saveUiState);
});
recursiveInput.addEventListener("change", saveUiState);
sendPathAsOscInput.addEventListener("change", saveUiState);
asciiSafeOscPathInput.addEventListener("change", saveUiState);
viewModeInput.addEventListener("change", async () => {
  saveUiState();
  if (lastLoadedVideos.length > 0) {
    await renderCurrentView();
  }
});

document.addEventListener("keydown", handleGridKeyboardNavigation);

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
