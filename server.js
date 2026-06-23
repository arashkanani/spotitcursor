const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const express = require("express");
const cookieParser = require("cookie-parser");
const compression = require("compression");
const multer = require("multer");
const { createServer } = require("http");
const { Server } = require("socket.io");
const QRCode = require("qrcode");
const sponsors = require("./lib/sponsors");
const eventBrandingStore = require("./lib/event-branding");
const themes = require("./lib/themes");
const { PORT, IS_PRODUCTION, PUBLIC_URL, MAX_PLAYERS, ROUND_TIMEOUT_MS } = require("./lib/config");
const userStore = require("./lib/user-store");
const authLib = require("./lib/auth");
const googleAuth = require("./lib/google-auth");
const { attachSocketAuthMiddleware } = require("./lib/socket-auth");

const app = express();
const httpServer = createServer(app);

if (IS_PRODUCTION) {
  app.set("trust proxy", 1);
}

const io = new Server(httpServer, {
  maxHttpBufferSize: 2e6,
  pingTimeout: 60000,
  pingInterval: 25000,
  connectTimeout: 45000,
  perMessageDeflate: true,
  cors: {
    origin: true,
    credentials: true
  }
});

attachSocketAuthMiddleware(io);

function appendAudit({ userId, email, req, type, meta }) {
  userStore.appendActivity({
    userId: userId ?? req?.user?.id ?? null,
    email: email ? userStore.normalizeEmail(email) : req?.user?.email ?? null,
    type: String(type || "unknown"),
    meta: meta && typeof meta === "object" ? meta : {}
  });
}

const TOTAL_ROUNDS = 20;
const MOBILE_SHAPES_PER_ROUND = 18;
const MAX_PHOTO_LENGTH = 220000;
const ROUND_WINNER_OVERLAY_DELAY_MS = 2000;
const ROUND_WINNER_OVERLAY_DURATION_MS = 4000;
const ROUND_WINNER_DISPLAY_MS = ROUND_WINNER_OVERLAY_DELAY_MS + ROUND_WINNER_OVERLAY_DURATION_MS;
const MISTAKES_PER_ROUND = 3;
const DEMO_SUSPEND_MESSAGE = "Demo access is temporarily paused while a real game is running at full capacity. Please try again later.";

const { DATA_DIR } = require("./lib/config");
const BACKGROUNDS_DIR = path.join(DATA_DIR, "backgrounds");
fs.mkdirSync(BACKGROUNDS_DIR, { recursive: true });

function backgroundFileExists(url) {
  const filename = eventBrandingStore.backgroundFilenameFromUrl(url);
  if (!filename) return false;
  return fs.existsSync(path.join(BACKGROUNDS_DIR, filename));
}

function repairEventConfig(config) {
  const next = { ...config };
  let changed = false;

  const backgrounds = eventBrandingStore.normalizeCustomBackgrounds(next);
  const existing = backgrounds.filter((entry) => backgroundFileExists(entry.url));
  if (existing.length !== backgrounds.length) {
    next.customBackgrounds = existing;
    next.customBackgroundUrls = existing.map((entry) => entry.url);
    next.customBackgroundUrl = eventBrandingStore.primaryBackgroundUrl(existing);
    Object.assign(next, eventBrandingStore.primaryBackgroundTransform(existing));
    changed = true;
  }

  if (next.themeBackground === "custom") {
    next.themeBackground = themes.resolveThemeBackgroundForStorage("custom");
    changed = true;
  }

  const theme = themes.normalizeTheme(next);
  if (theme.themePattern !== next.themePattern || theme.themeBackground !== next.themeBackground) {
    next.themePattern = theme.themePattern;
    next.themeBackground = theme.themeBackground;
    changed = true;
  }

  return changed ? eventBrandingStore.writeEventConfig(next) : next;
}

let eventConfig = repairEventConfig(eventBrandingStore.readEventConfig());

function newBackgroundFilename(originalName) {
  const ext = path.extname(originalName).toLowerCase();
  const safeExt = ext === ".png" || ext === ".webp" || ext === ".jpg" || ext === ".jpeg"
    ? ext
    : ".jpg";
  return `bg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}${safeExt}`;
}

const backgroundUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, BACKGROUNDS_DIR),
    filename: (_req, file, cb) => {
      cb(null, newBackgroundFilename(file.originalname));
    }
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(jpeg|jpg|png|webp)$/i.test(file.mimetype)) {
      cb(null, true);
      return;
    }
    cb(new Error("Background must be JPG, PNG, or WebP."));
  }
});

const shapeUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 6 * 1024 * 1024,
    files: sponsors.MAX_SHAPES_PER_UPLOAD
  },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === "image/png" || file.originalname.toLowerCase().endsWith(".png")) {
      cb(null, true);
      return;
    }
    cb(new Error("Only PNG shape images are allowed."));
  }
});

sponsors.initializeSponsors();

function syncSponsorSelectionFromEventConfig() {
  const sponsorId = eventConfig.sponsorId;
  if (!sponsorId) return;
  const sponsor = sponsors.getSponsorById(sponsorId);
  if (!sponsor) {
    console.warn(`Saved event sponsor "${sponsorId}" was not found in sponsor index.`);
    return;
  }
  if (sponsor.shapeCount < sponsors.MIN_SHAPES_PER_SPONSOR) {
    console.warn(
      `Saved event sponsor "${sponsor.name}" (${sponsorId}) has ${sponsor.shapeCount} shapes — need ${sponsors.MIN_SHAPES_PER_SPONSOR}.`
    );
    return;
  }
  try {
    sponsors.setActiveSponsorId(sponsorId);
  } catch (error) {
    console.warn(`Could not sync active sponsor from event config: ${error.message}`);
  }
}

function applySponsorToLiveEvent(sponsor, title) {
  const eventTitle = String(title || eventConfig.title || "").trim().slice(0, 80);
  if (!eventTitle) {
    return { ok: false, error: "Enter an event title before saving shapes for the live game." };
  }
  if (!sponsor || sponsor.shapeCount < sponsors.MIN_SHAPES_PER_SPONSOR) {
    return {
      ok: false,
      error: `This sponsor needs at least ${sponsors.MIN_SHAPES_PER_SPONSOR} PNG shapes.`
    };
  }
  if (game.started && !game.ended) {
    cancelGame();
  }
  sponsors.setActiveSponsorId(sponsor.id);
  eventConfig = eventBrandingStore.writeEventConfig({
    ...eventConfig,
    title: eventTitle,
    sponsorId: sponsor.id,
    sponsorName: sponsor.name
  });
  const payload = getEventPayload();
  io.emit("eventBranding", payload);
  emitGameState();
  return { ok: true, payload };
}

