let gameAudioContext = null;

function getGameAudioContext() {
  if (!gameAudioContext) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
    gameAudioContext = new AudioCtx();
  }
  return gameAudioContext;
}

function primeGameAudio() {
  const ctx = getGameAudioContext();
  if (!ctx) return;
  if (ctx.state === "suspended") void ctx.resume();
}

function playRoundWinSound() {
  try {
    const ctx = getGameAudioContext();
    if (!ctx) return;
    if (ctx.state === "suspended") void ctx.resume();

    const now = ctx.currentTime;
    const melody = [
      { freq: 523.25, at: 0, dur: 0.14 },
      { freq: 659.25, at: 0.11, dur: 0.14 },
      { freq: 783.99, at: 0.22, dur: 0.14 },
      { freq: 1046.5, at: 0.33, dur: 0.42 }
    ];
    const chord = [523.25, 659.25, 783.99];

    function tone(freq, start, duration, volume, type) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type || "triangle";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(volume, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + duration + 0.05);
    }

    for (const note of melody) {
      tone(note.freq, now + note.at, note.dur, 0.2, "triangle");
      tone(note.freq * 2, now + note.at, note.dur * 0.55, 0.06, "sine");
    }

    const chordStart = now + 0.48;
    for (const freq of chord) {
      tone(freq, chordStart, 0.55, 0.1, "sine");
    }
  } catch (_err) {
    // Ignore if audio is blocked or unavailable.
  }
}

const FALLBACK_SHAPE_ICONS = {
  circle: "⭕",
  square: "⬜",
  triangle: "🔺",
  star: "⭐",
  heart: "❤️",
  diamond: "💎",
  moon: "🌙",
  sun: "☀️",
  cloud: "☁️",
  bolt: "⚡",
  hexagon: "⬡",
  cross: "✖️",
  drop: "💧",
  leaf: "🍃",
  fish: "🐟",
  apple: "🍎",
  key: "🔑",
  bell: "🔔",
  flag: "🚩",
  gift: "🎁"
};

function isShapeImageUrl(shape) {
  const value = String(shape || "");
  return (
    value.startsWith("/") ||
    value.startsWith("http://") ||
    value.startsWith("https://") ||
    value.startsWith("data:")
  );
}

function shapeIconChar(shape) {
  const key = String(shape || "").toLowerCase();
  return FALLBACK_SHAPE_ICONS[key] || "⬤";
}

function renderShapeElement(shape, imgClass) {
  const className = imgClass || "shape-photo";
  if (isShapeImageUrl(shape)) {
    const src = escapeHtml(shape);
    return `<img class="${className}" src="${src}" alt="shape">`;
  }
  return `<span class="shape-icon">${shapeIconChar(shape)}</span>`;
}

function mountShapeContent(parentEl, shape, imgClass) {
  parentEl.innerHTML = renderShapeElement(shape, imgClass);
  if (!isShapeImageUrl(shape)) return;
  const img = parentEl.querySelector("img");
  if (!img) return;
  img.addEventListener("error", () => {
    parentEl.innerHTML = `<span class="shape-icon">${shapeIconChar(shape)}</span>`;
  });
}

function countryFlagUrl(code) {
  if (!code || String(code).length !== 2) return "";
  return `/flags/${String(code).toLowerCase()}.svg`;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderCountryFlagImg(code, countryName) {
  const url = countryFlagUrl(code);
  if (!url) return "";
  const alt = escapeHtml(countryName || code);
  return `<img class="player-flag-img" src="${url}" alt="${alt}" width="32" height="24" loading="lazy">`;
}

function renderPlayerProfile(player) {
  const safeName = escapeHtml(player.name || "Player");
  const photoHtml = player.photo
    ? `<img class="player-avatar" src="${player.photo}" alt="">`
    : `<span class="player-avatar player-avatar-placeholder" aria-hidden="true">?</span>`;
  const flagHtml = player.countryCode
    ? renderCountryFlagImg(player.countryCode, player.countryName)
    : "";
  return `<span class="player-profile">${photoHtml}${flagHtml}<span class="player-name">${safeName}</span></span>`;
}

function renderLeaderboardItem(player, index) {
  const rank = index + 1;
  let rankClass = "";
  if (index === 0) rankClass = "rank-first";
  else if (index === 1) rankClass = "rank-second";
  else if (index === 2) rankClass = "rank-third";

  const badgeContent = index === 0
    ? '<span class="rank-medal" aria-hidden="true">🥇</span>'
    : index === 1
      ? '<span class="rank-medal" aria-hidden="true">🥈</span>'
      : index === 2
        ? '<span class="rank-medal" aria-hidden="true">🥉</span>'
        : `<span class="rank-num">${rank}</span>`;

  return `
    <div class="leaderboard-row ${rankClass}">
      <div class="rank-badge">${badgeContent}</div>
      <div class="rank-player">${renderPlayerProfile(player)}</div>
      <div class="rank-score">
        <span class="rank-score-num">${player.score}</span>
        <span class="rank-score-unit">pts</span>
      </div>
    </div>
  `;
}
