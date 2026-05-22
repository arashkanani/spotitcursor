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
