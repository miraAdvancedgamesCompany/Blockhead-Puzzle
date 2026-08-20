// ═══════════════════════════════════════
//  Ranking & Leaderboard System
// ═══════════════════════════════════════
import {
  db, ref, get, query, orderByChild, limitToFirst
} from './firebase-config.js';

// ═══════ RANK DEFINITIONS ═══════
const RANKS = [
  { name: 'Bronze',   badge: '🥉', min: 0,     max: 3000,  color: '#CD7F32', glow: 'rgba(205,127,50,0.5)' },
  { name: 'Platinum', badge: '💎', min: 3001,  max: 9000,  color: '#E5E4E2', glow: 'rgba(229,228,226,0.5)' },
  { name: 'Gold',     badge: '🥇', min: 9001,  max: 18000, color: '#FFD700', glow: 'rgba(255,215,0,0.5)' },
  { name: 'King',     badge: '👑', min: 18001, max: 30000, color: '#9B59B6', glow: 'rgba(155,89,182,0.5)' },
  { name: 'Top1',     badge: '🏆', min: 30001, max: Infinity, color: '#E74C3C', glow: 'rgba(231,76,60,0.5)' }
];

// Rank index for matching priority (0 = lowest, 4 = highest)
const RANK_NAMES = ['Bronze', 'Platinum', 'Gold', 'King', 'Top1'];

/**
 * Get rank info from total points
 * @param {number} points - Total accumulated points
 * @returns {{ name: string, badge: string, color: string, glow: string, index: number }}
 */
export function getRankFromPoints(points) {
  const p = points || 0;
  for (let i = RANKS.length - 1; i >= 0; i--) {
    if (p >= RANKS[i].min) {
      return { ...RANKS[i], index: i };
    }
  }
  return { ...RANKS[0], index: 0 };
}

/**
 * Get rank index (0–4) from rank name
 */
export function getRankIndex(rankName) {
  const idx = RANK_NAMES.indexOf(rankName);
  return idx >= 0 ? idx : 0;
}

/**
 * Format large numbers: 1838 → "1.83K", 1789380 → "1.78M"
 * @param {number} n
 * @returns {string}
 */
export function formatNumber(n) {
  if (n === null || n === undefined) return '0';
  const num = Number(n);
  if (isNaN(num)) return '0';

  if (num >= 1_000_000_000_000) {
    return (num / 1_000_000_000_000).toFixed(2) + 'T';
  }
  if (num >= 1_000_000_000) {
    return (num / 1_000_000_000).toFixed(2) + 'B';
  }
  if (num >= 1_000_000) {
    return (num / 1_000_000).toFixed(2) + 'M';
  }
  if (num >= 1_000) {
    return (num / 1_000).toFixed(2) + 'K';
  }
  return String(num);
}

/**
 * Load Top 100 leaderboard from Firebase
 * @param {'ranking' | 'topBlock' | 'wins'} type
 * @returns {Promise<Array<{ username: string, rank: object, value: number, position: number }>>}
 */
export async function loadLeaderboard(type) {
  try {
    // We need to read all users and sort client-side
    // Firebase RTDB doesn't support descending order natively
    const usersSnap = await get(ref(db, 'users'));
    if (!usersSnap.exists()) return [];

    const allUsers = usersSnap.val();
    const entries = [];

    for (const [uid, data] of Object.entries(allUsers)) {
      // Skip guests — they don't appear in leaderboards
      if (data.isGuest) continue;
      if (!data.username) continue;

      const rankStats = data.rankStats || { totalPoints: 0, totalRowsCleared: 0, totalWins: 0 };

      let value = 0;
      if (type === 'ranking') {
        value = rankStats.totalPoints || 0;
      } else if (type === 'topBlock') {
        value = rankStats.totalRowsCleared || 0;
      } else if (type === 'wins') {
        value = rankStats.totalWins || 0;
      }

      // Only include players with at least some activity
      if (value > 0) {
        entries.push({
          uid,
          username: data.username,
          playerId: data.playerId,
          rank: getRankFromPoints(rankStats.totalPoints || 0),
          value
        });
      }
    }

    // Sort descending by value
    entries.sort((a, b) => b.value - a.value);

    // Take top 100
    const top100 = entries.slice(0, 100);

    // Add position numbers
    top100.forEach((entry, i) => {
      entry.position = i + 1;
    });

    return top100;
  } catch (e) {
    console.error('Failed to load leaderboard:', e);
    return [];
  }
}

export { RANKS, RANK_NAMES };
