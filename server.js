const path = require("path");
const fs = require("fs");
const os = require("os");
const express = require("express");
const compression = require("compression");
const multer = require("multer");
const { createServer } = require("http");
const { Server } = require("socket.io");
const QRCode = require("qrcode");
const sponsors = require("./lib/sponsors");
const { PORT, IS_PRODUCTION, PUBLIC_URL, MAX_PLAYERS } = require("./lib/config");

const app = express();
const httpServer = createServer(app);

if (IS_PRODUCTION) {
  app.set("trust proxy", 1);
}

const io = new Server(httpServer, {
  maxHttpBufferSize: 5e6,
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
const ROUND_WINNER_DISPLAY_MS = 4000;
const MISTAKES_PER_ROUND = 3;

let eventConfig = {
  title: "",
  sponsorId: null,
  sponsorName: null
};

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

function toLeaderboardEntry(player) {
  return {
    id: player.id,
    name: player.name,
    score: player.score,
    photo: player.photo,
    countryCode: player.countryCode,
    countryName: player.countryName
  };
}

function getShapePool() {
  return sponsors.getShapePool(eventConfig.sponsorId);
}

function getEventPayload() {
  const sponsor = eventConfig.sponsorId
    ? sponsors.getSponsorById(eventConfig.sponsorId)
    : null;
  return {
    title: eventConfig.title,
    sponsorId: eventConfig.sponsorId,
    sponsorName: eventConfig.sponsorName,
    sponsorShapeCount: sponsor ? sponsor.shapeCount : 0,
    sponsorReady: sponsor ? sponsor.shapeCount >= sponsors.MIN_SHAPES_PER_SPONSOR : false
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
let game = createNewGame();

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

function getLeaderboard() {
  return [...players.values()]
    .map(toLeaderboardEntry)
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
    eventBranding: getEventPayload(),
    eventConfig: getEventPayload()
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
  game.roundNumber += 1;
  game.roundLocked = false;
  game.currentRound = generateRound();
  resetRoundMistakes();
  emitGameState();
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
  game.ended = true;
  game.started = false;
  game.roundLocked = true;
  io.emit("gameOver", { leaderboard: getLeaderboard() });
  emitGameState();
}

function cancelGame() {
  players.forEach((player) => {
    player.score = 0;
    player.roundMistakes = 0;
  });
  game = createNewGame();
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

app.get("/api/event-branding", (_req, res) => {
  res.json(getEventPayload());
});

app.put("/api/event-branding", (req, res) => {
  const title = String(req.body?.title || "").trim().slice(0, 80);
  const sponsorId = String(req.body?.sponsorId || "").trim();

  if (!title) {
    res.status(400).json({ error: "Event title is required." });
    return;
  }
  if (!sponsorId) {
    res.status(400).json({ error: "Please choose a sponsor shape pack." });
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

  sponsors.setActiveSponsorId(sponsorId);
  eventConfig = {
    title,
    sponsorId: sponsor.id,
    sponsorName: sponsor.name
  };
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

  socket.on("joinPlayer", (payload) => {
    if (players.size >= MAX_PLAYERS) {
      socket.emit("joinError", { message: "Game is full. Try again in a moment." });
      return;
    }

    const rawName = String(payload?.name || "").trim();
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
    players.set(socket.id, {
      id: socket.id,
      name,
      score: 0,
      photo,
      countryCode,
      countryName,
      roundMistakes: 0
    });
    socket.emit("joined", { id: socket.id, name, countryCode, countryName, photo });
    emitGameState();
  });

  socket.on("hostStartGame", () => {
    startGame();
  });

  socket.on("hostResetGame", () => {
    cancelGame();
  });

  socket.on("playerPick", (payload) => {
    if (!game.started || game.ended || game.roundLocked || !game.currentRound) return;

    const player = players.get(socket.id);
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
    player.score += 1;
    const winner = toLeaderboardEntry(player);

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
    players.delete(socket.id);
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

