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

function clampBgPercent(value, fallback = DEFAULT_BG_POS) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(100, Math.max(0, Math.round(n)));
}

function clampBgScale(value, fallback = DEFAULT_BG_SCALE) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(250, Math.max(50, Math.round(n)));
}

function parseBgTransform(raw = {}) {
  return {
    customBackgroundPosX: clampBgPercent(raw.customBackgroundPosX, DEFAULT_BG_POS),
    customBackgroundPosY: clampBgPercent(raw.customBackgroundPosY, DEFAULT_BG_POS),
    customBackgroundScale: clampBgScale(raw.customBackgroundScale, DEFAULT_BG_SCALE)
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
    const theme = themes.normalizeTheme(raw);
    const customUrl = theme.themeBackground === "custom" ? raw.customBackgroundUrl || null : null;
    const bgTransform = parseBgTransform(raw);
    return {
      title: String(raw.title || "").trim(),
      sponsorId: raw.sponsorId || null,
      sponsorName: raw.sponsorName || null,
      themePattern: theme.themePattern,
      themeBackground: theme.themeBackground,
      customBackgroundUrl: stripBackgroundUrlQuery(customUrl),
      updatedAt: raw.updatedAt || null,
      ...bgTransform,
      circlesPanelTransparent: parsePanelFlag(raw.circlesPanelTransparent, false),
      rankingPanelTransparent: parsePanelFlag(raw.rankingPanelTransparent, false)
    };
  } catch (_error) {
    return defaultConfig();
  }
}

function stripBackgroundUrlQuery(url) {
  if (!url) return null;
  return String(url).split("?")[0] || null;
}

function writeEventConfig(config) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const theme = themes.normalizeTheme(config);
  const rawCustomUrl = theme.themeBackground === "custom" ? config.customBackgroundUrl || null : null;
  const bgTransform = parseBgTransform(config);
  const payload = {
    title: String(config.title || "").trim().slice(0, 80),
    sponsorId: config.sponsorId || null,
    sponsorName: config.sponsorName || null,
    themePattern: theme.themePattern,
    themeBackground: theme.themeBackground,
    customBackgroundUrl: stripBackgroundUrlQuery(rawCustomUrl),
    ...bgTransform,
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

module.exports = {
  CONFIG_PATH,
  readEventConfig,
  writeEventConfig,
  defaultConfig,
  stripBackgroundUrlQuery,
  withBackgroundCacheBuster,
  parseBgTransform,
  DEFAULT_BG_POS,
  DEFAULT_BG_SCALE
};
