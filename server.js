const path = require("path");
const fs = require("fs");
const os = require("os");
const express = require("express");
const { createServer } = require("http");
const { Server } = require("socket.io");
const QRCode = require("qrcode");

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  maxHttpBufferSize: 5e6
});
const PORT = 3001;
const TOTAL_ROUNDS = 20;
const MAX_PHOTO_LENGTH = 220000;
const MAX_SPONSOR_LOGO_LENGTH = 180000;
const MAX_SPONSORS = 8;
const ROUND_WINNER_DISPLAY_MS = 4000;

let eventBranding = {
  title: "",
  sponsors: []
};

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

function normalizeSponsorLogo(data) {
  const value = String(data || "");
  if (!/^data:image\/(jpeg|jpg|png|webp|svg\+xml);base64,/i.test(value)) return null;
  if (value.length > MAX_SPONSOR_LOGO_LENGTH) return null;
  return value;
}

function normalizeSponsors(list) {
  if (!Array.isArray(list)) return [];
  const sponsors = [];
  for (let i = 0; i < Math.min(list.length, MAX_SPONSORS); i += 1) {
    const item = list[i] || {};
    const logo = normalizeSponsorLogo(item.logo);
    if (!logo) continue;
    sponsors.push({
      name: String(item.name || "").trim().slice(0, 48) || `Sponsor ${sponsors.length + 1}`,
      logo
    });
  }
  return sponsors;
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
const USER_SHAPES_DIR = "C:\\Users\\Arash1\\.cursor\\projects\\c-test-cursor\\assets";

const FALLBACK_SHAPES = [
  "circle", "square", "triangle", "star", "heart",
  "diamond", "moon", "sun", "cloud", "bolt",
  "hexagon", "cross", "drop", "leaf", "fish",
  "apple", "key", "bell", "flag", "gift"
];

function loadUserShapePool() {
  try {
    if (!fs.existsSync(USER_SHAPES_DIR)) return [];

    const allFiles = fs.readdirSync(USER_SHAPES_DIR)
      .filter((file) => file.toLowerCase().endsWith(".png"));
    const byNumber = new Map();

    for (const file of allFiles) {
      const match = file.match(/_images_(\d+)-/i);
      if (!match) continue;

      const imageNumber = Number(match[1]);
      const fullPath = path.join(USER_SHAPES_DIR, file);
      const mtimeMs = fs.statSync(fullPath).mtimeMs;
      const existing = byNumber.get(imageNumber);
      if (!existing || mtimeMs > existing.mtimeMs) {
        byNumber.set(imageNumber, { file, mtimeMs });
      }
    }

    return [...byNumber.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, value]) => `/uploaded-shapes/${encodeURIComponent(value.file)}`);
  } catch (_error) {
    return [];
  }
}

function getShapePool() {
  const userShapes = loadUserShapePool();
  return userShapes.length >= 19 ? userShapes : FALLBACK_SHAPES;
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

function generateRound() {
  const shapePool = getShapePool();
  const commonShape = shapePool[Math.floor(Math.random() * shapePool.length)];
  const candidates = randomShuffle(shapePool.filter((shape) => shape !== commonShape));

  const leftExtra = candidates.slice(0, 9);
  const rightExtra = candidates.slice(9, 18);
  const leftShapes = randomShuffle([commonShape, ...leftExtra]);
  const rightShapes = randomShuffle([commonShape, ...rightExtra]);

  return { commonShape, leftShapes, rightShapes };
}

function getLeaderboard() {
  return [...players.values()]
    .map(toLeaderboardEntry)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

function emitGameState() {
  const shapePool = getShapePool();
  io.emit("gameState", {
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
    shapePool,
    leaderboard: getLeaderboard(),
    eventBranding
  });
}

function startRound() {
  game.roundNumber += 1;
  game.roundLocked = false;
  game.currentRound = generateRound();
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

app.use(express.json({ limit: "12mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/flags", express.static(path.join(__dirname, "node_modules/flag-icons/flags/4x3")));
app.use("/uploaded-shapes", express.static(USER_SHAPES_DIR));

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "host.html"));
});

app.get("/mobile", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "mobile.html"));
});

app.get("/api/event-branding", (_req, res) => {
  res.json(eventBranding);
});

app.put("/api/event-branding", (req, res) => {
  const title = String(req.body?.title || "").trim().slice(0, 80);
  const sponsors = normalizeSponsors(req.body?.sponsors);

  if (!title) {
    res.status(400).json({ error: "Event title is required." });
    return;
  }

  eventBranding = { title, sponsors };
  io.emit("eventBranding", eventBranding);
  emitGameState();
  res.json(eventBranding);
});

app.get("/api/countries", (_req, res) => {
  const countries = [...countriesByCode.entries()]
    .map(([code, name]) => ({ code, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json(countries);
});

app.get("/api/join-info", (_req, res) => {
  const lanAddresses = getLanAddresses();
  const playerUrls = lanAddresses.map((address) => `http://${address}:${PORT}/mobile`);
  res.json({
    port: PORT,
    playerUrls,
    primaryPlayerUrl: playerUrls[0] || `http://localhost:${PORT}/mobile`
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
    res.send(png);
  } catch (error) {
    next(error);
  }
});

io.on("connection", (socket) => {
  const shapePool = getShapePool();
  socket.emit("gameState", {
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
    shapePool,
    leaderboard: getLeaderboard(),
    eventBranding
  });

  socket.emit("eventBranding", eventBranding);

  socket.on("joinPlayer", (payload) => {
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
      countryName
    });
    socket.emit("joined", { id: socket.id, name, countryCode, countryName, photo });
    emitGameState();
  });

  socket.on("hostStartGame", () => {
    startGame();
  });

  socket.on("playerPick", (payload) => {
    if (!game.started || game.ended || game.roundLocked || !game.currentRound) return;

    const player = players.get(socket.id);
    if (!player) return;
    const selectedShape = String(payload?.shape || "");

    if (selectedShape !== game.currentRound.commonShape) return;

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

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Host screen:  http://localhost:${PORT}/`);
  console.log(`Player page:  http://localhost:${PORT}/mobile`);
  const lanAddresses = getLanAddresses();
  if (lanAddresses.length) {
    console.log("Players on the same Wi-Fi should use:");
    for (const address of lanAddresses) {
      console.log(`  http://${address}:${PORT}/mobile`);
    }
  } else {
    console.log("No LAN IP found — players must be on the same network as this PC.");
  }
});