syncSponsorSelectionFromEventConfig();

const countriesByCode = loadCountries();
const allowedCountryCodes = new Set(countriesByCode.keys());

function loadCountries() {
  const filePath = path.join(__dirname, "public", "countries.json");
  const list = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const map = new Map();
  for (const entry of list) {
    if (entry.code && entry.code !== "IL") {
      map.set(entry.code, entry.name);
    }
  }
  return map;
}

function normalizePhoto(data) {
  const value = String(data || "");
  if (!/^data:image\/(jpeg|jpg|png|webp);base64,/i.test(value)) return null;
  if (value.length > MAX_PHOTO_LENGTH) return null;
  return value;
}

function toLeaderboardEntry(player, { includePhoto = false } = {}) {
  const entry = {
    id: player.id,
    name: player.name,
    score: player.score,
    countryCode: player.countryCode,
    countryName: player.countryName
  };
  if (includePhoto) {
    entry.photo = player.photo;
  }
  return entry;
}

function getPlayerBySocket(socketId) {
  const playerId = socketToPlayerId.get(socketId);
  return playerId ? players.get(playerId) : null;
}

function bindSocketToPlayer(socket, player) {
  const previousSocketId = player.socketId;
  if (previousSocketId && previousSocketId !== socket.id) {
    socketToPlayerId.delete(previousSocketId);
  }
  player.socketId = socket.id;
  socketToPlayerId.set(socket.id, player.id);
}

function findPlayerByToken(token) {
  if (!token) return null;
  for (const player of players.values()) {
    if (player.token === token) return player;
  }
  return null;
}

function emitPlayerJoined(player) {
  io.emit("playerJoined", toLeaderboardEntry(player, { includePhoto: true }));
}

function emitPlayerLeft(playerId) {
  io.emit("playerLeft", { id: playerId });
}

function clearRoundTimer() {
  if (roundTimer) {
    clearTimeout(roundTimer);
    roundTimer = null;
  }
}

function scheduleRoundTimeout() {
  clearRoundTimer();
  if (!ROUND_TIMEOUT_MS || ROUND_TIMEOUT_MS < 1000) return;
  if (!game.started || game.ended || !game.currentRound) return;

  roundTimer = setTimeout(() => {
    roundTimer = null;
    if (!game.started || game.ended || game.roundLocked || !game.currentRound) return;
    advanceRoundAfterTimeout();
  }, ROUND_TIMEOUT_MS);
}

function advanceRoundAfterTimeout() {
  if (!game.started || game.ended || !game.currentRound) return;

  game.roundLocked = true;
  const correctShape = game.currentRound.commonShape;

  io.emit("roundTimeout", {
    correctShape,
    roundNumber: game.roundNumber,
    totalRounds: game.totalRounds
  });
  emitGameState();

  setTimeout(() => {
    if (!game.started || game.ended) return;
    if (game.roundNumber >= game.totalRounds) {
      finishGame();
    } else {
      startRound();
    }
  }, ROUND_WINNER_DISPLAY_MS);
}

function getShapePool() {
  return sponsors.getShapePool(eventConfig.sponsorId);
}

function getEventPayload() {
  const sponsor = eventConfig.sponsorId
    ? sponsors.getSponsorById(eventConfig.sponsorId)
    : null;
  const theme = themes.normalizeTheme(eventConfig);
  const storedBackgrounds = eventBrandingStore.normalizeCustomBackgrounds(eventConfig);
  return {
    title: eventConfig.title,
    sponsorId: eventConfig.sponsorId,
    sponsorName: eventConfig.sponsorName,
    sponsorShapeCount: sponsor ? sponsor.shapeCount : 0,
    sponsorReady: sponsor ? sponsor.shapeCount >= sponsors.MIN_SHAPES_PER_SPONSOR : false,
    themePattern: theme.themePattern,
    themeBackground: theme.themeBackground,
    customBackgroundUrl: storedBackgrounds.length
      ? eventBrandingStore.withBackgroundCacheBuster(
        eventConfig.customBackgroundUrl,
        eventConfig.updatedAt
      )
      : null,
    customBackgroundUrls: storedBackgrounds.length
      ? eventBrandingStore.withBackgroundUrlsCacheBuster(
        storedBackgrounds.map((entry) => entry.url),
        eventConfig.updatedAt
      )
      : [],
    customBackgrounds: storedBackgrounds.length
      ? eventBrandingStore.withCustomBackgroundsCacheBuster(
        storedBackgrounds,
        eventConfig.updatedAt
      )
      : [],
    updatedAt: eventConfig.updatedAt || null,
    customBackgroundPosX: eventConfig.customBackgroundPosX ?? eventBrandingStore.DEFAULT_BG_POS,
    customBackgroundPosY: eventConfig.customBackgroundPosY ?? eventBrandingStore.DEFAULT_BG_POS,
    customBackgroundScale: eventConfig.customBackgroundScale ?? eventBrandingStore.DEFAULT_BG_SCALE,
    circlesPanelTransparent: !!eventConfig.circlesPanelTransparent,
    rankingPanelTransparent: !!eventConfig.rankingPanelTransparent,
    circleSize: eventBrandingStore.normalizeCircleSize(eventConfig.circleSize)
  };
}

function getPublicBaseUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  if (req) {
    const proto = req.get("x-forwarded-proto") || req.protocol || "https";
    const host = req.get("x-forwarded-host") || req.get("host");
    if (host) return `${proto}://${host}`;
  }
  return `http://localhost:${PORT}`;
}

function accessCookieOptions() {
  return {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: "lax",
    maxAge: userStore.ACCESS_SESSION_TTL_MS,
    path: "/"
  };
}

const players = new Map();
const socketToPlayerId = new Map();
let game = createNewGame();
let roundTimer = null;
let dashboardCodeId = null;
let activeGameCodeId = null;

function createNewGame(totalRounds = TOTAL_ROUNDS) {
  return {
    started: false,
    ended: false,
    roundNumber: 0,
    totalRounds,
    currentRound: null,
    roundLocked: false
  };
}

function currentDashboardCode() {
  return userStore.getCodeById(activeGameCodeId || dashboardCodeId);
}

function isRealGameRunning() {
  const code = userStore.getCodeById(activeGameCodeId);
  return Boolean(game.started && !game.ended && code?.tier === "real");
}

function effectiveMaxPlayers() {
  const code = currentDashboardCode();
  if (!code?.maxPlayers) return MAX_PLAYERS;
  return Math.min(MAX_PLAYERS, Number(code.maxPlayers) || MAX_PLAYERS);
}

