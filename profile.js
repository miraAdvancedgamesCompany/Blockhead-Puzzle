// ═══════════════════════════════════════
//  Profile System
// ═══════════════════════════════════════
import { getCurrentUser, getCurrentUserData, getGuestDaysLeft } from './auth.js';
import { getRankFromPoints, formatNumber, RANKS } from './ranking.js';

export function renderProfile() {
  const userData = getCurrentUserData();
  if (!userData) return;

  const usernameEl = document.getElementById('profile-name');
  const idEl = document.getElementById('profile-id');
  if (usernameEl) usernameEl.textContent = userData.username || 'Unknown';
  if (idEl) idEl.textContent = 'ID: ' + (userData.playerId || '--------');

  const rankStats = userData.rankStats || { totalPoints: 0, totalRowsCleared: 0, totalWins: 0 };
  const stats = userData.stats || { gamesPlayed: 0, wins: 0, losses: 0 };

  const currentPoints = rankStats.totalPoints || 0;
  const currentRank = getRankFromPoints(currentPoints);

  // Update Rank Card in Profile
  const rankBadgeEl = document.getElementById('profile-rank-badge');
  const rankNameEl = document.getElementById('profile-rank-name');
  const rankPtsEl = document.getElementById('profile-rank-pts');
  const rankFillEl = document.getElementById('rank-progress-fill');
  const rankHintEl = document.getElementById('rank-progress-hint');

  if (rankBadgeEl) rankBadgeEl.textContent = currentRank.badge;
  if (rankNameEl) {
    rankNameEl.textContent = currentRank.name;
    rankNameEl.style.color = currentRank.color;
  }
  if (rankPtsEl) rankPtsEl.textContent = `${formatNumber(currentPoints)} Points`;

  // Calculate progress to next rank
  if (rankFillEl && rankHintEl) {
    const nextRank = RANKS[currentRank.index + 1];
    if (nextRank) {
      const rankRange = nextRank.min - currentRank.min;
      const rankProgress = Math.max(0, Math.min(100, Math.round(((currentPoints - currentRank.min) / rankRange) * 100)));
      rankFillEl.style.width = `${rankProgress}%`;
      rankFillEl.style.background = `linear-gradient(90deg, ${currentRank.color}, ${nextRank.color})`;
      const needed = nextRank.min - currentPoints;
      rankHintEl.textContent = `Next: ${nextRank.badge} ${nextRank.name} (needs ${formatNumber(needed)} pts)`;
    } else {
      rankFillEl.style.width = '100%';
      rankFillEl.style.background = currentRank.color;
      rankHintEl.textContent = '🏆 Maximum Rank (Top1)';
    }
  }

  // Update Stats
  const statPointsEl = document.getElementById('stat-points');
  const statRowsEl = document.getElementById('stat-rows');
  const statWinsEl = document.getElementById('stat-wins');
  const statPlayedEl = document.getElementById('stat-played');

  if (statPointsEl) statPointsEl.textContent = formatNumber(currentPoints);
  if (statRowsEl) statRowsEl.textContent = formatNumber(rankStats.totalRowsCleared || 0);
  if (statWinsEl) statWinsEl.textContent = rankStats.totalWins || stats.wins || 0;
  if (statPlayedEl) statPlayedEl.textContent = stats.gamesPlayed || 0;

  const total = stats.gamesPlayed || 0;
  const wins = stats.wins || rankStats.totalWins || 0;
  const winRate = total > 0 ? Math.round((wins / total) * 100) : 0;

  const statWinrateEl = document.getElementById('stat-winrate');
  const winrateFillEl = document.getElementById('winrate-fill');
  if (statWinrateEl) statWinrateEl.textContent = winRate + '%';
  if (winrateFillEl) winrateFillEl.style.width = winRate + '%';

  // Guest warning
  const guestWarn = document.getElementById('guest-warning');
  if (guestWarn) {
    if (userData.isGuest) {
      const daysLeft = getGuestDaysLeft(userData);
      const daysLeftEl = document.getElementById('guest-days-left');
      if (daysLeftEl) daysLeftEl.textContent = daysLeft;
      guestWarn.classList.remove('hidden');
    } else {
      guestWarn.classList.add('hidden');
    }
  }
}

export function updateMenuUserInfo() {
  const userData = getCurrentUserData();
  if (!userData) return;

  const usernameEl = document.getElementById('menu-username');
  const idEl = document.getElementById('menu-player-id');
  const badgeEl = document.getElementById('menu-rank-badge');
  const pointsEl = document.getElementById('menu-user-points');

  if (usernameEl) usernameEl.textContent = userData.username || 'Player';
  if (idEl) idEl.textContent = 'ID: ' + (userData.playerId || '--------');

  const rankStats = userData.rankStats || { totalPoints: 0 };
  const rank = getRankFromPoints(rankStats.totalPoints || 0);

  if (badgeEl) {
    badgeEl.textContent = `${rank.badge} ${rank.name}`;
    badgeEl.style.borderColor = rank.color;
    badgeEl.style.color = rank.color;
  }
  if (pointsEl) {
    pointsEl.textContent = `⭐ ${formatNumber(rankStats.totalPoints || 0)} pts`;
  }
}
