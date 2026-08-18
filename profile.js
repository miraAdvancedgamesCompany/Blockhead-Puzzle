// ═══════════════════════════════════════
//  Profile System
// ═══════════════════════════════════════
import { getCurrentUser, getCurrentUserData, getGuestDaysLeft } from './auth.js';

export function renderProfile() {
  const userData = getCurrentUserData();
  if (!userData) return;

  document.getElementById('profile-name').textContent = userData.username || 'Unknown';
  document.getElementById('profile-id').textContent = 'ID: ' + (userData.playerId || '--------');

  const stats = userData.stats || { gamesPlayed: 0, wins: 0, losses: 0 };

  document.getElementById('stat-played').textContent = stats.gamesPlayed || 0;
  document.getElementById('stat-wins').textContent = stats.wins || 0;
  document.getElementById('stat-losses').textContent = stats.losses || 0;

  const total = stats.gamesPlayed || 0;
  const wins = stats.wins || 0;
  const winRate = total > 0 ? Math.round((wins / total) * 100) : 0;

  document.getElementById('stat-winrate').textContent = winRate + '/100';
  document.getElementById('winrate-fill').style.width = winRate + '%';

  // Guest warning
  const guestWarn = document.getElementById('guest-warning');
  if (userData.isGuest) {
    const daysLeft = getGuestDaysLeft(userData);
    document.getElementById('guest-days-left').textContent = daysLeft;
    guestWarn.classList.remove('hidden');
  } else {
    guestWarn.classList.add('hidden');
  }
}

export function updateMenuUserInfo() {
  const userData = getCurrentUserData();
  if (!userData) return;

  document.getElementById('menu-username').textContent = userData.username || 'Player';
  document.getElementById('menu-player-id').textContent = 'ID: ' + (userData.playerId || '--------');
}