function randomShuffle(items) {
  const list = [...items];
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

function buildMobileShapes(leftShapes, rightShapes, commonShape) {
  const unique = [...new Set([...leftShapes, ...rightShapes])];
  if (unique.length <= MOBILE_SHAPES_PER_ROUND) {
    return randomShuffle(unique);
  }

  const others = unique.filter((shape) => shape !== commonShape);
  return randomShuffle([commonShape, ...others.slice(0, MOBILE_SHAPES_PER_ROUND - 1)]);
}

function generateRound() {
  const shapePool = getShapePool();
  const commonShape = shapePool[Math.floor(Math.random() * shapePool.length)];
  const candidates = randomShuffle(shapePool.filter((shape) => shape !== commonShape));

  const leftExtra = candidates.slice(0, 9);
  const rightExtra = candidates.slice(9, 18);
  const leftShapes = randomShuffle([commonShape, ...leftExtra]);
  const rightShapes = randomShuffle([commonShape, ...rightExtra]);
  const mobileShapes = buildMobileShapes(leftShapes, rightShapes, commonShape);

  return { commonShape, leftShapes, rightShapes, mobileShapes };
}

function getLeaderboard(options) {
  return [...players.values()]
    .map((player) => toLeaderboardEntry(player, options))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

function buildGameStatePayload() {
  const includePhoto = game.ended;
  return {
    started: game.started,
    ended: game.ended,
    roundNumber: game.roundNumber,
    totalRounds: game.totalRounds,
    currentRound: game.currentRound
      ? {
          leftShapes: game.currentRound.leftShapes,
          rightShapes: game.currentRound.rightShapes
        }
      : null,
    mobileShapes: game.currentRound ? game.currentRound.mobileShapes : [],
    leaderboard: getLeaderboard({ includePhoto }),
    playerCount: players.size,
    registrationOpen: !game.started || game.ended,
    playerCap: effectiveMaxPlayers()
  };
}

function emitGameState() {
  io.emit("gameState", buildGameStatePayload());
}

function resetRoundMistakes() {
  players.forEach((player) => {
    player.roundMistakes = 0;
  });
}

function startRound() {
  clearRoundTimer();
  game.roundNumber += 1;
  game.roundLocked = false;
  game.currentRound = generateRound();
  resetRoundMistakes();
  emitGameState();
  scheduleRoundTimeout();
}

function startGame(totalRounds = TOTAL_ROUNDS) {
  players.forEach((player) => {
    player.score = 0;
  });
  game = createNewGame(totalRounds);
  game.started = true;
  startRound();
}

function finishGame() {
  clearRoundTimer();
  game.ended = true;
  game.started = false;
  game.roundLocked = true;
  activeGameCodeId = null;
  io.emit("gameOver", { leaderboard: getLeaderboard({ includePhoto: true }) });
  emitGameState();
}

function cancelGame() {
  clearRoundTimer();
  players.forEach((player) => {
    player.score = 0;
    player.roundMistakes = 0;
  });
  game = createNewGame();
  activeGameCodeId = null;
  emitGameState();
}

function resetSession() {
  clearRoundTimer();
  const resetMessage = "The host reset the game. Scan the QR code on the host screen to register again.";
  for (const player of players.values()) {
    if (!player.socketId) continue;
    const sock = io.sockets.sockets.get(player.socketId);
    if (sock) {
      sock.emit("sessionReset", { message: resetMessage });
    }
  }
  for (const playerId of players.keys()) {
    emitPlayerLeft(playerId);
  }
  players.clear();
  socketToPlayerId.clear();
  game = createNewGame();
  activeGameCodeId = null;
  io.emit("lobbyCleared");
  emitGameState();
}

app.use(compression());
app.use(express.json({ limit: "12mb" }));
app.use(cookieParser());
app.use(authLib.attachUserMiddleware());
app.use((req, _res, next) => {
  const token = req.cookies?.[userStore.ACCESS_COOKIE_NAME];
  req.dashboardAccess = userStore.getAccessSession(token) || null;
  next();
});
app.use(express.static(path.join(__dirname, "public"), {
  maxAge: IS_PRODUCTION ? "1h" : 0,
  etag: true
}));
app.use("/flags", express.static(path.join(__dirname, "node_modules/flag-icons/flags/4x3"), {
  maxAge: IS_PRODUCTION ? "7d" : 0
}));
app.use("/sponsor-shapes", express.static(sponsors.SPONSORS_DIR, {
  maxAge: IS_PRODUCTION ? "1d" : 0
}));
app.use("/event-backgrounds", express.static(BACKGROUNDS_DIR, {
  maxAge: 0,
  etag: false,
  setHeaders(res) {
    res.setHeader("Cache-Control", "no-store");
  }
}));

app.get("/health", (_req, res) => {
  const { DATA_DIR } = require("./lib/config");
  res.json({
    ok: true,
    players: players.size,
    maxPlayers: MAX_PLAYERS,
    uptime: Math.floor(process.uptime()),
    dataDir: DATA_DIR,
    eventSponsorId: eventConfig.sponsorId || null,
    eventSponsorName: eventConfig.sponsorName || null,
    activeSponsorId: sponsors.getActiveSponsorId(),
    sponsorCount: sponsors.listSponsors().length,
    features: {
      multiCustomBackgrounds: true,
      accounts: true,
      googleSignIn: Boolean(googleAuth.getGoogleClientId())
    }
  });
});

app.get("/dashboard-access", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard-access.html"));
});

app.get("/", (req, res) => {
  if (!req.dashboardAccess) {
    res.redirect("/dashboard-access?next=/");
    return;
  }
  res.sendFile(path.join(__dirname, "public", "host.html"));
});

app.get("/mobile", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "mobile.html"));
});

app.get("/account", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "account.html"));
});

app.get("/api/auth/config", (_req, res) => {
  res.json({
    googleClientId: googleAuth.getGoogleClientId()
  });
});

