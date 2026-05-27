const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DATA_DIR } = require("./config");

const STORE_PATH = path.join(DATA_DIR, "users-db.json");
const MAX_ACTIVITY = 3000;
const MAX_GAME_NAMES_PER_RECORD = 40;

let cache = null;

function defaultStore() {
  return { users: [], mobilePlayers: [], activity: [] };
}

function readStore() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.users)) parsed.users = [];
    if (!Array.isArray(parsed.mobilePlayers)) parsed.mobilePlayers = [];
    if (!Array.isArray(parsed.activity)) parsed.activity = [];
    cache = parsed;
    return cache;
  } catch (_error) {
    cache = defaultStore();
    return cache;
  }
}

function writeStore(data) {
  const dir = path.dirname(STORE_PATH);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${STORE_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 0), "utf8");
  fs.renameSync(tmp, STORE_PATH);
  cache = data;
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function normalizePlayerName(name) {
  return String(name || "").trim().toLowerCase().slice(0, 40);
}

function adminEmailSet() {
  const raw = process.env.ADMIN_EMAILS || process.env.ADMIN_EMAIL || "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

function isAdminEmail(email) {
  const e = normalizeEmail(email);
  return e && adminEmailSet().has(e);
}

function ensureUserStats(user) {
  if (!user.stats || typeof user.stats !== "object") {
    user.stats = { gamesPlayed: 0, gameNames: [] };
  }
  if (!Array.isArray(user.stats.gameNames)) {
    user.stats.gameNames = [];
  }
  if (typeof user.stats.gamesPlayed !== "number") {
    user.stats.gamesPlayed = 0;
  }
  return user.stats;
}

function pushGameName(list, title) {
  const name = String(title || "").trim().slice(0, 80) || "Untitled game";
  const next = [name, ...list.filter((entry) => entry !== name)];
  return next.slice(0, MAX_GAME_NAMES_PER_RECORD);
}

function publicUser(user) {
  if (!user) return null;
  const providers = [];
  if (user.passwordHash) providers.push("password");
  if (user.googleId) providers.push("google");
  const stats = ensureUserStats(user);
  return {
    id: user.id,
    email: user.email,
    role: isAdminEmail(user.email) ? "admin" : "user",
    createdAt: user.createdAt,
    providers,
    gamesPlayed: stats.gamesPlayed,
    gameNames: [...stats.gameNames]
  };
}

function findUserByEmail(email) {
  const e = normalizeEmail(email);
  return readStore().users.find((u) => u.email === e) || null;
}

function findUserById(id) {
  return readStore().users.find((u) => u.id === id) || null;
}

function findUserByGoogleId(googleId) {
  const gid = String(googleId || "").trim();
  if (!gid) return null;
  return readStore().users.find((u) => u.googleId === gid) || null;
}

function createUser({ email, passwordHash }) {
  const e = normalizeEmail(email);
  if (!e.includes("@") || e.length > 120) {
    throw new Error("Please use a valid email address.");
  }
  const store = readStore();
  const existing = store.users.find((u) => u.email === e);
  if (existing) {
    if (existing.googleId && !existing.passwordHash) {
      throw new Error("This email uses Google sign-in. Use Continue with Google.");
    }
    throw new Error("An account already exists for this email.");
  }
  const user = {
    id: crypto.randomUUID(),
    email: e,
    passwordHash,
    googleId: null,
    createdAt: new Date().toISOString(),
    stats: { gamesPlayed: 0, gameNames: [] }
  };
  store.users.push(user);
  writeStore(store);
  return user;
}

function findOrCreateGoogleUser({ googleId, email }) {
  const gid = String(googleId || "").trim();
  const e = normalizeEmail(email);
  if (!gid) throw new Error("Invalid Google account.");
  if (!e.includes("@")) throw new Error("Please use a valid email address.");

  const store = readStore();
  let user = store.users.find((u) => u.googleId === gid) || store.users.find((u) => u.email === e);

  if (user) {
    if (user.googleId && user.googleId !== gid) {
      throw new Error("This email is linked to a different Google account.");
    }
    if (!user.googleId) {
      user.googleId = gid;
      writeStore(store);
    }
    ensureUserStats(user);
    return user;
  }

  user = {
    id: crypto.randomUUID(),
    email: e,
    passwordHash: null,
    googleId: gid,
    createdAt: new Date().toISOString(),
    stats: { gamesPlayed: 0, gameNames: [] }
  };
  store.users.push(user);
  writeStore(store);
  return user;
}

function appendActivity(entry) {
  const store = readStore();
  store.activity.push({
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    userId: entry.userId || null,
    email: entry.email ? normalizeEmail(entry.email) : null,
    type: String(entry.type || "unknown"),
    meta: entry.meta && typeof entry.meta === "object" ? entry.meta : {}
  });
  if (store.activity.length > MAX_ACTIVITY) {
    store.activity = store.activity.slice(-MAX_ACTIVITY);
  }
  writeStore(store);
}

function listActivity({ limit = 100, offset = 0 } = {}) {
  const store = readStore();
  const slice = [...store.activity].reverse();
  const lim = Math.min(500, Math.max(1, Number(limit) || 100));
  const off = Math.max(0, Number(offset) || 0);
  return {
    total: store.activity.length,
    items: slice.slice(off, off + lim)
  };
}

function recordMobilePlayerSession({ displayName, countryCode, eventTitle }) {
  const name = String(displayName || "").trim().slice(0, 20);
  if (!name) return;
  const nameKey = normalizePlayerName(name);
  const store = readStore();
  let row = store.mobilePlayers.find((p) => p.nameKey === nameKey);
  const now = new Date().toISOString();
  const title = String(eventTitle || "").trim().slice(0, 80) || "Untitled game";

  if (!row) {
    row = {
      id: crypto.randomUUID(),
      nameKey,
      displayName: name,
      countryCode: countryCode || null,
      gamesPlayed: 0,
      gameNames: [],
      firstSeenAt: now,
      lastPlayedAt: now
    };
    store.mobilePlayers.push(row);
  }

  row.displayName = name;
  if (countryCode) row.countryCode = countryCode;
  row.gamesPlayed += 1;
  row.gameNames = pushGameName(row.gameNames, title);
  row.lastPlayedAt = now;
  writeStore(store);
}

function recordGameStarted({ hostUserId, hostEmail, eventTitle, players }) {
  const store = readStore();
  const title = String(eventTitle || "").trim().slice(0, 80) || "Untitled game";
  const now = new Date().toISOString();
  let changed = false;

  if (hostUserId) {
    const host = store.users.find((u) => u.id === hostUserId);
    if (host) {
      const stats = ensureUserStats(host);
      stats.gamesPlayed += 1;
      stats.gameNames = pushGameName(stats.gameNames, title);
      stats.lastPlayedAt = now;
      changed = true;
    }
  }

  for (const player of players || []) {
    recordMobilePlayerSession({
      displayName: player.name,
      countryCode: player.countryCode,
      eventTitle: title
    });
  }

  if (changed) {
    writeStore(store);
  }

  appendActivity({
    userId: hostUserId || null,
    email: hostEmail || null,
    type: "game.started",
    meta: {
      eventTitle: title,
      playerCount: (players || []).length,
      hostSignedIn: Boolean(hostUserId)
    }
  });
}

function listUsersPublic() {
  return readStore()
    .users.map((u) => publicUser(u))
    .sort((a, b) => (a.email < b.email ? -1 : 1));
}

function listMobilePlayersAdmin() {
  return readStore()
    .mobilePlayers.map((p) => ({
      id: p.id,
      displayName: p.displayName,
      countryCode: p.countryCode,
      gamesPlayed: p.gamesPlayed || 0,
      gameNames: [...(p.gameNames || [])],
      firstSeenAt: p.firstSeenAt,
      lastPlayedAt: p.lastPlayedAt
    }))
    .sort((a, b) => (b.gamesPlayed || 0) - (a.gamesPlayed || 0));
}

function getAdminSummary() {
  const store = readStore();
  const accountGames = store.users.reduce(
    (sum, u) => sum + (ensureUserStats(u).gamesPlayed || 0),
    0
  );
  const mobileGames = store.mobilePlayers.reduce(
    (sum, p) => sum + (p.gamesPlayed || 0),
    0
  );
  return {
    registeredUsers: store.users.length,
    mobilePlayers: store.mobilePlayers.length,
    accountGamesHosted: accountGames,
    mobileGameSessions: mobileGames,
    activityEntries: store.activity.length
  };
}

async function bootstrapAdminAccount({ email, password, authLib }) {
  const e = normalizeEmail(email);
  const pass = String(password || "");
  if (!e || !pass || pass.length < 8) return { created: false, reason: "invalid" };
  if (!isAdminEmail(e)) return { created: false, reason: "not_admin_email" };
  const existing = findUserByEmail(e);
  if (existing) return { created: false, reason: "exists" };
  const passwordHash = await authLib.hashPassword(pass);
  createUser({ email: e, passwordHash });
  appendActivity({ email: e, type: "auth.bootstrap", meta: {} });
  return { created: true };
}

module.exports = {
  normalizeEmail,
  normalizePlayerName,
  isAdminEmail,
  publicUser,
  findUserByEmail,
  findUserById,
  findUserByGoogleId,
  createUser,
  findOrCreateGoogleUser,
  appendActivity,
  listActivity,
  recordGameStarted,
  listUsersPublic,
  listMobilePlayersAdmin,
  getAdminSummary,
  bootstrapAdminAccount
};
