const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const dataSponsors = path.join(root, "data", "sponsors");
const dataIndex = path.join(root, "data", "sponsors-index.json");
const seedSponsors = path.join(root, "seed", "sponsors");
const seedIndex = path.join(root, "seed", "sponsors-index.json");

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(from, to);
    } else {
      fs.copyFileSync(from, to);
    }
  }
}

if (!fs.existsSync(dataSponsors) || !fs.existsSync(dataIndex)) {
  console.error("Missing data/sponsors or data/sponsors-index.json — upload shapes locally first.");
  process.exit(1);
}

fs.rmSync(seedSponsors, { recursive: true, force: true });
copyDirRecursive(dataSponsors, seedSponsors);
fs.copyFileSync(dataIndex, seedIndex);
console.log("Updated seed/ from data/ — commit seed/ and push to deploy shapes on Render.");