app.post("/api/auth/register", async (req, res) => {
  try {
    const email = userStore.normalizeEmail(req.body?.email);
    const password = String(req.body?.password || "");
    if (!email) {
      res.status(400).json({ error: "Email is required." });
      return;
    }
    if (password.length < 8) {
      res.status(400).json({ error: "Password must be at least 8 characters." });
      return;
    }
    const passwordHash = await authLib.hashPassword(password);
    const user = userStore.createUser({ email, passwordHash });
    appendAudit({ userId: user.id, email: user.email, type: "auth.register", meta: {} });
    const publicUser = authLib.setAuthSession(res, user);
    res.status(201).json({ user: publicUser });
  } catch (error) {
    res.status(400).json({ error: error.message || "Could not register." });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const email = userStore.normalizeEmail(req.body?.email);
    const password = String(req.body?.password || "");
    const user = userStore.findUserByEmail(email);
    if (!user?.passwordHash) {
      res.status(401).json({ error: "Incorrect email or password." });
      return;
    }
    const okPass = await authLib.verifyPassword(password, user.passwordHash);
    if (!okPass) {
      res.status(401).json({ error: "Incorrect email or password." });
      return;
    }
    appendAudit({ userId: user.id, email: user.email, type: "auth.login", meta: {} });
    const publicUser = authLib.setAuthSession(res, user);
    res.json({ user: publicUser });
  } catch (error) {
    console.error("Auth login failed:", error);
    let message = "Could not sign in.";
    if (/SESSION_SECRET/i.test(String(error?.message || ""))) {
      message = "Server auth is misconfigured. Set SESSION_SECRET to at least 16 characters on Render.";
    }
    res.status(400).json({ error: message });
  }
});

app.post("/api/auth/google", async (req, res) => {
  try {
    const profile = await googleAuth.verifyGoogleIdToken(req.body?.credential);
    const user = userStore.findOrCreateGoogleUser({
      googleId: profile.googleId,
      email: profile.email
    });
    appendAudit({ userId: user.id, email: user.email, type: "auth.login_google", meta: {} });
    const publicUser = authLib.setAuthSession(res, user);
    res.json({ user: publicUser });
  } catch (error) {
    const status = /not configured/i.test(error.message) ? 503 : 400;
    res.status(status).json({ error: error.message || "Google sign-in failed." });
  }
});

app.post("/api/auth/logout", (req, res) => {
  appendAudit({ req, type: "auth.logout", meta: {} });
  authLib.clearAuthCookie(res);
  res.json({ ok: true });
});

app.get("/api/auth/me", (req, res) => {
  if (!req.user) {
    res.json({ user: null });
    return;
  }
  res.json({ user: req.user });
});

app.get("/api/access/debug-hint", (_req, res) => {
  res.json(userStore.getDebugAccessHint() || { debug: false });
});

app.get("/api/access/me", (req, res) => {
  if (!req.dashboardAccess?.code) {
    res.json({ access: null, realGameRunning: isRealGameRunning() });
    return;
  }
  res.json({
    access: req.dashboardAccess.code,
    realGameRunning: isRealGameRunning()
  });
});

app.post("/api/access/login", (req, res) => {
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "").trim();
  const code = userStore.findAccessCodeByCredentials(username, password);
  if (!code || code.disabled) {
    res.status(401).json({ error: "Invalid username or password." });
    return;
  }
  if (code.tier === "demo" && isRealGameRunning()) {
    res.status(403).json({ error: DEMO_SUSPEND_MESSAGE, reason: "demo_suspended" });
    return;
  }
  if (userStore.isAccessCodeExpired(code)) {
    res.status(403).json({
      error: "This access code has expired.",
      reason: "expired"
    });
    return;
  }
  if (!userStore.hasAccessCodeUsesRemaining(code)) {
    res.status(403).json({
      error: "This access code has reached its maximum number of game launches.",
      reason: "uses_exhausted"
    });
    return;
  }
  const session = userStore.createAccessSession(code.id);
  if (!session) {
    res.status(400).json({ error: "Could not create dashboard session." });
    return;
  }
  dashboardCodeId = code.id;
  res.cookie(userStore.ACCESS_COOKIE_NAME, session.token, accessCookieOptions());
  res.json({ access: session.code });
});

app.post("/api/access/logout", (req, res) => {
  const token = req.cookies?.[userStore.ACCESS_COOKIE_NAME];
  userStore.clearAccessSession(token);
  res.clearCookie(userStore.ACCESS_COOKIE_NAME, { path: "/", secure: IS_PRODUCTION, sameSite: "lax" });
  res.json({ ok: true });
});

app.get("/admin", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.get("/api/admin/summary", authLib.requireAdmin, (_req, res) => {
  res.json(userStore.getAdminSummary());
});

app.get("/api/admin/users", authLib.requireAdmin, (_req, res) => {
  res.json({ users: userStore.listUsersPublic() });
});

app.get("/api/admin/mobile-players", authLib.requireAdmin, (_req, res) => {
  res.json({ players: userStore.listMobilePlayersAdmin() });
});

app.get("/api/admin/activity", authLib.requireAdmin, (req, res) => {
  const limit = Number(req.query.limit) || 100;
  const offset = Number(req.query.offset) || 0;
  res.json(userStore.listActivity({ limit, offset }));
});

app.get("/api/admin/access-codes", authLib.requireAdmin, (_req, res) => {
  res.json({ codes: userStore.listAccessCodes(), realGameRunning: isRealGameRunning() });
});

app.post("/api/admin/access-codes/weekly", authLib.requireAdmin, (req, res) => {
  try {
    const result = userStore.ensureWeeklyAccessCodes(5);
    appendAudit({
      req,
      type: "access.weekly_ensure",
      meta: {
        created: result.created.length,
        activeWeekly: result.weeklyCodes.length
      }
    });
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message || "Could not create weekly codes." });
  }
});

app.post("/api/admin/access-codes/:id/disable-regenerate", authLib.requireAdmin, (req, res) => {
  try {
    const result = userStore.disableAndRegenerateAccessCode(req.params.id, "disabled_by_admin");
    const clearedSessions = userStore.clearAccessSessionsByCodeId(req.params.id);
    if (dashboardCodeId === req.params.id) {
      dashboardCodeId = null;
    }
    if (activeGameCodeId === req.params.id) {
      activeGameCodeId = null;
      cancelGame();
    }
    appendAudit({
      req,
      type: "access.disable_regenerate",
      meta: {
        disabledUsername: result.disabled.username,
        replacementUsername: result.replacement.username,
        tier: result.disabled.tier,
        clearedSessions
      }
    });
    res.json({ ...result, clearedSessions });
  } catch (error) {
    res.status(400).json({ error: error.message || "Could not disable code." });
  }
});

app.post("/api/admin/access-codes/:id/force-logout", authLib.requireAdmin, (req, res) => {
  try {
    const code = userStore.getCodeById(req.params.id);
    if (!code) {
      res.status(404).json({ error: "Access code not found." });
      return;
    }
    const clearedSessions = userStore.clearAccessSessionsByCodeId(req.params.id);
    if (dashboardCodeId === req.params.id) {
      dashboardCodeId = null;
    }
    appendAudit({
      req,
      type: "access.force_logout",
      meta: {
        username: code.username,
        tier: code.tier,
        clearedSessions
      }
    });
    res.json({ ok: true, clearedSessions });
  } catch (error) {
    res.status(400).json({ error: error.message || "Could not force logout code." });
  }
});

