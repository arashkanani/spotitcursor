const GAME_PATTERNS = [
  {
    id: "classic",
    name: "Classic split",
    description: "Two circles side by side with live leaderboard on the right."
  },
  {
    id: "spotlight",
    name: "Spotlight",
    description: "Larger circles for arena screens; compact ranking column."
  },
  {
    id: "stage",
    name: "Center stage",
    description: "Stacked circles in the middle — great for portrait displays."
  },
  {
    id: "wide",
    name: "Wide board",
    description: "Full-width game board with ranking underneath."
  },
  {
    id: "cinema",
    name: "Cinema",
    description: "Bold framed circles and dramatic spacing for big venues."
  }
];

const GAME_BACKGROUNDS = [
  {
    id: "midnight",
    name: "Midnight",
    description: "Deep blue night — default show look."
  },
  {
    id: "ocean",
    name: "Ocean",
    description: "Cool cyan and teal gradients."
  },
  {
    id: "sunset",
    name: "Sunset",
    description: "Warm gold, rose, and amber glow."
  },
  {
    id: "emerald",
    name: "Emerald",
    description: "Fresh green event energy."
  },
  {
    id: "royal",
    name: "Royal",
    description: "Purple and violet premium lounge."
  }
];

const THEME_PRESETS = [
  { id: "classic-midnight", pattern: "classic", background: "midnight", name: "Classic night" },
  { id: "spotlight-ocean", pattern: "spotlight", background: "ocean", name: "Ocean arena" },
  { id: "stage-sunset", pattern: "stage", background: "sunset", name: "Sunset stage" },
  { id: "wide-royal", pattern: "wide", background: "royal", name: "Royal wide" },
  { id: "cinema-emerald", pattern: "cinema", background: "emerald", name: "Emerald cinema" }
];

const DEFAULT_PATTERN = "classic";
const DEFAULT_BACKGROUND = "midnight";

function isValidPattern(id) {
  return GAME_PATTERNS.some((p) => p.id === id);
}

function isValidBackground(id) {
  return id === "custom" || GAME_BACKGROUNDS.some((b) => b.id === id);
}

const PATTERN_DEFAULT_BACKGROUNDS = {
  classic: "midnight",
  spotlight: "ocean",
  stage: "sunset",
  wide: "royal",
  cinema: "emerald"
};

function defaultBackgroundForPattern(patternId) {
  return PATTERN_DEFAULT_BACKGROUNDS[patternId] || DEFAULT_BACKGROUND;
}

function hasStoredCustomBackgrounds(input = {}) {
  if (String(input.customBackgroundUrl || "").trim()) return true;
  if (Array.isArray(input.customBackgroundUrls) && input.customBackgroundUrls.length > 0) return true;
  if (Array.isArray(input.customBackgrounds) && input.customBackgrounds.length > 0) return true;
  return false;
}

function normalizeTheme(input = {}) {
  const pattern = isValidPattern(input.themePattern) ? input.themePattern : DEFAULT_PATTERN;
  let background = input.themeBackground;

  if (background === "custom") {
    background = hasStoredCustomBackgrounds(input)
      ? "custom"
      : defaultBackgroundForPattern(pattern);
  } else if (!isValidBackground(background)) {
    background = defaultBackgroundForPattern(pattern);
  }

  return { themePattern: pattern, themeBackground: background };
}

module.exports = {
  GAME_PATTERNS,
  GAME_BACKGROUNDS,
  THEME_PRESETS,
  DEFAULT_PATTERN,
  DEFAULT_BACKGROUND,
  PATTERN_DEFAULT_BACKGROUNDS,
  defaultBackgroundForPattern,
  normalizeTheme
};
