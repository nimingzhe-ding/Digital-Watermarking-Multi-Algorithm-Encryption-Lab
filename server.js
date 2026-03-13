const crypto = require("crypto");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const express = require("express");
const multer = require("multer");
const sharp = require("sharp");

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024
  }
});

const LEGACY_MAGIC = Buffer.from("DWE1");
const MAGIC = Buffer.from("DWE2");
const SALT_BYTES = 16;
const LEGACY_IV_BYTES = 12;
const LEGACY_TAG_BYTES = 16;
const PBKDF2_ITERATIONS = 150000;
const DEFAULT_ENCRYPTION_ALGORITHM = "aes-256-gcm";
const PYTHON_COMMAND = process.env.PYTHON_CMD || "py";
const PYTHON_BASE_ARGS = process.env.PYTHON_CMD ? [] : ["-3.12"];
const PYTHON_SCRIPT = path.join(__dirname, "python_tools", "invisible_watermark.py");
const ENCRYPTION_ALGORITHMS = {
  "aes-128-gcm": {
    id: 4,
    label: "AES-128-GCM",
    keyLength: 16,
    ivLength: 12,
    tagLength: 16,
    mode: "aead"
  },
  "aes-192-gcm": {
    id: 5,
    label: "AES-192-GCM",
    keyLength: 24,
    ivLength: 12,
    tagLength: 16,
    mode: "aead"
  },
  "aes-256-gcm": {
    id: 1,
    label: "AES-256-GCM",
    keyLength: 32,
    ivLength: 12,
    tagLength: 16,
    mode: "aead"
  },
  "chacha20-poly1305": {
    id: 2,
    label: "ChaCha20-Poly1305",
    keyLength: 32,
    ivLength: 12,
    tagLength: 16,
    mode: "aead"
  },
  "aes-256-cbc-hmac-sha256": {
    id: 3,
    label: "AES-256-CBC + HMAC-SHA256",
    keyLength: 64,
    ivLength: 16,
    tagLength: 32,
    mode: "cipher-hmac",
    cipherName: "aes-256-cbc"
  },
  "aes-256-ctr-hmac-sha256": {
    id: 6,
    label: "AES-256-CTR + HMAC-SHA256",
    keyLength: 64,
    ivLength: 16,
    tagLength: 32,
    mode: "cipher-hmac",
    cipherName: "aes-256-ctr"
  }
};
const ENCRYPTION_ALGORITHMS_BY_ID = new Map(
  Object.entries(ENCRYPTION_ALGORITHMS).map(([name, config]) => [config.id, { name, ...config }])
);
const SUPPORTED_WATERMARK_POSITIONS = new Set([
  "center",
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
  "diagonal-grid"
]);
const INVISIBLE_CHANNEL_MODES = new Set(["blue", "green", "red", "rgb"]);
const INVISIBLE_REPETITIONS = new Set([1, 3, 5]);
const FORMAT_TO_MIME = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
  tiff: "image/tiff",
  avif: "image/avif"
};
const STORAGE_ROOT = path.join(__dirname, "storage");
const LIBRARY_ROOT = path.join(STORAGE_ROOT, "library");
const LIBRARY_FILES_DIR = path.join(LIBRARY_ROOT, "files");
const LIBRARY_INDEX_FILE = path.join(LIBRARY_ROOT, "index.json");
const LIBRARY_CATEGORIES = new Set([
  "不可见水印",
  "可见水印",
  "文本加密",
  "文件加密",
  "综合实验",
  "其他"
]);

app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public")));

function createError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function requireText(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw createError(`${label}不能为空`);
  }

  return value.trim();
}

function optionalText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function ensureImageFile(file, message = "请先上传一张图片") {
  if (!file) {
    throw createError(message);
  }

  if (!file.mimetype.startsWith("image/")) {
    throw createError("仅支持图片类型的文件");
  }
}

