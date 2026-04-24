const path = require("path");
const fs = require("fs");
const express = require("express");
const { createServer } = require("http");
const { Server } = require("socket.io");

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);
const PORT = 3001;
const TOTAL_ROUNDS = 20;
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
    .map((player) => ({ id: player.id, name: player.name, score: player.score }))
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
    leaderboard: getLeaderboard()
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

app.use(express.static(path.join(__dirname, "public")));
app.use("/uploaded-shapes", express.static(USER_SHAPES_DIR));

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "host.html"));
});

app.get("/mobile", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "mobile.html"));
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
    leaderboard: getLeaderboard()
  });

  socket.on("joinPlayer", (payload) => {
    const rawName = String(payload?.name || "").trim();
    const name = rawName.slice(0, 20);
    if (!name) {
      socket.emit("joinError", { message: "Name is required." });
      return;
    }
    players.set(socket.id, { id: socket.id, name, score: 0 });
    socket.emit("joined", { id: socket.id, name });
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
    const winner = { id: player.id, name: player.name, score: player.score };

    io.emit("roundWinner", {
      winner,
      correctShape: game.currentRound.commonShape,
      roundNumber: game.roundNumber
    });
    emitGameState();

    setTimeout(() => {
      if (game.roundNumber >= game.totalRounds) {
        finishGame();
      } else {
        startRound();
      }
    }, 1200);
  });

  socket.on("disconnect", () => {
    players.delete(socket.id);
    emitGameState();
  });
});

httpServer.listen(PORT, () => {
  console.log(`Game server running at http://localhost:${PORT}`);
});