const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const express = require("express");
const compression = require("compression");
const multer = require("multer");
const { createServer } = require("http");
const { Server } = require("socket.io");
const QRCode = require("qrcode");
const sponsors = require("./lib/sponsors");
const eventBrandingStore = require("./lib/event-branding");
const themes = require("./lib/themes");
const { PORT, IS_PRODUCTION, PUBLIC_URL, MAX_PLAYERS, ROUND_TIMEOUT_MS } = require("./lib/config");

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

const TOTAL_ROUNDS = 20;
const MOBILE_SHAPES_PER_ROUND = 18;
const MAX_PHOTO_LENGTH = 220000;
const ROUND_WINNER_OVERLAY_DELAY_MS = 2000;
const ROUND_WINNER_OVERLAY_DURATION_MS = 4000;
const ROUND_WINNER_DISPLAY_MS = ROUND_WINNER_OVERLAY_DELAY_MS + ROUND_WINNER_OVERLAY_DURATION_MS;
const MISTAKES_PER_ROUND = 3;

let eventConfig = eventBrandingStore.readEventConfig();

const { DATA_DIR } = require("./lib/config");
const BACKGROUNDS_DIR = path.join(DATA_DIR, "backgrounds");
fs.mkdirSync(BACKGROUNDS_DIR, { recursive: true });

const backgroundUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, BACKGROUNDS_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `event-background${ext === ".png" || ext === ".webp" || ext === ".jpg" || ext === ".jpeg" ? ext : ".jpg"}`);
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
  return {
    title: eventConfig.title,
    sponsorId: eventConfig.sponsorId,
    sponsorName: eventConfig.sponsorName,
    sponsorShapeCount: sponsor ? sponsor.shapeCount : 0,
    sponsorReady: sponsor ? sponsor.shapeCount >= sponsors.MIN_SHAPES_PER_SPONSOR : false,
    themePattern: theme.themePattern,
    themeBackground: theme.themeBackground,
    customBackgroundUrl:
      theme.themeBackground === "custom" ? eventConfig.customBackgroundUrl || null : null,
    circlesPanelTransparent: !!eventConfig.circlesPanelTransparent,
    rankingPanelTransparent: !!eventConfig.rankingPanelTransparent
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

const players = new Map();
const socketToPlayerId = new Map();
let game = createNewGame();
let roundTimer = null;

function createNewGame() {
  return {
    started: false,
    ended: false,
    roundNumber: 0,
    totalRounds: TOTAL_ROUNDS,
    currentRound: null,
    roundLocked: false
  };
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
    leaderboard: getLeaderboard(),
    playerCount: players.size,
    registrationOpen: !game.started || game.ended
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

function startGame() {
  players.forEach((player) => {
    player.score = 0;
  });
  game = createNewGame();
  game.started = true;
  startRound();
}

function finishGame() {
  clearRoundTimer();
  game.ended = true;
  game.started = false;
  game.roundLocked = true;
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
  io.emit("lobbyCleared");
  emitGameState();
}

app.use(compression());
app.use(express.json({ limit: "12mb" }));
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
  maxAge: IS_PRODUCTION ? "1h" : 0
}));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    players: players.size,
    maxPlayers: MAX_PLAYERS,
    uptime: Math.floor(process.uptime())
  });
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "host.html"));
});

app.get("/mobile", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "mobile.html"));
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

function clearStoredCustomBackgroundFiles() {
  if (!fs.existsSync(BACKGROUNDS_DIR)) return;
  for (const file of fs.readdirSync(BACKGROUNDS_DIR)) {
    if (/^event-background\.(png|jpe?g|webp)$/i.test(file)) {
      try {
        fs.unlinkSync(path.join(BACKGROUNDS_DIR, file));
      } catch (_error) {
        // Ignore delete errors.
      }
    }
  }
}

app.patch("/api/event-branding/theme", (req, res) => {
  const pattern = String(req.body?.themePattern || "").trim();
  const background = String(req.body?.themeBackground || "").trim();

  if (pattern && themes.isValidPattern(pattern)) {
    eventConfig.themePattern = pattern;
  }

  if (background === "custom") {
    eventConfig.themeBackground = "custom";
  } else if (background && themes.isValidBackground(background) && background !== "custom") {
    eventConfig.themeBackground = background;
    eventConfig.customBackgroundUrl = null;
    clearStoredCustomBackgroundFiles();
  }

  eventConfig = eventBrandingStore.writeEventConfig(eventConfig);
  const payload = getEventPayload();
  io.emit("eventBranding", payload);
  res.json(payload);
});

function handleClearCustomBackground(_req, res) {
  clearStoredCustomBackgroundFiles();
  eventConfig.customBackgroundUrl = null;
  if (eventConfig.themeBackground === "custom") {
    eventConfig.themeBackground = themes.defaultBackgroundForPattern(eventConfig.themePattern);
  }
  eventConfig = eventBrandingStore.writeEventConfig(eventConfig);
  const payload = getEventPayload();
  io.emit("eventBranding", payload);
  res.json(payload);
}

app.post("/api/event-background/clear", handleClearCustomBackground);
app.delete("/api/event-background", handleClearCustomBackground);

app.post("/api/event-background", backgroundUpload.single("background"), (req, res) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: "Upload a JPG, PNG, or WebP image." });
      return;
    }
    const ext = path.extname(req.file.filename).toLowerCase() || ".jpg";
    const url = `/event-backgrounds/event-background${ext}`;
    eventConfig.customBackgroundUrl = url;
    eventConfig.themeBackground = "custom";
    eventBrandingStore.writeEventConfig(eventConfig);
    const payload = getEventPayload();
    io.emit("eventBranding", payload);
    res.json(payload);
  } catch (error) {
    res.status(400).json({ error: error.message || "Could not save background." });
  }
});

app.put("/api/event-branding", (req, res) => {
  const title = String(req.body?.title || "").trim().slice(0, 80);
  const sponsorId = String(req.body?.sponsorId || "").trim();
  const incomingCustomUrl = req.body?.customBackgroundUrl || null;
  const theme = themes.normalizeTheme({
    themePattern: req.body?.themePattern,
    themeBackground: req.body?.themeBackground,
    customBackgroundUrl: incomingCustomUrl || eventConfig.customBackgroundUrl
  });
  const customBackgroundUrl = theme.themeBackground === "custom"
    ? (incomingCustomUrl || eventConfig.customBackgroundUrl)
    : null;

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
  eventConfig = eventBrandingStore.writeEventConfig({
    title,
    sponsorId: sponsor.id,
    sponsorName: sponsor.name,
    themePattern: theme.themePattern,
    themeBackground: theme.themeBackground,
    customBackgroundUrl,
    circlesPanelTransparent: !!req.body?.circlesPanelTransparent,
    rankingPanelTransparent: !!req.body?.rankingPanelTransparent
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

    if (players.size >= MAX_PLAYERS) {
      socket.emit("joinError", { message: "Game is full. Try again in a moment." });
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
  });

  socket.on("hostStartGame", () => {
    startGame();
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
  console.log(`Shape Match Game listening on port ${PORT}`);
  console.log(`Data dir: ${DATA_DIR}`);
  console.log(`Host:    ${base}/`);
  console.log(`Players: ${base}/mobile`);
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

