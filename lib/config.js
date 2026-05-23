const path = require("path");
const fs = require("fs");

const PORT = Number(process.env.PORT) || 3001;
const NODE_ENV = process.env.NODE_ENV || "development";
const IS_PRODUCTION = NODE_ENV === "production";

function resolveDataDir() {
  const candidates = [
    process.env.DATA_DIR,
    path.join(__dirname, "..", "data")
  ]
    .filter(Boolean)
    .map((dir) => path.resolve(dir));

  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch (_error) {
      // Try next location (e.g. /var/data when disk is not mounted yet).
    }
  }

  const fallback = path.join(__dirname, "..", "data");
  fs.mkdirSync(fallback, { recursive: true });
  return fallback;
}

const DATA_DIR = resolveDataDir();

const PUBLIC_URL = String(
  process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || ""
).replace(/\/$/, "");

const MAX_PLAYERS = Number(process.env.MAX_PLAYERS) || 120;
const ROUND_TIMEOUT_MS = Number(process.env.ROUND_TIMEOUT_MS) || 60000;

module.exports = {
  PORT,
  NODE_ENV,
  IS_PRODUCTION,
  DATA_DIR,
  PUBLIC_URL,
  MAX_PLAYERS,
  ROUND_TIMEOUT_MS
};