function sanitizeFilename(name, fallback = "download.bin") {
  const safe = String(name || "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .trim();

  return safe || fallback;
}

function buildContentDisposition(filename) {
  const safeName = sanitizeFilename(filename);
  const asciiFallback = safeName.replace(/[^\x20-\x7e]/g, "_");

  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(safeName)}`;
}

function buildInlineContentDisposition(filename) {
  const safeName = sanitizeFilename(filename);
  const asciiFallback = safeName.replace(/[^\x20-\x7e]/g, "_");

  return `inline; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(safeName)}`;
}

function optionalTextLimit(value, maxLength = 160) {
  return optionalText(value).slice(0, maxLength);
}

function normalizeLibraryCategory(value) {
  const category = optionalText(value) || "综合实验";
  return LIBRARY_CATEGORIES.has(category) ? category : "其他";
}

function normalizeLibraryTags(value) {
  const raw = optionalText(value);

  if (!raw) {
    return [];
  }

  return [...new Set(raw.split(/[,\n，]/).map((item) => item.trim()).filter(Boolean))].slice(0, 8);
}

function isImageMimeType(mimeType) {
  return typeof mimeType === "string" && mimeType.startsWith("image/");
}

function buildLibraryFileUrl(id, suffix) {
  return `/api/library/works/${encodeURIComponent(id)}/${suffix}`;
}

function serializeLibraryWork(record) {
  return {
    id: record.id,
    title: record.title,
    creator: record.creator,
    category: record.category,
    description: record.description,
    tags: Array.isArray(record.tags) ? record.tags : [],
    originalName: record.originalName,
    mimeType: record.mimeType,
    size: record.size,
    createdAt: record.createdAt,
    isImage: isImageMimeType(record.mimeType),
    contentUrl: buildLibraryFileUrl(record.id, "content"),
    downloadUrl: buildLibraryFileUrl(record.id, "download")
  };
}

function summarizeLibrary(records) {
  const totalSize = records.reduce((sum, record) => sum + (Number(record.size) || 0), 0);
  const imageWorks = records.filter((record) => isImageMimeType(record.mimeType)).length;

  return {
    totalWorks: records.length,
    imageWorks,
    fileWorks: Math.max(records.length - imageWorks, 0),
    totalSize
  };
}

async function ensureLibraryStorage() {
  await fs.mkdir(LIBRARY_FILES_DIR, { recursive: true });

  try {
    await fs.access(LIBRARY_INDEX_FILE);
  } catch (error) {
    await fs.writeFile(LIBRARY_INDEX_FILE, "[]", "utf8");
  }
}

async function readLibraryRecords() {
  await ensureLibraryStorage();

  let raw;

  try {
    raw = await fs.readFile(LIBRARY_INDEX_FILE, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }

    throw createError("作品库索引读取失败", 500);
  }

  try {
    const records = JSON.parse(raw || "[]");

    if (!Array.isArray(records)) {
      throw new Error("Library index must be an array.");
    }

    return records;
  } catch (error) {
    throw createError("作品库索引文件损坏，无法解析", 500);
  }
}

async function writeLibraryRecords(records) {
  await ensureLibraryStorage();
  await fs.writeFile(LIBRARY_INDEX_FILE, JSON.stringify(records, null, 2), "utf8");
}

async function loadLibraryWork(id) {
  const records = await readLibraryRecords();
  const record = records.find((item) => item.id === id);

  if (!record) {
    throw createError("未找到对应作品", 404);
  }

  return { record, records };
}

async function readLibraryFileBuffer(record) {
  const filePath = path.join(LIBRARY_FILES_DIR, record.storedName);

  try {
    return await fs.readFile(filePath);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw createError("作品原文件不存在或已被移除", 404);
    }

    throw createError("作品文件读取失败", 500);
  }
}

function deriveKey(password, salt, keyLength) {
  return crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, keyLength, "sha256");
}

function getEncryptionKdfLabel() {
  return `PBKDF2-SHA256 x ${PBKDF2_ITERATIONS}`;
}

function normalizeEncryptionAlgorithm(value) {
  const name = optionalText(value).toLowerCase() || DEFAULT_ENCRYPTION_ALGORITHM;

  if (!Object.hasOwn(ENCRYPTION_ALGORITHMS, name)) {
    throw createError("不支持所选的加密算法");
  }

  return name;
}

function getEncryptionConfig(value) {
  const name = normalizeEncryptionAlgorithm(value);
  return {
    name,
    ...ENCRYPTION_ALGORITHMS[name]
  };
}

function buildEncryptionPrefix(config) {
  return Buffer.concat([MAGIC, Buffer.from([config.id, SALT_BYTES, config.ivLength, config.tagLength])]);
}

function createEncryptionHmac(macKey, prefix, salt, iv, encrypted) {
  return crypto
    .createHmac("sha256", macKey)
    .update(prefix)
    .update(salt)
    .update(iv)
    .update(encrypted)
    .digest();
}

function encryptBuffer(plainBuffer, password, algorithmName = DEFAULT_ENCRYPTION_ALGORITHM) {
  const config = getEncryptionConfig(algorithmName);
  const prefix = buildEncryptionPrefix(config);
  const salt = crypto.randomBytes(SALT_BYTES);
  const iv = crypto.randomBytes(config.ivLength);
  const keyMaterial = deriveKey(password, salt, config.keyLength);
  let encrypted;
  let tag;

  if (config.mode === "aead") {
    const options = config.name === "chacha20-poly1305" ? { authTagLength: config.tagLength } : undefined;
    const cipher = crypto.createCipheriv(config.name, keyMaterial, iv, options);

    if (typeof cipher.setAAD === "function") {
      cipher.setAAD(prefix);
    }

    encrypted = Buffer.concat([cipher.update(plainBuffer), cipher.final()]);
    tag = cipher.getAuthTag();
  } else {
    const encryptionKey = keyMaterial.subarray(0, 32);
    const macKey = keyMaterial.subarray(32);
    const cipher = crypto.createCipheriv(config.cipherName, encryptionKey, iv);

    encrypted = Buffer.concat([cipher.update(plainBuffer), cipher.final()]);
    tag = createEncryptionHmac(macKey, prefix, salt, iv, encrypted);
  }

  return {
    buffer: Buffer.concat([prefix, salt, iv, tag, encrypted]),
    algorithmName: config.name,
    algorithmLabel: config.label,
    kdf: getEncryptionKdfLabel()
  };
}

function decryptLegacyBuffer(packetBuffer, password) {
  const minLength = LEGACY_MAGIC.length + SALT_BYTES + LEGACY_IV_BYTES + LEGACY_TAG_BYTES;

  if (packetBuffer.length <= minLength) {
    throw createError("密文格式不正确");
  }

  const saltStart = LEGACY_MAGIC.length;
  const ivStart = saltStart + SALT_BYTES;
  const tagStart = ivStart + LEGACY_IV_BYTES;
  const dataStart = tagStart + LEGACY_TAG_BYTES;
  const salt = packetBuffer.subarray(saltStart, ivStart);
  const iv = packetBuffer.subarray(ivStart, tagStart);
  const tag = packetBuffer.subarray(tagStart, dataStart);
  const encrypted = packetBuffer.subarray(dataStart);
  const key = deriveKey(password, salt, 32);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);

  decipher.setAuthTag(tag);

  try {
    return {
      buffer: Buffer.concat([decipher.update(encrypted), decipher.final()]),
      algorithmName: "aes-256-gcm",
      algorithmLabel: "AES-256-GCM",
      kdf: getEncryptionKdfLabel()
    };
  } catch (error) {
    throw createError("密码错误或密文已损坏");
  }
}

function decryptBuffer(packetBuffer, password) {
  if (!Buffer.isBuffer(packetBuffer) || packetBuffer.length <= MAGIC.length + 4) {
    throw createError("密文格式不正确");
  }

  if (packetBuffer.subarray(0, LEGACY_MAGIC.length).equals(LEGACY_MAGIC)) {
    return decryptLegacyBuffer(packetBuffer, password);
  }

  if (!packetBuffer.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw createError("文件签名不匹配，无法识别");
  }

  const algorithmId = packetBuffer[MAGIC.length];
  const saltLength = packetBuffer[MAGIC.length + 1];
  const ivLength = packetBuffer[MAGIC.length + 2];
  const tagLength = packetBuffer[MAGIC.length + 3];
  const config = ENCRYPTION_ALGORITHMS_BY_ID.get(algorithmId);

  if (!config) {
    throw createError("当前密文使用了未知的加密算法");
  }

  if (saltLength !== SALT_BYTES || ivLength !== config.ivLength || tagLength !== config.tagLength) {
    throw createError("密文头信息与加密算法不匹配");
  }

  const saltStart = MAGIC.length + 4;
  const ivStart = saltStart + saltLength;
  const tagStart = ivStart + ivLength;
  const dataStart = tagStart + tagLength;

  if (packetBuffer.length <= dataStart) {
    throw createError("密文数据不完整");
  }

  const prefix = packetBuffer.subarray(0, MAGIC.length + 4);
  const salt = packetBuffer.subarray(saltStart, ivStart);
  const iv = packetBuffer.subarray(ivStart, tagStart);
  const tag = packetBuffer.subarray(tagStart, dataStart);
  const encrypted = packetBuffer.subarray(dataStart);
  const keyMaterial = deriveKey(password, salt, config.keyLength);

  if (config.mode === "aead") {
    const options = config.name === "chacha20-poly1305" ? { authTagLength: config.tagLength } : undefined;
    const decipher = crypto.createDecipheriv(config.name, keyMaterial, iv, options);

    if (typeof decipher.setAAD === "function") {
      decipher.setAAD(prefix);
    }

    decipher.setAuthTag(tag);

    try {
      return {
        buffer: Buffer.concat([decipher.update(encrypted), decipher.final()]),
        algorithmName: config.name,
        algorithmLabel: config.label,
        kdf: getEncryptionKdfLabel()
      };
    } catch (error) {
      throw createError("密码错误或密文已损坏");
    }
  }

  const encryptionKey = keyMaterial.subarray(0, 32);
  const macKey = keyMaterial.subarray(32);
  const expectedTag = createEncryptionHmac(macKey, prefix, salt, iv, encrypted);

  if (expectedTag.length !== tag.length || !crypto.timingSafeEqual(expectedTag, tag)) {
    throw createError("密码错误或密文已损坏");
  }

  try {
    const decipher = crypto.createDecipheriv(config.cipherName, encryptionKey, iv);

    return {
      buffer: Buffer.concat([decipher.update(encrypted), decipher.final()]),
      algorithmName: config.name,
      algorithmLabel: config.label,
      kdf: getEncryptionKdfLabel()
    };
  } catch (error) {
    throw createError("密码错误或密文已损坏");
  }
}

function applyEncryptionHeaders(res, encryptionInfo) {
  if (!encryptionInfo) {
    return;
  }

  res.setHeader("X-Encryption-Algorithm", encryptionInfo.algorithmLabel);
  res.setHeader("X-Encryption-Algorithm-Id", encryptionInfo.algorithmName);
  res.setHeader("X-Encryption-KDF", encryptionInfo.kdf);
}

function packFilePayload(file) {
  const metadataBuffer = Buffer.from(
    JSON.stringify({
      filename: sanitizeFilename(file.originalname, "file.bin"),
      mimeType: file.mimetype || "application/octet-stream"
    }),
    "utf8"
  );
  const metadataLengthBuffer = Buffer.alloc(4);

  metadataLengthBuffer.writeUInt32BE(metadataBuffer.length, 0);

  return Buffer.concat([metadataLengthBuffer, metadataBuffer, file.buffer]);
}

function unpackFilePayload(buffer) {
  if (buffer.length < 4) {
    throw createError("解密后的数据不完整");
  }

  const metadataLength = buffer.readUInt32BE(0);

  if (metadataLength <= 0 || 4 + metadataLength > buffer.length) {
    throw createError("解密后的文件头不合法");
  }

  let metadata;

  try {
    metadata = JSON.parse(buffer.subarray(4, 4 + metadataLength).toString("utf8"));
  } catch (error) {
    throw createError("解密后的文件元数据无法识别");
  }

  return {
    metadata,
    content: buffer.subarray(4 + metadataLength)
  };
}

function escapeXml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildWatermarkSvg({ width, height, text, color, opacity, fontSize, position, rotation }) {
  const safeText = escapeXml(text);
  const commonAttributes = `fill="${color}" fill-opacity="${opacity}" font-size="${fontSize}" font-family="Noto Sans SC, Segoe UI, sans-serif" font-weight="700" letter-spacing="1.5"`;

  if (position === "diagonal-grid") {
    const stepX = Math.max(fontSize * 4.8, width / 3);
    const stepY = Math.max(fontSize * 3.8, height / 3);
    const textNodes = [];

    for (let y = -height; y <= height * 2; y += stepY) {
      for (let x = -width; x <= width * 2; x += stepX) {
        textNodes.push(
          `<text x="${x}" y="${y}" ${commonAttributes} text-anchor="middle" dominant-baseline="middle">${safeText}</text>`
        );
      }
    }

    return `
      <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
        <rect width="100%" height="100%" fill="transparent" />
        <g transform="rotate(${rotation} ${width / 2} ${height / 2})">
          ${textNodes.join("")}
        </g>
      </svg>
    `;
  }

  const margin = Math.max(fontSize, 32);
  const positions = {
    center: {
      x: width / 2,
      y: height / 2,
      anchor: "middle"
    },
    "top-left": {
      x: margin,
      y: margin,
      anchor: "start"
    },
    "top-right": {
      x: width - margin,
      y: margin,
      anchor: "end"
    },
    "bottom-left": {
      x: margin,
      y: height - margin,
      anchor: "start"
    },
    "bottom-right": {
      x: width - margin,
      y: height - margin,
      anchor: "end"
    }
  };
  const selected = positions[position] || positions.center;

  return `
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="transparent" />
      <g transform="rotate(${rotation} ${selected.x} ${selected.y})">
        <text
          x="${selected.x}"
          y="${selected.y}"
          ${commonAttributes}
          text-anchor="${selected.anchor}"
          dominant-baseline="middle"
        >${safeText}</text>
      </g>
    </svg>
  `;
}

function resolveOutputFormat(format) {
  const normalized = format === "jpg" ? "jpeg" : format;

  return Object.hasOwn(FORMAT_TO_MIME, normalized) ? normalized : "png";
}

function applyOutputFormat(imagePipeline, format) {
  switch (format) {
    case "jpeg":
      return imagePipeline.jpeg({ quality: 92 });
    case "webp":
      return imagePipeline.webp({ quality: 92 });
    case "tiff":
      return imagePipeline.tiff({ quality: 92 });
    case "avif":
      return imagePipeline.avif({ quality: 55 });
    default:
      return imagePipeline.png();
  }
}

function normalizeInvisibleChannelMode(value) {
  const mode = optionalText(value).toLowerCase() || "rgb";

  if (!INVISIBLE_CHANNEL_MODES.has(mode)) {
    throw createError("不可见水印通道模式不合法");
  }

  return mode;
}

function normalizeInvisibleRepetition(value) {
  const repetition = Number(value) || 3;

  if (!INVISIBLE_REPETITIONS.has(repetition)) {
    throw createError("不可见水印鲁棒模式不合法");
  }

  return repetition;
}

function estimateUtf8Chars(capacityBytes) {
  return Math.floor(capacityBytes / 3);
}

function buildInvisiblePayloadBuffer(formBody) {
  const watermarkText = requireText(formBody.watermarkText, "隐形水印内容");
  const password = optionalText(formBody.password);
  const algorithmName = normalizeEncryptionAlgorithm(formBody.algorithm);
  const metadata = {
    watermarkText,
    author: optionalText(formBody.author),
    owner: optionalText(formBody.owner),
    note: optionalText(formBody.note),
    createdAt: new Date().toISOString()
  };

  if (password) {
    const encryptedPacket = encryptBuffer(Buffer.from(JSON.stringify(metadata), "utf8"), password, algorithmName);

    return Buffer.from(
      JSON.stringify({
        version: 1,
        encrypted: true,
        algorithm: encryptedPacket.algorithmLabel,
        algorithmId: encryptedPacket.algorithmName,
        kdf: encryptedPacket.kdf,
        payload: encryptedPacket.buffer.toString("base64")
      }),
      "utf8"
    );
  }

  return Buffer.from(
    JSON.stringify({
      version: 1,
      encrypted: false,
      payload: metadata
    }),
    "utf8"
  );
}

function decodeInvisiblePayloadBuffer(buffer, password) {
  let packet;

  try {
    packet = JSON.parse(buffer.toString("utf8"));
  } catch (error) {
    throw createError("提取到的数据不是本站生成的水印格式");
  }

  if (!packet || packet.version !== 1) {
    throw createError("提取到的数据版本不兼容");
  }

  if (!packet.encrypted) {
    return {
      encrypted: false,
      requiresPassword: false,
      data: packet.payload
    };
  }

  if (!password) {
    return {
      encrypted: true,
      requiresPassword: true,
      algorithm: packet.algorithm,
      algorithmId: packet.algorithmId,
      kdf: packet.kdf
    };
  }

  if (typeof packet.payload !== "string" || !packet.payload.trim()) {
    throw createError("水印密文内容不完整");
  }

  let encryptedBuffer;

  try {
    encryptedBuffer = Buffer.from(packet.payload, "base64");
  } catch (error) {
    throw createError("水印密文内容损坏");
  }

  const decryptedPacket = decryptBuffer(encryptedBuffer, password);

  try {
    return {
      encrypted: true,
      requiresPassword: false,
      algorithm: packet.algorithm || decryptedPacket.algorithmLabel,
      algorithmId: packet.algorithmId || decryptedPacket.algorithmName,
      kdf: packet.kdf || decryptedPacket.kdf,
      data: JSON.parse(decryptedPacket.buffer.toString("utf8"))
    };
  } catch (error) {
    throw createError("水印解密成功，但内容结构无法识别");
  }
}

async function withTempWorkspace(handler) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "iwm-"));

  try {
    return await handler(workspace);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
}

function resolveOriginalExtension(file) {
  const extension = path.extname(file.originalname || "").toLowerCase();
  return extension || ".bin";
}

function runPythonWatermark(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON_COMMAND, [...PYTHON_BASE_ARGS, PYTHON_SCRIPT, ...args], {
      cwd: __dirname
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (error.code === "ENOENT") {
        reject(createError("未找到可用的 Python 运行环境，请安装 Python 3.12 或设置 PYTHON_CMD", 500));
        return;
      }

      reject(createError(`Python 水印进程启动失败：${error.message}`, 500));
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(createError(stderr.trim() || "Python 不可见水印处理失败", 400));
        return;
      }

      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(createError("Python 返回结果无法解析", 500));
      }
    });
  });
}

async function callInvisibleWatermarkCapacity(file, channelMode, repetition) {
  return withTempWorkspace(async (workspace) => {
    const inputPath = path.join(workspace, `carrier${resolveOriginalExtension(file)}`);

    await fs.writeFile(inputPath, file.buffer);

    return runPythonWatermark([
      "capacity",
      "--input",
      inputPath,
      "--channel-mode",
      channelMode,
      "--repetition",
      String(repetition)
    ]);
  });
}

async function callInvisibleWatermarkEmbed(file, payloadBuffer, channelMode, repetition) {
  return withTempWorkspace(async (workspace) => {
    const inputPath = path.join(workspace, `carrier${resolveOriginalExtension(file)}`);
    const payloadPath = path.join(workspace, "payload.bin");
    const outputPath = path.join(workspace, "watermarked.png");

    await fs.writeFile(inputPath, file.buffer);
    await fs.writeFile(payloadPath, payloadBuffer);

    const metrics = await runPythonWatermark([
      "embed",
      "--input",
      inputPath,
      "--output",
      outputPath,
      "--payload",
      payloadPath,
      "--channel-mode",
      channelMode,
      "--repetition",
      String(repetition)
    ]);
    const outputBuffer = await fs.readFile(outputPath);

    return {
      metrics,
      outputBuffer
    };
  });
}

async function callInvisibleWatermarkExtract(file) {
  return withTempWorkspace(async (workspace) => {
    const inputPath = path.join(workspace, `carrier${resolveOriginalExtension(file)}`);

    await fs.writeFile(inputPath, file.buffer);

    return runPythonWatermark([
      "extract",
      "--input",
      inputPath
    ]);
  });
}

function applyInvisibleWatermarkHeaders(res, metrics) {
  res.setHeader("X-IWM-Width", String(metrics.width || ""));
  res.setHeader("X-IWM-Height", String(metrics.height || ""));
  res.setHeader("X-IWM-Channel-Mode", String(metrics.channelMode || ""));
  res.setHeader("X-IWM-Repetition", String(metrics.repetition || ""));
  res.setHeader("X-IWM-Payload-Bytes", String(metrics.payloadBytes || ""));
  res.setHeader("X-IWM-Capacity-Bytes", String(metrics.capacityBytes || ""));
  res.setHeader("X-IWM-Utilization", String(metrics.utilization || ""));
  res.setHeader("X-IWM-Modified-Values", String(metrics.modifiedValues || ""));
  res.setHeader("X-IWM-PSNR", metrics.psnr == null ? "" : String(metrics.psnr));
}

app.post("/api/invisible-watermark/capacity", upload.single("image"), async (req, res, next) => {
  try {
    ensureImageFile(req.file, "请先上传载体图片");

    const channelMode = normalizeInvisibleChannelMode(req.body.channelMode);
    const repetition = normalizeInvisibleRepetition(req.body.repetition);
    const payloadBuffer = buildInvisiblePayloadBuffer(req.body);
    const capacityInfo = await callInvisibleWatermarkCapacity(req.file, channelMode, repetition);
    const fits = payloadBuffer.length <= capacityInfo.capacityBytes;

    res.json({
      ...capacityInfo,
      payloadBytes: payloadBuffer.length,
      fits,
      remainingBytes: capacityInfo.capacityBytes - payloadBuffer.length,
      approxSafeChars: estimateUtf8Chars(capacityInfo.capacityBytes)
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/invisible-watermark/embed", upload.single("image"), async (req, res, next) => {
  try {
    ensureImageFile(req.file, "请先上传载体图片");

    const channelMode = normalizeInvisibleChannelMode(req.body.channelMode);
    const repetition = normalizeInvisibleRepetition(req.body.repetition);
    const payloadBuffer = buildInvisiblePayloadBuffer(req.body);
    const { metrics, outputBuffer } = await callInvisibleWatermarkEmbed(
      req.file,
      payloadBuffer,
      channelMode,
      repetition
    );
    const baseName = sanitizeFilename(path.parse(req.file.originalname).name, "carrier");

    applyInvisibleWatermarkHeaders(res, metrics);
    res.setHeader("Content-Disposition", buildContentDisposition(`${baseName}-invisible-watermark.png`));
    res.type("image/png");
    res.send(outputBuffer);
  } catch (error) {
    next(error);
  }
});

app.post("/api/invisible-watermark/extract", upload.single("image"), async (req, res, next) => {
  try {
    ensureImageFile(req.file, "请先上传带水印的图片");

    const extracted = await callInvisibleWatermarkExtract(req.file);
    const decoded = decodeInvisiblePayloadBuffer(
      Buffer.from(extracted.payloadBase64, "base64"),
      optionalText(req.body.password)
    );

    res.json({
      ...extracted,
      ...decoded,
      storageAdvice: "请尽量使用本站导出的 PNG 原图进行提取，重新压缩、截图、裁剪后可能导致不可见水印损坏。"
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/visible-watermark", upload.single("image"), async (req, res, next) => {
  try {
    ensureImageFile(req.file);

    const text = requireText(req.body.text, "可见水印文字");
    const opacity = clamp(Number(req.body.opacity) || 0.3, 0.05, 1);
    const sizePercent = clamp(Number(req.body.sizePercent) || 8, 2, 25);
    const rotation = clamp(Number(req.body.rotation) || -20, -90, 90);
    const color = optionalText(req.body.color) || "#ffffff";
    const position = SUPPORTED_WATERMARK_POSITIONS.has(req.body.position) ? req.body.position : "diagonal-grid";

    const image = sharp(req.file.buffer);
    const metadata = await image.metadata();
    const width = metadata.width || 1200;
    const height = metadata.height || 800;
    const fontSize = Math.max(16, Math.round(Math.min(width, height) * (sizePercent / 100)));
    const svg = buildWatermarkSvg({
      width,
      height,
      text,
      color,
      opacity,
      fontSize,
      position,
      rotation
    });
    const format = resolveOutputFormat(metadata.format);
    const result = await applyOutputFormat(
      image.composite([{ input: Buffer.from(svg), left: 0, top: 0 }]),
      format
    ).toBuffer();
    const baseName = sanitizeFilename(path.parse(req.file.originalname).name, "image");
    const extension = format === "jpeg" ? "jpg" : format;

    res.setHeader("Content-Disposition", buildContentDisposition(`${baseName}-visible-watermark.${extension}`));
    res.type(FORMAT_TO_MIME[format]);
    res.send(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/text/encrypt", (req, res, next) => {
  try {
    const text = requireText(req.body.text, "明文内容");
    const password = requireText(req.body.password, "密码");
    const algorithmName = normalizeEncryptionAlgorithm(req.body.algorithm);
    const encryptedPacket = encryptBuffer(Buffer.from(text, "utf8"), password, algorithmName);

    res.json({
      payload: encryptedPacket.buffer.toString("base64"),
      algorithm: encryptedPacket.algorithmLabel,
      algorithmId: encryptedPacket.algorithmName,
      kdf: encryptedPacket.kdf
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/text/decrypt", (req, res, next) => {
  try {
    const payload = requireText(req.body.payload, "密文内容").replace(/\s+/g, "");
    const password = requireText(req.body.password, "密码");

    let encryptedBuffer;

    try {
      encryptedBuffer = Buffer.from(payload, "base64");
    } catch (error) {
      throw createError("密文必须是合法的 Base64 文本");
    }

    if (!encryptedBuffer.length) {
      throw createError("密文必须是合法的 Base64 文本");
    }

    const decryptedPacket = decryptBuffer(encryptedBuffer, password);

    res.json({
      text: decryptedPacket.buffer.toString("utf8"),
      algorithm: decryptedPacket.algorithmLabel,
      algorithmId: decryptedPacket.algorithmName,
      kdf: decryptedPacket.kdf
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/files/encrypt", upload.single("file"), (req, res, next) => {
  try {
    if (!req.file) {
      throw createError("请先上传待加密文件");
    }

    const password = requireText(req.body.password, "密码");
    const algorithmName = normalizeEncryptionAlgorithm(req.body.algorithm);
    const encryptedPacket = encryptBuffer(packFilePayload(req.file), password, algorithmName);
    const baseName = sanitizeFilename(path.parse(req.file.originalname).name, "file");

    applyEncryptionHeaders(res, encryptedPacket);
    res.setHeader("Content-Disposition", buildContentDisposition(`${baseName}.dwe`));
    res.type("application/octet-stream");
    res.send(encryptedPacket.buffer);
  } catch (error) {
    next(error);
  }
});

app.post("/api/files/decrypt", upload.single("file"), (req, res, next) => {
  try {
    if (!req.file) {
      throw createError("请先上传已加密文件");
    }

    const password = requireText(req.body.password, "密码");
    const decryptedPacket = decryptBuffer(req.file.buffer, password);
    const { metadata, content } = unpackFilePayload(decryptedPacket.buffer);
    const filename = sanitizeFilename(metadata.filename, "decrypted.bin");

    applyEncryptionHeaders(res, decryptedPacket);
    res.setHeader("Content-Disposition", buildContentDisposition(filename));
    res.type(metadata.mimeType || "application/octet-stream");
    res.send(content);
  } catch (error) {
    next(error);
  }
});

app.get("/api/library/works", async (req, res, next) => {
  try {
    const records = await readLibraryRecords();
    const items = [...records]
      .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
      .map(serializeLibraryWork);

    res.json({
      items,
      summary: summarizeLibrary(records)
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/library/works", upload.single("file"), async (req, res, next) => {
  try {
    if (!req.file) {
      throw createError("请先上传作品文件");
    }

    const records = await readLibraryRecords();
    const now = new Date().toISOString();
    const safeOriginalName = sanitizeFilename(req.file.originalname, "work.bin");
    const extension = path.extname(safeOriginalName).slice(0, 16);
    const fileId = crypto.randomUUID();
    const storedName = `${fileId}${extension}`;
    const nextRecords = [
      {
        id: fileId,
        title: optionalTextLimit(req.body.title, 80) || path.parse(safeOriginalName).name || "未命名作品",
        creator: optionalTextLimit(req.body.creator, 60) || "未署名",
        category: normalizeLibraryCategory(req.body.category),
        description: optionalTextLimit(req.body.description, 500),
        tags: normalizeLibraryTags(req.body.tags),
        originalName: safeOriginalName,
        storedName,
        mimeType: req.file.mimetype || "application/octet-stream",
        size: req.file.size || req.file.buffer.length,
        createdAt: now
      },
      ...records
    ];

    await ensureLibraryStorage();
    await fs.writeFile(path.join(LIBRARY_FILES_DIR, storedName), req.file.buffer);
    await writeLibraryRecords(nextRecords);

    res.status(201).json({
      item: serializeLibraryWork(nextRecords[0]),
      summary: summarizeLibrary(nextRecords)
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/library/works/:id/content", async (req, res, next) => {
  try {
    const { record } = await loadLibraryWork(req.params.id);
    const fileBuffer = await readLibraryFileBuffer(record);

    res.setHeader("Content-Disposition", buildInlineContentDisposition(record.originalName));
    res.type(record.mimeType || "application/octet-stream");
    res.send(fileBuffer);
  } catch (error) {
    next(error);
  }
});

app.get("/api/library/works/:id/download", async (req, res, next) => {
  try {
    const { record } = await loadLibraryWork(req.params.id);
    const fileBuffer = await readLibraryFileBuffer(record);

    res.setHeader("Content-Disposition", buildContentDisposition(record.originalName));
    res.type(record.mimeType || "application/octet-stream");
    res.send(fileBuffer);
  } catch (error) {
    next(error);
  }
});

app.delete("/api/library/works/:id", async (req, res, next) => {
  try {
    const { record, records } = await loadLibraryWork(req.params.id);
    const nextRecords = records.filter((item) => item.id !== record.id);

    await fs.rm(path.join(LIBRARY_FILES_DIR, record.storedName), { force: true });
    await writeLibraryRecords(nextRecords);

    res.json({
      ok: true,
      removedId: record.id,
      summary: summarizeLibrary(nextRecords)
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    pythonCommand: process.env.PYTHON_CMD || "py -3.12",
    invisibleWatermark: "available",
    libraryStorage: "filesystem",
    supportedEncryptionAlgorithms: Object.entries(ENCRYPTION_ALGORITHMS).map(([id, config]) => ({
      id,
      label: config.label
    }))
  });
});

app.use((req, res) => {
  res.status(404).json({ error: "未找到对应接口" });
});

app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    const message =
      error.code === "LIMIT_FILE_SIZE" ? "上传文件不能超过 20MB" : "文件上传失败，请检查后重试";

    res.status(400).json({ error: message });
    return;
  }

  const status = error.status || 500;

  if (status >= 500) {
    console.error(error);
  }

  res.status(status).json({
    error: status >= 500 ? "服务器内部错误，请稍后重试" : error.message
  });
});

app.listen(PORT, () => {
  console.log(`Digital watermark site is running at http://localhost:${PORT}`);
});
