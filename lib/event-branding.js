const fs = require("fs");
const path = require("path");
const { DATA_DIR } = require("./config");
const themes = require("./themes");

const CONFIG_PATH = path.join(DATA_DIR, "event-config.json");

function parsePanelFlag(value, defaultValue = false) {
  if (value === undefined || value === null) return defaultValue;
  return value === true || value === "true" || value === 1 || value === "1";
}

const DEFAULT_BG_POS = 50;
const DEFAULT_BG_SCALE = 100;
const BG_POS_MIN = -50;
const BG_POS_MAX = 150;
const BG_SCALE_MIN = 25;
const BG_SCALE_MAX = 500;
const MAX_CUSTOM_BACKGROUNDS = 20;

function clampBgPercent(value, fallback = DEFAULT_BG_POS) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(BG_POS_MAX, Math.max(BG_POS_MIN, Math.round(n)));
}

function clampBgScale(value, fallback = DEFAULT_BG_SCALE) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(BG_SCALE_MAX, Math.max(BG_SCALE_MIN, Math.round(n)));
}

function parseBgTransform(raw = {}) {
  return {
    customBackgroundPosX: clampBgPercent(raw.customBackgroundPosX, DEFAULT_BG_POS),
    customBackgroundPosY: clampBgPercent(raw.customBackgroundPosY, DEFAULT_BG_POS),
    customBackgroundScale: clampBgScale(raw.customBackgroundScale, DEFAULT_BG_SCALE)
  };
}

function stripBackgroundUrlQuery(url) {
  if (!url) return null;
  return String(url).split("?")[0] || null;
}

function normalizeBackgroundEntry(entry, fallbackTransform = {}) {
  const url = stripBackgroundUrlQuery(
    typeof entry === "string" ? entry : entry?.url
  );
  if (!url) return null;
  const fb = parseBgTransform(fallbackTransform);
  const raw = typeof entry === "object" && entry ? entry : {};
  return {
    url,
    posX: clampBgPercent(raw.posX ?? raw.customBackgroundPosX, fb.customBackgroundPosX),
    posY: clampBgPercent(raw.posY ?? raw.customBackgroundPosY, fb.customBackgroundPosY),
    scale: clampBgScale(raw.scale ?? raw.customBackgroundScale, fb.customBackgroundScale)
  };
}

function normalizeCustomBackgrounds(raw = {}) {
  const fallback = parseBgTransform(raw);
  const entries = [];
  const seen = new Set();

  if (Array.isArray(raw.customBackgrounds)) {
    for (const item of raw.customBackgrounds) {
      const entry = normalizeBackgroundEntry(item, fallback);
      if (!entry || seen.has(entry.url)) continue;
      seen.add(entry.url);
      entries.push(entry);
    }
  }

  const legacyUrls = [];
  if (Array.isArray(raw.customBackgroundUrls)) {
    for (const entry of raw.customBackgroundUrls) {
      const url = stripBackgroundUrlQuery(entry);
      if (url) legacyUrls.push(url);
    }
  }
  const legacy = stripBackgroundUrlQuery(raw.customBackgroundUrl);
  if (legacy && !legacyUrls.includes(legacy)) legacyUrls.unshift(legacy);

  for (const url of legacyUrls) {
    if (seen.has(url)) continue;
    seen.add(url);
    entries.push(normalizeBackgroundEntry({ url }, fallback));
  }

  return entries.slice(0, MAX_CUSTOM_BACKGROUNDS);
}

function normalizeBackgroundUrls(raw = {}) {
  return normalizeCustomBackgrounds(raw).map((entry) => entry.url);
}

function primaryBackgroundUrl(entriesOrRaw) {
  const entries = Array.isArray(entriesOrRaw)
    ? entriesOrRaw
    : normalizeCustomBackgrounds(entriesOrRaw);
  return entries.length ? entries[0].url : null;
}

function primaryBackgroundTransform(entries) {
  const first = entries[0];
  if (!first) return parseBgTransform({});
  return {
    customBackgroundPosX: first.posX,
    customBackgroundPosY: first.posY,
    customBackgroundScale: first.scale
  };
}

function defaultConfig() {
  return {
    title: "",
    sponsorId: null,
    sponsorName: null,
    themePattern: themes.DEFAULT_PATTERN,
    themeBackground: themes.DEFAULT_BACKGROUND,
    customBackgroundUrl: null,
    customBackgroundUrls: [],
    customBackgrounds: [],
    customBackgroundPosX: DEFAULT_BG_POS,
    customBackgroundPosY: DEFAULT_BG_POS,
    customBackgroundScale: DEFAULT_BG_SCALE,
    circlesPanelTransparent: false,
    rankingPanelTransparent: false
  };
}

function readEventConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return defaultConfig();
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    const backgrounds = normalizeCustomBackgrounds(raw);
    const theme = themes.normalizeTheme({
      ...raw,
      customBackgroundUrl: primaryBackgroundUrl(backgrounds),
      customBackgroundUrls: backgrounds.map((entry) => entry.url),
      customBackgrounds: backgrounds,
      themeBackground: themes.resolveThemeBackgroundForStorage(raw.themeBackground)
    });
    const primaryTransform = primaryBackgroundTransform(backgrounds);
    return {
      title: String(raw.title || "").trim(),
      sponsorId: raw.sponsorId || null,
      sponsorName: raw.sponsorName || null,
      themePattern: theme.themePattern,
      themeBackground: theme.themeBackground,
      customBackgroundUrl: primaryBackgroundUrl(backgrounds),
      customBackgroundUrls: backgrounds.map((entry) => entry.url),
      customBackgrounds: backgrounds,
      updatedAt: raw.updatedAt || null,
      ...primaryTransform,
      circlesPanelTransparent: parsePanelFlag(raw.circlesPanelTransparent, false),
      rankingPanelTransparent: parsePanelFlag(raw.rankingPanelTransparent, false)
    };
  } catch (_error) {
    return defaultConfig();
  }
}

function writeEventConfig(config) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const backgrounds = normalizeCustomBackgrounds(config);
  const theme = themes.normalizeTheme({
    ...config,
    themeBackground: themes.resolveThemeBackgroundForStorage(config.themeBackground),
    customBackgroundUrl: config.customBackgroundUrl || primaryBackgroundUrl(backgrounds),
    customBackgroundUrls: backgrounds.map((entry) => entry.url),
    customBackgrounds: backgrounds
  });
  const savedBackgrounds = backgrounds;
  const primaryTransform = primaryBackgroundTransform(backgrounds);
  const payload = {
    title: String(config.title || "").trim().slice(0, 80),
    sponsorId: config.sponsorId || null,
    sponsorName: config.sponsorName || null,
    themePattern: theme.themePattern,
    themeBackground: theme.themeBackground,
    customBackgroundUrl: primaryBackgroundUrl(savedBackgrounds),
    customBackgroundUrls: savedBackgrounds.map((entry) => entry.url),
    customBackgrounds: savedBackgrounds,
    ...primaryBackgroundTransform(savedBackgrounds),
    circlesPanelTransparent: parsePanelFlag(config.circlesPanelTransparent, false),
    rankingPanelTransparent: parsePanelFlag(config.rankingPanelTransparent, false),
    updatedAt: new Date().toISOString()
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(payload, null, 2), "utf8");
  return payload;
}

function withBackgroundCacheBuster(url, version) {
  const base = stripBackgroundUrlQuery(url);
  if (!base) return null;
  const v = version ? new Date(version).getTime() : Date.now();
  return `${base}?v=${v}`;
}

function withBackgroundUrlsCacheBuster(urls, version) {
  if (!Array.isArray(urls)) return [];
  return urls
    .map((url) => withBackgroundCacheBuster(url, version))
    .filter(Boolean);
}

function withCustomBackgroundsCacheBuster(backgrounds, version) {
  if (!Array.isArray(backgrounds)) return [];
  return backgrounds.map((entry) => ({
    url: withBackgroundCacheBuster(entry.url, version),
    posX: entry.posX,
    posY: entry.posY,
    scale: entry.scale
  })).filter((entry) => entry.url);
}

function backgroundFilenameFromUrl(url) {
  const base = stripBackgroundUrlQuery(url);
  if (!base) return null;
  const name = path.basename(base);
  if (!/^bg-[\w-]+\.(png|jpe?g|webp)$/i.test(name)
    && !/^event-background\.(png|jpe?g|webp)$/i.test(name)) {
    return null;
  }
  return name;
}

function updateBackgroundEntry(config, url, patch) {
  const backgrounds = normalizeCustomBackgrounds(config);
  const target = stripBackgroundUrlQuery(url);
  const index = backgrounds.findIndex((entry) => entry.url === target);
  if (index < 0) return null;
  backgrounds[index] = normalizeBackgroundEntry({
    ...backgrounds[index],
    ...patch,
    url: target
  }, parseBgTransform(config));
  return backgrounds;
}

module.exports = {
  CONFIG_PATH,
  readEventConfig,
  writeEventConfig,
  defaultConfig,
  stripBackgroundUrlQuery,
  normalizeBackgroundUrls,
  normalizeCustomBackgrounds,
  normalizeBackgroundEntry,
  primaryBackgroundUrl,
  primaryBackgroundTransform,
  withBackgroundCacheBuster,
  withBackgroundUrlsCacheBuster,
  withCustomBackgroundsCacheBuster,
  backgroundFilenameFromUrl,
  updateBackgroundEntry,
  MAX_CUSTOM_BACKGROUNDS,
  parseBgTransform,
  DEFAULT_BG_POS,
  DEFAULT_BG_SCALE,
  BG_POS_MIN,
  BG_POS_MAX,
  BG_SCALE_MIN,
  BG_SCALE_MAX
};
