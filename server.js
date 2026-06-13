const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const dgram = require("dgram");
const ffmpegPath = require("ffmpeg-static");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const PREVIEW_DIR = path.join(__dirname, "previews");
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"]);
const METADATA_CONCURRENCY = Number(process.env.METADATA_CONCURRENCY || 32);
const previewJobs = new Map();

function isIgnoredFile(fileName) {
  return fileName.startsWith("._") || fileName === ".DS_Store";
}

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
  return !isIgnoredFile(fileName) && VIDEO_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

function getVersionedVideoInfo(videoPath) {
  const directory = path.dirname(videoPath);
  const fileName = path.basename(videoPath);
  const ext = path.extname(fileName).toLowerCase();
  const stem = fileName.slice(0, fileName.length - ext.length);
  const match = stem.match(/^(.*)_v(\d+)$/i);
  const baseStem = match ? match[1] : stem;
  const version = match ? Number(match[2]) : 0;
  const hasVersionTag = Boolean(match);

  return {
    key: `${directory}|${baseStem.toLowerCase()}|${ext}`,
    version,
    hasVersionTag,
  };
}

function keepLatestVersionedVideos(videoPaths) {
  const selected = new Map();

  for (const videoPath of videoPaths) {
    const info = getVersionedVideoInfo(videoPath);
    const current = selected.get(info.key);

    if (!current) {
      selected.set(info.key, { videoPath, ...info });
      continue;
    }

    const isHigherVersion = info.version > current.version;
    const isSameVersionAndVersionTagged =
      info.version === current.version && info.hasVersionTag && !current.hasVersionTag;
    const isSameVersionAndLexicallyLater =
      info.version === current.version && videoPath.localeCompare(current.videoPath) > 0;

    if (isHigherVersion || isSameVersionAndVersionTagged || isSameVersionAndLexicallyLater) {
      selected.set(info.key, { videoPath, ...info });
    }
  }

  return Array.from(selected.values())
    .map((entry) => entry.videoPath)
    .sort((a, b) => a.localeCompare(b));
}

function safeHash(input) {
  return crypto.createHash("sha1").update(input).digest("hex").slice(0, 16);
}

function getPreviewArtifacts(videoPath, stats) {
  const identity = `${videoPath}:${stats.size}:${stats.mtimeMs}`;
  const key = safeHash(identity);
  const thumbFile = `${key}.jpg`;
  const gifFile = `${key}.gif`;
  const thumbPath = path.join(PREVIEW_DIR, thumbFile);
  const gifPath = path.join(PREVIEW_DIR, gifFile);

  return {
    thumbPath,
    gifPath,
    thumbUrl: `/previews/${thumbFile}`,
    gifUrl: `/previews/${gifFile}`,
  };
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (_error) {
    return false;
  }
}

function runOncePerJob(jobKey, task) {
  const existing = previewJobs.get(jobKey);
  if (existing) {
    return existing;
  }

  const promise = task().finally(() => {
    previewJobs.delete(jobKey);
  });

  previewJobs.set(jobKey, promise);
  return promise;
}

async function mapWithConcurrency(items, limit, worker) {
  const safeLimit = Math.max(1, Number(limit) || 1);
  const output = new Array(items.length);
  let nextIndex = 0;

  async function consumeQueue() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }
      output[index] = await worker(items[index], index);
    }
  }

  const workers = Array.from({ length: Math.min(safeLimit, items.length) }, () => consumeQueue());
  await Promise.all(workers);
  return output;
}