app.get("/api/themes", (_req, res) => {
  res.json({
    patterns: themes.GAME_PATTERNS,
    backgrounds: themes.GAME_BACKGROUNDS,
    presets: themes.THEME_PRESETS,
    defaults: {
      pattern: themes.DEFAULT_PATTERN,
      background: themes.DEFAULT_BACKGROUND
    }
  });
});

app.get("/api/event-branding", (_req, res) => {
  res.json(getEventPayload());
});

function isStoredBackgroundFile(file) {
  return /^bg-[\w-]+\.(png|jpe?g|webp)$/i.test(file)
    || /^event-background\.(png|jpe?g|webp)$/i.test(file);
}

function clearStoredCustomBackgroundFiles(keepFilenames = []) {
  if (!fs.existsSync(BACKGROUNDS_DIR)) return;
  const keep = new Set(Array.isArray(keepFilenames) ? keepFilenames : [keepFilenames].filter(Boolean));
  for (const file of fs.readdirSync(BACKGROUNDS_DIR)) {
    if (!isStoredBackgroundFile(file)) continue;
    if (keep.has(file)) continue;
    try {
      fs.unlinkSync(path.join(BACKGROUNDS_DIR, file));
    } catch (_error) {
      // Ignore delete errors.
    }
  }
}

function deleteStoredBackgroundFile(url) {
  const filename = eventBrandingStore.backgroundFilenameFromUrl(url);
  if (!filename) return false;
  const filePath = path.join(BACKGROUNDS_DIR, filename);
  if (!fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  return true;
}

function appendCustomBackgroundUrl(url) {
  const backgrounds = eventBrandingStore.normalizeCustomBackgrounds(eventConfig);
  if (backgrounds.length >= eventBrandingStore.MAX_CUSTOM_BACKGROUNDS) {
    throw new Error(`You can upload up to ${eventBrandingStore.MAX_CUSTOM_BACKGROUNDS} advertising backgrounds.`);
  }
  if (!backgrounds.some((entry) => entry.url === url)) {
    const entry = eventBrandingStore.normalizeBackgroundEntry({ url }, eventConfig);
    if (entry) backgrounds.push(entry);
  }
  const baseBackground = themes.resolveThemeBackgroundForStorage(eventConfig.themeBackground);
  return eventBrandingStore.writeEventConfig({
    ...eventConfig,
    themeBackground: baseBackground,
    customBackgrounds: backgrounds,
    customBackgroundUrls: backgrounds.map((entry) => entry.url),
    customBackgroundUrl: url
  });
}

app.patch("/api/event-branding/theme", (req, res) => {
  const pattern = String(req.body?.themePattern || "").trim();
  const background = String(req.body?.themeBackground || "").trim();
  const bgTransform = eventBrandingStore.parseBgTransform(req.body);

  if (pattern && themes.isValidPattern(pattern)) {
    eventConfig.themePattern = pattern;
  }

  if (background && themes.isValidBackground(background) && background !== "custom") {
    eventConfig.themeBackground = background;
  }

  if (Array.isArray(req.body?.customBackgrounds)) {
    eventConfig.customBackgrounds = eventBrandingStore.normalizeCustomBackgrounds({
      ...eventConfig,
      customBackgrounds: req.body.customBackgrounds
    });
    eventConfig.customBackgroundUrls = eventConfig.customBackgrounds.map((entry) => entry.url);
    eventConfig.customBackgroundUrl = eventBrandingStore.primaryBackgroundUrl(eventConfig.customBackgrounds);
    Object.assign(eventConfig, eventBrandingStore.primaryBackgroundTransform(eventConfig.customBackgrounds));
  } else if (req.body?.customBackgroundPosX !== undefined
    || req.body?.customBackgroundPosY !== undefined
    || req.body?.customBackgroundScale !== undefined) {
    const targetUrl = eventBrandingStore.stripBackgroundUrlQuery(
      req.body?.url || eventConfig.customBackgroundUrl
    );
    if (targetUrl) {
      const updated = eventBrandingStore.updateBackgroundEntry(eventConfig, targetUrl, {
        posX: req.body.customBackgroundPosX,
        posY: req.body.customBackgroundPosY,
        scale: req.body.customBackgroundScale
      });
      if (updated) {
        eventConfig.customBackgrounds = updated;
        eventConfig.customBackgroundUrls = updated.map((entry) => entry.url);
        eventConfig.customBackgroundUrl = updated[0]?.url || null;
        Object.assign(eventConfig, eventBrandingStore.primaryBackgroundTransform(updated));
      }
    } else {
      eventConfig.customBackgroundPosX = bgTransform.customBackgroundPosX;
      eventConfig.customBackgroundPosY = bgTransform.customBackgroundPosY;
      eventConfig.customBackgroundScale = bgTransform.customBackgroundScale;
    }
  }

  if (req.body?.circlesPanelTransparent !== undefined) {
    eventConfig.circlesPanelTransparent = !!req.body.circlesPanelTransparent;
  }
  if (req.body?.rankingPanelTransparent !== undefined) {
    eventConfig.rankingPanelTransparent = !!req.body.rankingPanelTransparent;
  }
  if (req.body?.circleSize !== undefined) {
    eventConfig.circleSize = eventBrandingStore.normalizeCircleSize(req.body.circleSize);
  }

  eventConfig = eventBrandingStore.writeEventConfig(eventConfig);
  const payload = getEventPayload();
  io.emit("eventBranding", payload);
  res.json(payload);
});

function handleClearCustomBackground(_req, res) {
  clearStoredCustomBackgroundFiles();
  eventConfig.customBackgroundUrl = null;
  eventConfig.customBackgroundUrls = [];
  eventConfig.customBackgrounds = [];
  if (eventConfig.themeBackground === "custom") {
    eventConfig.themeBackground = themes.defaultBackgroundForPattern(eventConfig.themePattern);
  }
  eventConfig = eventBrandingStore.writeEventConfig(eventConfig);
  const payload = getEventPayload();
  io.emit("eventBranding", payload);
  res.json(payload);
}

function handleDeleteCustomBackground(req, res) {
  const rawUrl = String(req.query?.url || req.body?.url || "").trim();
  if (!rawUrl) {
    res.status(400).json({ error: "Background url is required." });
    return;
  }
  const target = eventBrandingStore.stripBackgroundUrlQuery(rawUrl);
  const backgrounds = eventBrandingStore.normalizeCustomBackgrounds(eventConfig);
  if (!backgrounds.some((entry) => entry.url === target)) {
    res.status(404).json({ error: "Background not found." });
    return;
  }
  deleteStoredBackgroundFile(target);
  const remaining = backgrounds.filter((entry) => entry.url !== target);
  if (!remaining.length) {
    eventConfig.customBackgroundUrl = null;
    eventConfig.customBackgroundUrls = [];
    eventConfig.customBackgrounds = [];
    if (eventConfig.themeBackground === "custom") {
      eventConfig.themeBackground = themes.defaultBackgroundForPattern(eventConfig.themePattern);
    }
  } else {
    eventConfig.customBackgrounds = remaining;
    eventConfig.customBackgroundUrls = remaining.map((entry) => entry.url);
    eventConfig.customBackgroundUrl = remaining[0].url;
    Object.assign(eventConfig, eventBrandingStore.primaryBackgroundTransform(remaining));
  }
  eventConfig = eventBrandingStore.writeEventConfig(eventConfig);
  const payload = getEventPayload();
  io.emit("eventBranding", payload);
  res.json(payload);
}

app.post("/api/event-background/clear", handleClearCustomBackground);
app.delete("/api/event-background", (req, res) => {
  if (req.query?.url || req.body?.url) {
    handleDeleteCustomBackground(req, res);
    return;
  }
  handleClearCustomBackground(req, res);
});

app.post("/api/event-background", backgroundUpload.single("background"), (req, res) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: "Upload a JPG, PNG, or WebP image." });
      return;
    }
    const url = `/event-backgrounds/${req.file.filename}`;
    eventConfig = appendCustomBackgroundUrl(url);
    const payload = getEventPayload();
    io.emit("eventBranding", payload);
    res.json(payload);
  } catch (error) {
    res.status(400).json({ error: error.message || "Could not save background." });
  }
});

