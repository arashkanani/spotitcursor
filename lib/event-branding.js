const fs = require("fs");
const path = require("path");
const { DATA_DIR } = require("./config");
const themes = require("./themes");

const CONFIG_PATH = path.join(DATA_DIR, "event-config.json");

function parsePanelFlag(value, defaultValue = false) {
  if (value === undefined || value === null) return defaultValue;
  return value === true || value === "true" || value === 1 || value === "1";
}

function defaultConfig() {
  return {
    title: "",
    sponsorId: null,
    sponsorName: null,
    themePattern: themes.DEFAULT_PATTERN,
    themeBackground: themes.DEFAULT_BACKGROUND,
    customBackgroundUrl: null,
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
    return {
      title: String(raw.title || "").trim(),
      sponsorId: raw.sponsorId || null,
      sponsorName: raw.sponsorName || null,
      themePattern: theme.themePattern,
      themeBackground: theme.themeBackground,
      customBackgroundUrl: stripBackgroundUrlQuery(customUrl),
      updatedAt: raw.updatedAt || null,
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
  const payload = {
    title: String(config.title || "").trim().slice(0, 80),
    sponsorId: config.sponsorId || null,
    sponsorName: config.sponsorName || null,
    themePattern: theme.themePattern,
    themeBackground: theme.themeBackground,
    customBackgroundUrl: stripBackgroundUrlQuery(rawCustomUrl),
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
  withBackgroundCacheBuster
};
