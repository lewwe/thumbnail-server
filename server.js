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