app.patch("/api/event-branding/sponsor", (req, res) => {
  const sponsorId = String(req.body?.sponsorId || "").trim();
  if (!sponsorId) {
    res.status(400).json({ error: "Please choose a sponsor shape pack." });
    return;
  }

  const sponsor = sponsors.getSponsorById(sponsorId);
  if (!sponsor) {
    res.status(400).json({ error: "Sponsor not found." });
    return;
  }

  const title = String(req.body?.title || eventConfig.title || "").trim();
  const result = applySponsorToLiveEvent(sponsor, title);
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json(result.payload);
});

app.put("/api/event-branding", (req, res) => {
  const title = String(req.body?.title || "").trim().slice(0, 80);
  const sponsorId = String(req.body?.sponsorId || "").trim();
  const incomingUrls = Array.isArray(req.body?.customBackgroundUrls)
    ? req.body.customBackgroundUrls
    : null;
  const incomingCustomUrl = req.body?.customBackgroundUrl || null;
  const theme = themes.normalizeTheme({
    themePattern: req.body?.themePattern,
    themeBackground: req.body?.themeBackground,
    customBackgroundUrl: incomingCustomUrl || eventConfig.customBackgroundUrl,
    customBackgroundUrls: incomingUrls || eventConfig.customBackgroundUrls
  });
  const incomingBackgrounds = Array.isArray(req.body?.customBackgrounds)
    ? req.body.customBackgrounds
    : null;
  const customBackgrounds = eventBrandingStore.normalizeCustomBackgrounds({
    ...eventConfig,
    customBackgrounds: incomingBackgrounds || eventConfig.customBackgrounds,
    customBackgroundUrls: incomingUrls || eventConfig.customBackgroundUrls,
    customBackgroundUrl: incomingCustomUrl || eventConfig.customBackgroundUrl
  });
  const customBackgroundUrls = customBackgrounds.map((entry) => entry.url);
  const customBackgroundUrl = eventBrandingStore.primaryBackgroundUrl(customBackgrounds);

  if (!title) {
    res.status(400).json({ error: "Event title is required." });
    return;
  }
  if (!sponsorId) {
    res.status(400).json({ error: "Please choose a sponsor shape pack." });
    return;
  }
  if (!themes.isValidPattern(req.body?.themePattern)) {
    res.status(400).json({ error: "Please choose a game screen layout." });
    return;
  }

  const sponsor = sponsors.getSponsorById(sponsorId);
  if (!sponsor) {
    res.status(400).json({ error: "Sponsor not found." });
    return;
  }
  if (sponsor.shapeCount < sponsors.MIN_SHAPES_PER_SPONSOR) {
    res.status(400).json({
      error: `This sponsor needs at least ${sponsors.MIN_SHAPES_PER_SPONSOR} PNG shapes (has ${sponsor.shapeCount}).`
    });
    return;
  }

  if (game.started && !game.ended) {
    cancelGame();
  }

  sponsors.setActiveSponsorId(sponsorId);
  const bgTransform = eventBrandingStore.parseBgTransform(req.body);
  eventConfig = eventBrandingStore.writeEventConfig({
    title,
    sponsorId: sponsor.id,
    sponsorName: sponsor.name,
    themePattern: theme.themePattern,
    themeBackground: theme.themeBackground,
    customBackgroundUrl,
    customBackgroundUrls,
    customBackgrounds,
    ...eventBrandingStore.primaryBackgroundTransform(customBackgrounds),
    circlesPanelTransparent: !!req.body?.circlesPanelTransparent,
    rankingPanelTransparent: !!req.body?.rankingPanelTransparent,
    circleSize: eventBrandingStore.normalizeCircleSize(
      req.body?.circleSize ?? eventConfig.circleSize
    )
  });
  const payload = getEventPayload();
  io.emit("eventBranding", payload);
  emitGameState();
  res.json(payload);
});

app.get("/api/sponsors", (_req, res) => {
  res.json({
    sponsors: sponsors.listSponsors(),
    activeSponsorId: sponsors.getActiveSponsorId(),
    minShapes: sponsors.MIN_SHAPES_PER_SPONSOR
  });
});

app.get("/api/sponsors/:id", (req, res) => {
  const sponsor = sponsors.getSponsorById(req.params.id);
  if (!sponsor) {
    res.status(404).json({ error: "Sponsor not found." });
    return;
  }
  res.json(sponsor);
});

app.post("/api/sponsors", (req, res) => {
  try {
    const sponsor = sponsors.createSponsor(req.body?.name);
    res.status(201).json(sponsor);
  } catch (error) {
    res.status(400).json({ error: error.message || "Could not create sponsor." });
  }
});

