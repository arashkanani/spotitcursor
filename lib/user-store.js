const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DATA_DIR } = require("./config");

const STORE_PATH = path.join(DATA_DIR, "users-db.json");

let cache = null;

function defaultStore() {
  return { users: [] };
}

function readStore() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.users)) parsed.users = [];
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

function publicUser(user) {
  if (!user) return null;
  const providers = [];
  if (user.passwordHash) providers.push("password");
  if (user.googleId) providers.push("google");
  return {
    id: user.id,
    email: user.email,
    role: isAdminEmail(user.email) ? "admin" : "user",
    createdAt: user.createdAt,
    providers
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
    createdAt: new Date().toISOString()
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
    return user;
  }

  user = {
    id: crypto.randomUUID(),
    email: e,
    passwordHash: null,
    googleId: gid,
    createdAt: new Date().toISOString()
  };
  store.users.push(user);
  writeStore(store);
  return user;
}

module.exports = {
  normalizeEmail,
  isAdminEmail,
  publicUser,
  findUserByEmail,
  findUserById,
  findUserByGoogleId,
  createUser,
  findOrCreateGoogleUser
};
