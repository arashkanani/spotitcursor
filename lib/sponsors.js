const path = require("path");
const fs = require("fs");
const { DATA_DIR } = require("./config");

const SPONSORS_DIR = path.join(DATA_DIR, "sponsors");
const INDEX_PATH = path.join(DATA_DIR, "sponsors-index.json");
const LEGACY_SHAPES_DIR = process.env.LEGACY_SHAPES_DIR
  ? path.resolve(process.env.LEGACY_SHAPES_DIR)
  : "";
const MIN_SHAPES_PER_SPONSOR = 19;
const MAX_SPONSOR_NAME_LENGTH = 60;
const MAX_SHAPES_PER_UPLOAD = 60;

const FALLBACK_SHAPES = [
  "circle", "square", "triangle", "star", "heart",
  "diamond", "moon", "sun", "cloud", "bolt",
  "hexagon", "cross", "drop", "leaf", "fish",
  "apple", "key", "bell", "flag", "gift"
];

function ensureDataDirs() {
  fs.mkdirSync(SPONSORS_DIR, { recursive: true });
  if (!fs.existsSync(INDEX_PATH)) {
    writeIndex({ sponsors: [], activeSponsorId: null });
  }
}

function readIndex() {
  ensureDataDirs();
  try {
    return JSON.parse(fs.readFileSync(INDEX_PATH, "utf8"));
  } catch (_error) {
    return { sponsors: [], activeSponsorId: null };
  }
}

function writeIndex(index) {
  ensureDataDirs();
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2), "utf8");
}