async function findVideos(folderPath) {
  const entries = await fs.readdir(folderPath, { withFileTypes: true });
  const videos = entries
    .filter((entry) => entry.isFile() && isVideoFile(entry.name))
    .map((entry) => path.join(folderPath, entry.name));

  return keepLatestVersionedVideos(videos);
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

  return keepLatestVersionedVideos(videos);
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

function encodeOscStringUtf8(value) {
  const body = Buffer.from(String(value), "utf8");
  const lengthWithNull = body.length + 1;
  const padding = (4 - (lengthWithNull % 4)) % 4;
  return Buffer.concat([body, Buffer.alloc(1 + padding)]);
}

function buildOscPacket({ address, arg }) {
  const normalizedAddress = String(address || "");
  if (!normalizedAddress.startsWith("/")) {
    throw new Error("OSC address must start with '/'");
  }

  const typeTag = arg.type === "i" ? ",i" : ",s";
  const addressBytes = encodeOscStringUtf8(normalizedAddress);
  const typeTagBytes = encodeOscStringUtf8(typeTag);

  let argBytes;
  if (arg.type === "i") {
    argBytes = Buffer.alloc(4);
    argBytes.writeInt32BE(Number(arg.value) || 0, 0);
  } else if (arg.type === "s") {
    argBytes = encodeOscStringUtf8(arg.value);
  } else {
    throw new Error(`Unsupported OSC argument type: ${arg.type}`);
  }

  return Buffer.concat([addressBytes, typeTagBytes, argBytes]);
}

async function ensurePreviewArtifacts(videoPath, stats, options = {}) {
  const { generateGif = true } = options;
  const artifacts = getPreviewArtifacts(videoPath, stats);

  let thumbExists = await fileExists(artifacts.thumbPath);
  let gifExists = await fileExists(artifacts.gifPath);

  if (!thumbExists) {
    await runOncePerJob(`${artifacts.thumbPath}:thumb`, () =>
      runFfmpeg([
        "-y",
        "-fflags",
        "+genpts",
        "-i",
        videoPath,
        "-frames:v",
        "1",
        "-vf",
        "scale=320:-1",
        artifacts.thumbPath,
      ]),
    );
    thumbExists = true;
  }

  if (generateGif && !gifExists) {
    await runOncePerJob(`${artifacts.gifPath}:gif`, () =>
      runFfmpeg([
        "-y",
        "-fflags",
        "+genpts",
        "-i",
        videoPath,
        "-t",
        "2.5",
        "-an",
        "-vf",
        "fps=10,scale=320:-1:flags=lanczos",
        artifacts.gifPath,
      ]),
    );
    gifExists = true;
  }

  return {
    thumbUrl: thumbExists ? artifacts.thumbUrl : null,
    gifUrl: gifExists ? artifacts.gifUrl : null,
    thumbReady: thumbExists,
    gifReady: gifExists,
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
    const payload = await mapWithConcurrency(videos, METADATA_CONCURRENCY, async (videoPath, index) => {
      try {
        const videoStats = await fs.stat(videoPath);
        const artifacts = getPreviewArtifacts(videoPath, videoStats);
        const [thumbReady, gifReady] = await Promise.all([
          fileExists(artifacts.thumbPath),
          fileExists(artifacts.gifPath),
        ]);

        return {
          index,
          fileName: path.basename(videoPath),
          fullPath: videoPath,
          relativePath: path.relative(folderPath, videoPath).split(path.sep).join("/"),
          thumbUrl: thumbReady ? artifacts.thumbUrl : null,
          gifUrl: gifReady ? artifacts.gifUrl : null,
          previewError: null,
          isBroken: false,
          thumbReady,
          gifReady,
        };
      } catch (metadataError) {
        return {
          index,
          fileName: path.basename(videoPath),
          fullPath: videoPath,
          relativePath: path.relative(folderPath, videoPath).split(path.sep).join("/"),
          thumbUrl: null,
          gifUrl: null,
          previewError: metadataError.message || "Failed to read video metadata",
          isBroken: true,
          thumbReady: false,
          gifReady: false,
        };
      }
    });

    const previewPendingCount = payload.filter((video) => !video.thumbReady || !video.gifReady).length;
    const previewFailedCount = payload.filter((video) => Boolean(video.isBroken)).length;

    return res.json({
      count: payload.length,
      recursive,
      previewFailedCount,
      previewPendingCount,
      videos: payload,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Unknown error" });
  }
});

app.post("/api/previews/ensure", async (req, res) => {
  try {
    const videoPath = String(req.body.videoPath || "").trim();
    const generateGif = Boolean(req.body.generateGif);

    if (!videoPath) {
      return res.status(400).json({ error: "videoPath is required" });
    }

    if (!isVideoFile(path.basename(videoPath))) {
      return res.status(400).json({ error: "Unsupported video file extension" });
    }

    const stat = await fs.stat(videoPath);
    if (!stat.isFile()) {
      return res.status(400).json({ error: "videoPath must be a file" });
    }

    const previews = await ensurePreviewArtifacts(videoPath, stat, { generateGif });
    return res.json(previews);
  } catch (error) {
    if (error.code === "ENOENT") {
      return res.status(404).json({ error: "video file not found" });
    }
    return res.status(500).json({ error: error.message || "Failed to generate preview" });
  }
});

app.post("/api/send-osc", async (req, res) => {
  try {
    const ip = String(req.body.ip || "").trim();
    const address = String(req.body.address || "").trim();
    const port = Number(req.body.port);
    const useFilePath = Boolean(req.body.useFilePath);

    let arg;
    let sentValue;

    if (useFilePath) {
      const filePath = String(req.body.filePath || "").trim();
      if (!filePath) {
        return res.status(400).json({ error: "filePath is required when useFilePath is enabled" });
      }
      arg = { type: "s", value: filePath };
      sentValue = filePath;
    } else {
      const index = Number(req.body.index);
      if (Number.isNaN(index)) {
        return res.status(400).json({ error: "index is required when useFilePath is disabled" });
      }
      arg = { type: "i", value: index };
      sentValue = index;
    }

    if (!ip || !address || Number.isNaN(port)) {
      return res.status(400).json({ error: "ip, port, and address are required" });
    }

    const packet = buildOscPacket({ address, arg });

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

    return res.json({ sent: true, address, value: sentValue, valueType: arg.type, ip, port });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Failed to send OSC" });
  }
});

async function start() {
  await fs.mkdir(PREVIEW_DIR, { recursive: true });
  app.listen(PORT, HOST, () => {
    const localUiUrl = `http://localhost:${PORT}`;
    const boundUrl = `http://${HOST}:${PORT}`;
    console.log(`Thumbnail server listening on ${boundUrl}`);
    console.log(`Open UI: ${localUiUrl}`);
  });
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
