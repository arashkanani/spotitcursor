const path = require("path");

const PORT = Number(process.env.PORT) || 3001;
const NODE_ENV = process.env.NODE_ENV || "development";
const IS_PRODUCTION = NODE_ENV === "production";

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, "..", "data");

const PUBLIC_URL = process.env.PUBLIC_URL
  ? String(process.env.PUBLIC_URL).replace(/\/$/, "")
  : "";

const MAX_PLAYERS = Number(process.env.MAX_PLAYERS) || 120;

module.exports = {
  PORT,
  NODE_ENV,
  IS_PRODUCTION,
  DATA_DIR,
  PUBLIC_URL,
  MAX_PLAYERS
};