app.post(
  "/api/sponsors/:id/shapes",
  shapeUpload.array("shapes", sponsors.MAX_SHAPES_PER_UPLOAD),
  (req, res) => {
    try {
      const files = (req.files || []).map((file) => ({
        buffer: file.buffer,
        originalname: file.originalname
      }));
      if (!files.length) {
        res.status(400).json({ error: "Upload at least one PNG shape." });
        return;
      }
      const sponsor = sponsors.addShapeFiles(req.params.id, files);
      const activeId = sponsors.getActiveSponsorId();
      if (
        sponsor.id === activeId
        && sponsor.shapeCount >= sponsors.MIN_SHAPES_PER_SPONSOR
        && eventConfig.sponsorId !== sponsor.id
        && String(eventConfig.title || "").trim()
      ) {
        applySponsorToLiveEvent(sponsor, eventConfig.title);
      }
      res.json(sponsor);
    } catch (error) {
      res.status(400).json({ error: error.message || "Could not save shapes." });
    }
  }
);

app.delete("/api/sponsors/:id/shapes/:filename", (req, res) => {
  try {
    const sponsor = sponsors.deleteShape(req.params.id, req.params.filename);
    res.json(sponsor);
  } catch (error) {
    res.status(400).json({ error: error.message || "Could not delete shape." });
  }
});

app.get("/api/countries", (_req, res) => {
  const countries = [...countriesByCode.entries()]
    .map(([code, name]) => ({ code, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json(countries);
});

app.get("/api/join-info", (req, res) => {
  const base = getPublicBaseUrl(req);
  const playerUrl = `${base}/mobile`;
  const lanAddresses = IS_PRODUCTION ? [] : getLanAddresses();
  const lanUrls = lanAddresses.map((address) => `http://${address}:${PORT}/mobile`);

  res.json({
    port: PORT,
    playerUrls: [playerUrl, ...lanUrls],
    primaryPlayerUrl: playerUrl,
    hostUrl: `${base}/`,
    isProduction: IS_PRODUCTION
  });
});

app.get("/api/qr", async (req, res, next) => {
  try {
    const text = String(req.query.url || "");
    if (!/^https?:\/\//i.test(text)) {
      res.status(400).send("Invalid url");
      return;
    }
    const png = await QRCode.toBuffer(text, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 320
    });
    res.type("image/png");
    res.set("Cache-Control", "no-store");
    res.send(png);
  } catch (error) {
    next(error);
  }
});

io.on("connection", (socket) => {
  socket.emit("gameState", buildGameStatePayload());
  socket.emit("eventBranding", getEventPayload());
  const lobbyPlayers = [...players.values()].map((player) =>
    toLeaderboardEntry(player, { includePhoto: true })
  );
  if (lobbyPlayers.length) {
    socket.emit("lobbySnapshot", { players: lobbyPlayers });
  }

  socket.on("joinPlayer", (payload) => {
    const playerToken = String(payload?.playerToken || "").trim();
    const rawName = String(payload?.name || "").trim();
    const existing = findPlayerByToken(playerToken);
    const registrationOpen = !game.started || game.ended;

    if (!registrationOpen && !existing) {
      socket.emit("joinError", {
        message: "Game in progress — registration is closed. Wait for the host to start a new game."
      });
      return;
    }

    if (playerToken && !existing && !rawName) {
      socket.emit("joinError", { message: "Session expired. Please register again." });
      return;
    }

    if (existing) {
      if (existing.socketId) {
        const oldSocket = io.sockets.sockets.get(existing.socketId);
        if (oldSocket && oldSocket.id !== socket.id) {
          oldSocket.disconnect(true);
        }
      }
      bindSocketToPlayer(socket, existing);
      socket.emit("joined", {
        id: existing.id,
        token: existing.token,
        name: existing.name,
        countryCode: existing.countryCode,
        countryName: existing.countryName,
        photo: existing.photo,
        score: existing.score
      });
      emitGameState();
      return;
    }

    const cap = effectiveMaxPlayers();
    if (players.size >= cap) {
      socket.emit("joinError", { message: `Game is full (${cap} players max). Try again later.` });
      return;
    }

    const name = rawName.slice(0, 20);
    const countryCode = String(payload?.countryCode || "").toUpperCase();
    const photo = normalizePhoto(payload?.photo);

    if (!name) {
      socket.emit("joinError", { message: "Name is required." });
      return;
    }
    if (!countryCode || !allowedCountryCodes.has(countryCode)) {
      socket.emit("joinError", { message: "Please choose a valid country." });
      return;
    }
    if (!photo) {
      socket.emit("joinError", { message: "Please take or upload a photo." });
      return;
    }

    const countryName = countriesByCode.get(countryCode);
    const player = {
      id: crypto.randomUUID(),
      token: crypto.randomUUID(),
      socketId: null,
      name,
      score: 0,
      photo,
      countryCode,
      countryName,
      roundMistakes: 0
    };
    players.set(player.id, player);
    bindSocketToPlayer(socket, player);
    socket.emit("joined", {
      id: player.id,
      token: player.token,
      name,
      countryCode,
      countryName,
      photo,
      score: player.score
    });
    emitPlayerJoined(player);
    emitGameState();
    appendAudit({
      type: "mobile.player_joined",
      meta: {
        name: player.name,
        countryCode: player.countryCode
      }
    });
  });

  socket.on("hostStartGame", (payload) => {
    const accessCode = socket.data.accessSession?.code || currentDashboardCode();
    if (!accessCode) {
      socket.emit("hostError", { message: "Dashboard access required. Please sign in with your access code." });
      return;
    }
    if (accessCode.disabled) {
      socket.emit("hostError", { message: "This access code is disabled. Contact admin for a new code." });
      return;
    }
    if (accessCode.tier === "demo" && isRealGameRunning()) {
      socket.emit("hostError", { message: DEMO_SUSPEND_MESSAGE });
      return;
    }
    if (userStore.isAccessCodeExpired(accessCode)) {
      socket.emit("hostError", { message: "This access code has expired." });
      return;
    }
    if (!userStore.hasAccessCodeUsesRemaining(accessCode)) {
      socket.emit("hostError", { message: "This access code has no launches remaining." });
      return;
    }
    if (players.size > accessCode.maxPlayers) {
      socket.emit("hostError", {
        message: `This ${accessCode.tier} code allows up to ${accessCode.maxPlayers} players. Current lobby has ${players.size}.`
      });
      return;
    }

    const requestedSponsorId = String(payload?.sponsorId || "").trim();
    const requestedTitle = String(payload?.title || eventConfig.title || "").trim();
    if (requestedSponsorId && requestedSponsorId !== eventConfig.sponsorId) {
      const requestedSponsor = sponsors.getSponsorById(requestedSponsorId);
      if (!requestedSponsor) {
        socket.emit("hostError", { message: "Selected sponsor pack was not found on the server." });
        return;
      }
      const applyResult = applySponsorToLiveEvent(requestedSponsor, requestedTitle);
      if (!applyResult.ok) {
        socket.emit("hostError", { message: applyResult.error });
        return;
      }
    } else {
      syncSponsorSelectionFromEventConfig();
    }

    const liveSponsor = eventConfig.sponsorId
      ? sponsors.getSponsorById(eventConfig.sponsorId)
      : null;
    if (!liveSponsor || liveSponsor.shapeCount < sponsors.MIN_SHAPES_PER_SPONSOR) {
      socket.emit("hostError", {
        message: "Choose a sponsor pack with at least 19 PNG shapes before starting the game."
      });
      return;
    }

    dashboardCodeId = accessCode.id;
    activeGameCodeId = accessCode.id;
    userStore.consumeAccessCodeUse(accessCode.id, {
      playerCount: players.size,
      eventTitle: String(eventConfig.title || "").trim() || "Untitled game"
    });
    const eventTitle = String(eventConfig.title || "").trim() || "Untitled game";
    const authUser = socket.data.authUser || null;
    userStore.recordGameStarted({
      hostUserId: authUser?.id || null,
      hostEmail: authUser?.email || null,
      eventTitle,
      players: [...players.values()].map((player) => ({
        name: player.name,
        countryCode: player.countryCode
      }))
    });
    startGame(accessCode.rounds || TOTAL_ROUNDS);
  });

  socket.on("hostResetGame", () => {
    resetSession();
  });

  socket.on("playerPick", (payload) => {
    if (!game.started || game.ended || game.roundLocked || !game.currentRound) return;

    const player = getPlayerBySocket(socket.id);
    if (!player) return;
    if ((player.roundMistakes || 0) >= MISTAKES_PER_ROUND) return;

    const selectedShape = String(payload?.shape || "");

    if (selectedShape !== game.currentRound.commonShape) {
      player.roundMistakes = (player.roundMistakes || 0) + 1;
      const mistakesRemaining = Math.max(0, MISTAKES_PER_ROUND - player.roundMistakes);
      socket.emit("pickResult", {
        correct: false,
        mistakesUsed: player.roundMistakes,
        mistakesRemaining,
        outOfChances: player.roundMistakes >= MISTAKES_PER_ROUND
      });
      return;
    }

    game.roundLocked = true;
    clearRoundTimer();
    player.score += 1;
    const winner = toLeaderboardEntry(player, { includePhoto: true });

    io.emit("roundWinner", {
      winner,
      correctShape: game.currentRound.commonShape,
      roundNumber: game.roundNumber,
      totalRounds: game.totalRounds
    });
    emitGameState();

    setTimeout(() => {
      if (!game.started || game.ended) return;
      if (game.roundNumber >= game.totalRounds) {
        finishGame();
      } else {
        startRound();
      }
    }, ROUND_WINNER_DISPLAY_MS);
  });

  socket.on("disconnect", () => {
    const player = getPlayerBySocket(socket.id);
    socketToPlayerId.delete(socket.id);
    if (!player) return;

    player.socketId = null;

    if (game.started && !game.ended) {
      emitGameState();
      return;
    }

    players.delete(player.id);
    emitPlayerLeft(player.id);
    emitGameState();
  });
});

function getLanAddresses() {
  const addresses = [];
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const net of interfaces) {
      const isIpv4 = net.family === "IPv4" || net.family === 4;
      if (isIpv4 && !net.internal) {
        addresses.push(net.address);
      }
    }
  }
  return [...new Set(addresses)];
}

