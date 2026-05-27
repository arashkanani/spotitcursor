const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DATA_DIR } = require("./config");

const STORE_PATH = path.join(DATA_DIR, "users-db.json");
const MAX_ACTIVITY = 3000;
const MAX_DASHBOARD_CONFIG_BYTES = 400 * 1024;

let cache = null;

function defaultStore() {
  return { users: [], dashboards: [], workspaces: [], activity: [] };
}

function readStore() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.users)) parsed.users = [];
    if (!Array.isArray(parsed.dashboards)) parsed.dashboards = [];
    if (!Array.isArray(parsed.workspaces)) parsed.workspaces = [];
    if (!Array.isArray(parsed.activity)) parsed.activity = [];
    cache = parsed;
    return cache;
  } catch (_error) {
    cache = defaultStore();
    return cache;
  }
}

function writeStore(data) {
  try {
    const dir = path.dirname(STORE_PATH);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${STORE_PATH}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 0), "utf8");
    fs.renameSync(tmp, STORE_PATH);
    cache = data;
  } catch (err) {
    cache = null;
    if (err && (err.code === "EACCES" || err.code === "EROFS")) {
      throw new Error(
        "Server cannot save accounts. Set DATA_DIR to a writable folder (e.g. Render persistent disk at /var/data)."
      );
    }
    throw new Error(err?.message || "Could not save account data.");
  }
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
  return {
    id: user.id,
    email: user.email,
    role: isAdminEmail(user.email) ? "admin" : "user",
    createdAt: user.createdAt
  };
}

function findUserByEmail(email) {
  const e = normalizeEmail(email);
  return readStore().users.find((u) => u.email === e) || null;
}

function findUserById(id) {
  return readStore().users.find((u) => u.id === id) || null;
}

function createUser({ email, passwordHash }) {
  const e = normalizeEmail(email);
  if (!e.includes("@") || e.length > 120) {
    throw new Error("Please use a valid email address.");
  }
  const store = readStore();
  if (store.users.some((u) => u.email === e)) {
    throw new Error("An account already exists for this email.");
  }
  const user = {
    id: crypto.randomUUID(),
    email: e,
    passwordHash,
    createdAt: new Date().toISOString()
  };
  store.users.push(user);
  writeStore(store);
  return user;
}

function listUsersPublic() {
  return readStore().users.map((u) => publicUser(u));
}

/** @param {{ userId?: string | null, email?: string | null, type: string, meta?: object }} entry */
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

function assertDashboardConfigSize(config) {
  const s = JSON.stringify(config);
  if (s.length > MAX_DASHBOARD_CONFIG_BYTES) {
    throw new Error("Dashboard data is too large. Remove some background entries or use smaller configs.");
  }
}

function listDashboards(userId) {
  return readStore()
    .dashboards.filter((d) => d.userId === userId)
    .map((d) => ({
      id: d.id,
      name: d.name,
      updatedAt: d.updatedAt
    }))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

function getDashboard(userId, dashboardId) {
  return readStore().dashboards.find((d) => d.userId === userId && d.id === dashboardId) || null;
}

function saveDashboard(userId, name, config) {
  assertDashboardConfigSize(config);
  const trimmed = String(name || "").trim().slice(0, 80);
  if (!trimmed) {
    throw new Error("Dashboard name is required.");
  }
  const store = readStore();
  const now = new Date().toISOString();
  const entry = {
    id: crypto.randomUUID(),
    userId,
    name: trimmed,
    config,
    updatedAt: now
  };
  store.dashboards.push(entry);
  writeStore(store);
  return entry;
}

function deleteDashboard(userId, dashboardId) {
  const store = readStore();
  const before = store.dashboards.length;
  store.dashboards = store.dashboards.filter(
    (d) => !(d.userId === userId && d.id === dashboardId)
  );
  if (store.dashboards.length === before) {
    return false;
  }
  writeStore(store);
  return true;
}

function getUserWorkspace(userId) {
  return readStore().workspaces.find((w) => w.userId === userId) || null;
}

function saveUserWorkspace(userId, config) {
  assertDashboardConfigSize(config);
  const store = readStore();
  const now = new Date().toISOString();
  const entry = { userId, config, updatedAt: now };
  const idx = store.workspaces.findIndex((w) => w.userId === userId);
  if (idx >= 0) {
    store.workspaces[idx] = entry;
  } else {
    store.workspaces.push(entry);
  }
  writeStore(store);
  return entry;
}

module.exports = {
  normalizeEmail,
  isAdminEmail,
  publicUser,
  findUserByEmail,
  findUserById,
  createUser,
  listUsersPublic,
  appendActivity,
  listActivity,
  listDashboards,
  getDashboard,
  saveDashboard,
  deleteDashboard,
  getUserWorkspace,
  saveUserWorkspace,
  MAX_DASHBOARD_CONFIG_BYTES
};