function slugify(name) {
  return String(name || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "sponsor";
}

function uniqueSponsorId(name) {
  const index = readIndex();
  const base = slugify(name).slice(0, 40) || "sponsor";
  if (!index.sponsors.some((s) => s.id === base)) return base;
  let n = 2;
  while (index.sponsors.some((s) => s.id === `${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

function getSponsorShapesDir(sponsorId) {
  return path.join(SPONSORS_DIR, sponsorId, "shapes");
}

function countShapes(sponsorId) {
  const dir = getSponsorShapesDir(sponsorId);
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".png")).length;
}

function shapeFileUrl(sponsorId, filename) {
  return `/sponsor-shapes/${encodeURIComponent(sponsorId)}/shapes/${encodeURIComponent(filename)}`;
}

function getShapeEntries(sponsorId) {
  const dir = getSponsorShapesDir(sponsorId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".png"))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((filename) => ({
      filename,
      url: shapeFileUrl(sponsorId, filename)
    }));
}

function getShapeUrls(sponsorId) {
  return getShapeEntries(sponsorId).map((entry) => entry.url);
}

function deleteShape(sponsorId, filename) {
  const sponsor = getSponsorById(sponsorId);
  if (!sponsor) {
    throw new Error("Sponsor not found.");
  }

  const safeName = path.basename(String(filename || ""));
  if (!/^shape-\d+\.png$/i.test(safeName)) {
    throw new Error("Invalid shape file.");
  }

  const filePath = path.join(getSponsorShapesDir(sponsorId), safeName);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    const index = readIndex();
    const entry = index.sponsors.find((s) => s.id === sponsorId);
    if (entry) {
      entry.updatedAt = new Date().toISOString();
      writeIndex(index);
    }
  }

  return getSponsorById(sponsorId);
}

function getSponsorById(sponsorId) {
  const index = readIndex();
  const sponsor = index.sponsors.find((s) => s.id === sponsorId);
  if (!sponsor) return null;
  const shapeEntries = getShapeEntries(sponsorId);
  return {
    ...sponsor,
    shapeCount: shapeEntries.length,
    shapes: shapeEntries.map((entry) => entry.url),
    shapeEntries
  };
}

function listSponsors() {
  const index = readIndex();
  return index.sponsors
    .map((sponsor) => {
      const shapeUrls = getShapeUrls(sponsor.id);
      return {
        ...sponsor,
        shapeCount: shapeUrls.length,
        previewShapes: shapeUrls.slice(0, 4),
        ready: shapeUrls.length >= MIN_SHAPES_PER_SPONSOR
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function getActiveSponsorId() {
  return readIndex().activeSponsorId || null;
}

function setActiveSponsorId(sponsorId) {
  const index = readIndex();
  if (!index.sponsors.some((s) => s.id === sponsorId)) {
    throw new Error("Sponsor not found.");
  }
  index.activeSponsorId = sponsorId;
  writeIndex(index);
  return getSponsorById(sponsorId);
}

function createSponsor(name) {
  const trimmed = String(name || "").trim().slice(0, MAX_SPONSOR_NAME_LENGTH);
  if (!trimmed) {
    throw new Error("Sponsor name is required.");
  }

  const index = readIndex();
  const id = uniqueSponsorId(trimmed);
  const now = new Date().toISOString();
  const sponsor = { id, name: trimmed, createdAt: now, updatedAt: now };

  index.sponsors.push(sponsor);
  writeIndex(index);
  fs.mkdirSync(getSponsorShapesDir(id), { recursive: true });
  return getSponsorById(id);
}

function nextShapeFilename(sponsorId) {
  const dir = getSponsorShapesDir(sponsorId);
  fs.mkdirSync(dir, { recursive: true });
  const existing = fs
    .readdirSync(dir)
    .filter((f) => /^shape-\d+\.png$/i.test(f))
    .map((f) => Number(f.match(/\d+/)[0]));
  const next = existing.length ? Math.max(...existing) + 1 : 1;
  return `shape-${String(next).padStart(3, "0")}.png`;
}

function addShapeFiles(sponsorId, files) {
  const sponsor = getSponsorById(sponsorId);
  if (!sponsor) {
    throw new Error("Sponsor not found.");
  }

  const saved = [];
  for (const file of files) {
    if (!file || !file.buffer || !file.buffer.length) continue;
    const filename = nextShapeFilename(sponsorId);
    const dest = path.join(getSponsorShapesDir(sponsorId), filename);
    fs.writeFileSync(dest, file.buffer);
    saved.push(filename);
  }

  if (saved.length) {
    const index = readIndex();
    const entry = index.sponsors.find((s) => s.id === sponsorId);
    if (entry) {
      entry.updatedAt = new Date().toISOString();
      writeIndex(index);
    }
  }

  return getSponsorById(sponsorId);
}

function getShapePool(sponsorId) {
  const id = sponsorId || getActiveSponsorId();
  if (!id) return FALLBACK_SHAPES;
  const urls = getShapeUrls(id);
  return urls.length >= MIN_SHAPES_PER_SPONSOR ? urls : FALLBACK_SHAPES;
}

function loadLegacyShapeFiles() {
  if (!LEGACY_SHAPES_DIR || !fs.existsSync(LEGACY_SHAPES_DIR)) return [];

  const allFiles = fs
    .readdirSync(LEGACY_SHAPES_DIR)
    .filter((file) => file.toLowerCase().endsWith(".png"));
  const byNumber = new Map();

  for (const file of allFiles) {
    const match = file.match(/_images_(\d+)-/i);
    if (!match) continue;
    const imageNumber = Number(match[1]);
    const fullPath = path.join(LEGACY_SHAPES_DIR, file);
    const mtimeMs = fs.statSync(fullPath).mtimeMs;
    const existing = byNumber.get(imageNumber);
    if (!existing || mtimeMs > existing.mtimeMs) {
      byNumber.set(imageNumber, { file, fullPath, mtimeMs });
    }
  }

  return [...byNumber.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, value]) => value.fullPath);
}

function migrateLegacyShapesToIkea() {
  const index = readIndex();
  if (index.sponsors.length > 0) return null;

  const legacyFiles = loadLegacyShapeFiles();
  if (!legacyFiles.length) return null;

  const sponsor = createSponsor("IKEA");
  const files = legacyFiles.map((fullPath, i) => ({
    buffer: fs.readFileSync(fullPath),
    originalname: `legacy-${i + 1}.png`
  }));
  addShapeFiles(sponsor.id, files);
  setActiveSponsorId(sponsor.id);
  return getSponsorById(sponsor.id);
}

function initializeSponsors() {
  ensureDataDirs();
  migrateLegacyShapesToIkea();
}

module.exports = {
  DATA_DIR,
  SPONSORS_DIR,
  MIN_SHAPES_PER_SPONSOR,
  MAX_SHAPES_PER_UPLOAD,
  FALLBACK_SHAPES,
  initializeSponsors,
  listSponsors,
  getSponsorById,
  createSponsor,
  addShapeFiles,
  deleteShape,
  getShapeUrls,
  getShapeEntries,
  getShapePool,
  getActiveSponsorId,
  setActiveSponsorId,
  getSponsorShapesDir
};