app.use((err, _req, res, next) => {
  if (err instanceof multer.MulterError) {
    res.status(400).json({ error: err.message });
    return;
  }
  if (err) {
    res.status(400).json({ error: err.message || "Upload failed." });
    return;
  }
  next();
});

httpServer.on("error", (error) => {
  console.error("Server failed to start:", error);
  process.exit(1);
});

httpServer.listen(PORT, "0.0.0.0", () => {
  const { DATA_DIR } = require("./lib/config");
  const base = PUBLIC_URL || `http://localhost:${PORT}`;

  const bootstrapEmail = process.env.ADMIN_BOOTSTRAP_EMAIL;
  const bootstrapPassword = process.env.ADMIN_BOOTSTRAP_PASSWORD;
  const bootstrapReset = String(process.env.ADMIN_BOOTSTRAP_RESET || "").toLowerCase() === "true";
  if (bootstrapEmail && bootstrapPassword) {
    console.log(
      `Admin bootstrap starting (reset=${bootstrapReset}, email=${userStore.normalizeEmail(bootstrapEmail)})`
    );
    userStore
      .bootstrapAdminAccount({
        email: bootstrapEmail,
        password: bootstrapPassword,
        authLib,
        forceReset: bootstrapReset
      })
      .then((result) => {
        const email = userStore.normalizeEmail(bootstrapEmail);
        if (result.created) {
          console.log(`Admin bootstrap OK: account created for ${email}`);
        } else if (result.reset) {
          console.log(`Admin bootstrap OK: password reset for ${email}`);
        } else if (result.reason === "exists") {
          console.log(
            `Admin bootstrap: account already exists for ${email} — set ADMIN_BOOTSTRAP_RESET=true and redeploy to reset password`
          );
        } else if (result.reason === "not_admin_email") {
          console.warn(
            `Admin bootstrap skipped: ${email} is not in ADMIN_EMAILS (${process.env.ADMIN_EMAILS || "empty"})`
          );
        } else if (result.reason === "invalid") {
          console.warn("Admin bootstrap skipped: email or password invalid (password needs 8+ characters).");
        } else {
          console.log(`Admin bootstrap finished: ${result.reason || "unknown"} (${email})`);
        }
      })
      .catch((err) => {
        console.warn("Admin bootstrap failed:", err.message);
      });
  } else {
    console.log(
      `Admin bootstrap not configured (ADMIN_BOOTSTRAP_EMAIL set=${Boolean(bootstrapEmail)}, ADMIN_BOOTSTRAP_PASSWORD set=${Boolean(bootstrapPassword)})`
    );
  }

  console.log(`Shape Match Game listening on port ${PORT}`);
  console.log(`Data dir: ${DATA_DIR}`);
  console.log(`Host:    ${base}/`);
  console.log(`Players: ${base}/mobile`);
  console.log(`Account: ${base}/account`);
  console.log(`Admin:   ${base}/admin`);
  console.log(`Health:  ${base}/health`);
  console.log(`Max players: ${MAX_PLAYERS}`);
  console.log(`Round timeout: ${ROUND_TIMEOUT_MS}ms`);
  if (!IS_PRODUCTION) {
    const lanAddresses = getLanAddresses();
    if (lanAddresses.length) {
      console.log("LAN player URLs:");
      for (const address of lanAddresses) {
        console.log(`  http://${address}:${PORT}/mobile`);
      }
    }
  }
});

