// ═══════════════════════════════════════
//  Main Application Controller — BlockHead
// ═══════════════════════════════════════
import {
  initAuth,
  loginWithGoogle,
  loginAsGuest,
  logout,
  setUsername,
  getCurrentUser,
  getCurrentUserData
} from './auth.js';
import { sound } from './sound.js';
import { renderProfile, updateMenuUserInfo } from './profile.js';
import {
  joinMatchmakingQueue,
  leaveMatchmakingQueue,
  sendInvite,
  cancelSentInviteAction,
  acceptInviteAction,
  declineInviteAction,
  startListeningForInvites,
  stopListeningForInvites,
  startListeningOnlinePlayers,
  stopListeningOnlinePlayers,
  startListeningFriendRequests,
  stopListeningFriendRequests,
  searchPlayer,
  sendFriendRequest,
  acceptFriendRequestAction,
  declineFriendRequestAction,
  startInviteTimer,
  setMatchmakingCallbacks,
  showToast
} from './matchmaking.js';
import {
  startGame,
  cleanupGame,
  surrenderGame,
  usePowerRotate,
  usePowerHammer,
  usePowerRefresh,
  sendChatMessage,
  setGameCallbacks
} from './game.js';
import {
  loadLeaderboard,
  formatNumber,
  getRankFromPoints
} from './ranking.js';

// ═══════ Screen Management ═══════
const SCREENS = {
  auth: document.getElementById('screen-auth'),
  username: document.getElementById('screen-username'),
  menu: document.getElementById('screen-menu'),
  matchmaking: document.getElementById('screen-matchmaking'),
  vs: document.getElementById('screen-vs'),
  profile: document.getElementById('screen-profile'),
  leaderboard: document.getElementById('screen-leaderboard'),
  game: document.getElementById('screen-game'),
  friendRequests: document.getElementById('screen-friend-requests')
};

let currentScreen = 'auth';
let activeVsTab = 'online';
let activeLeaderboardTab = 'ranking';
let onlinePlayersCache = [];
let friendsCache = [];
let friendRequestsCache = [];
let searchResultPlayer = null; // Store found player for friend request

function switchScreen(screenName) {
  Object.keys(SCREENS).forEach(name => {
    if (SCREENS[name]) SCREENS[name].classList.remove('active');
  });
  if (SCREENS[screenName]) {
    SCREENS[screenName].classList.add('active');
    currentScreen = screenName;
  }
}

// ═══════ Init ═══════
sound.preload();

initAuth((state, data) => {
  if (state === 'menu') {
    updateMenuUserInfo();
    updateBGMButton();
    startListeningForInvites();
    startListeningOnlinePlayers();
    startListeningFriendRequests();
    switchScreen('menu');
  } else if (state === 'username') {
    switchScreen('username');
  } else if (state === 'auth') {
    stopListeningForInvites();
    stopListeningOnlinePlayers();
    stopListeningFriendRequests();
    switchScreen('auth');
  } else if (state === 'expired') {
    showToast('Guest account expired (30 days). Sign in with Google.', 'error');
    switchScreen('auth');
  }
});

// ═══════ Matchmaking & Game Callbacks ═══════
setMatchmakingCallbacks({
  onMatch: (gameId) => {
    sound.play('matchFound');
    showToast('Match found! Starting game...', 'success');
    switchScreen('game');
    startGame(gameId, 'play');
  },
  onInvite: (invite) => {
    sound.play('invite');
    document.getElementById('invite-from-name').textContent = `${invite.fromUsername} challenged you!`;
    document.getElementById('invite-overlay').classList.add('active');
    startInviteTimer(invite.expiresAt);
  },
  onInviteCancel: () => {
    // Sender cancelled — hide the invite overlay
    document.getElementById('invite-overlay').classList.remove('active');
    showToast('Challenge was cancelled', '');
  },
  onOnlinePlayers: (players) => {
    onlinePlayersCache = players;
    if (currentScreen === 'vs' && activeVsTab === 'online') renderVsList();
  },
  onFriends: (friends) => {
    friendsCache = friends;
    if (currentScreen === 'vs' && activeVsTab === 'friends') renderVsList();
  },
  onFriendRequests: (requests) => {
    friendRequestsCache = requests;
    updateFriendRequestBadge();
    if (currentScreen === 'friendRequests') renderFriendRequests();
  }
});

setGameCallbacks({
  onEnd: (data) => {
    const overlay = document.getElementById('result-overlay');
    const title = document.getElementById('result-title');

    if (data.surrendered) {
      if (data.result === 'lose') {
        title.textContent = '💀 YOU FORFEITED';
        title.className = 'result-title lose';
      } else {
        title.textContent = '🏆 OPPONENT FORFEITED!';
        title.className = 'result-title win';
      }
    } else {
      title.textContent = data.result === 'win' ? '🏆 YOU WIN!' : (data.result === 'lose' ? '💀 YOU LOSE' : '🤝 DRAW!');
      title.className = `result-title ${data.result}`;
    }

    document.getElementById('result-me-name').textContent = data.myName;
    document.getElementById('result-me-score').textContent = data.myScore;
    document.getElementById('result-opp-name').textContent = data.oppName;
    document.getElementById('result-opp-score').textContent = data.oppScore;

    overlay.classList.add('active');
  }
});

// ═══════════════════════════════════════
//  Window-Exposed Handlers
// ═══════════════════════════════════════

// ── Auth ──
window.handleGoogleLogin = async () => {
  sound.play('click');
  try {
    document.getElementById('auth-status').textContent = 'Signing in with Google...';
    await loginWithGoogle();
  } catch (err) {
    document.getElementById('auth-status').textContent = '';
    console.error('Google login error:', err);

    if (err.code === 'auth/unauthorized-domain') {
      showToast('Add this domain to Firebase Console → Auth → Authorized Domains', 'error');
    } else {
      showToast(err.message || 'Google sign-in failed', 'error');
    }
  }
};

window.handleGuestLogin = async () => {
  sound.play('click');
  try {
    document.getElementById('auth-status').textContent = 'Signing in as Guest...';
    await loginAsGuest();
  } catch (err) {
    document.getElementById('auth-status').textContent = '';
    showToast(err.message || 'Guest sign-in failed', 'error');
  }
};

window.handleSetUsername = async () => {
  sound.play('click');
  const input = document.getElementById('username-input');
  const errorEl = document.getElementById('username-error');
  const val = input.value.trim();

  errorEl.textContent = '';
  input.classList.remove('error');

  try {
    await setUsername(val);
    updateMenuUserInfo();
    updateBGMButton();
    startListeningForInvites();
    startListeningOnlinePlayers();
    startListeningFriendRequests();
    switchScreen('menu');
  } catch (err) {
    input.classList.add('error');
    errorEl.textContent = err.message;
    sound.play('snap');
  }
};

window.handleLogout = async () => {
  sound.play('click');
  cleanupGame();
  await logout();
};

// ── Navigation ──
window.showMenu = () => {
  sound.play('click');
  updateMenuUserInfo();
  switchScreen('menu');
};

window.startMatchmaking = async () => {
  sound.play('click');
  switchScreen('matchmaking');
  try {
    await joinMatchmakingQueue();
  } catch (err) {
    showToast('Failed to join queue', 'error');
    switchScreen('menu');
  }
};

window.cancelMatchmaking = async () => {
  sound.play('click');
  await leaveMatchmakingQueue();
  switchScreen('menu');
};

window.showVsScreen = () => {
  sound.play('click');
  switchScreen('vs');
  renderVsList();
};

window.showProfile = () => {
  sound.play('click');
  renderProfile();
  switchScreen('profile');
};

window.showFriendRequests = () => {
  sound.play('click');
  switchScreen('friendRequests');
  renderFriendRequests();
};

// ── Leaderboard ──
window.showLeaderboard = () => {
  sound.play('click');
  switchScreen('leaderboard');
  renderLeaderboardTab(activeLeaderboardTab);
};

window.switchLeaderboardTab = (tab) => {
  sound.play('click');
  activeLeaderboardTab = tab;

  document.getElementById('lb-tab-ranking').classList.toggle('active', tab === 'ranking');
  document.getElementById('lb-tab-topBlock').classList.toggle('active', tab === 'topBlock');
  document.getElementById('lb-tab-wins').classList.toggle('active', tab === 'wins');

  const descEl = document.getElementById('leaderboard-desc');
  if (descEl) {
    if (tab === 'ranking') descEl.textContent = 'Top 100 players by total points in Play mode';
    else if (tab === 'topBlock') descEl.textContent = 'Top 100 players by rows cleared in Play mode';
    else if (tab === 'wins') descEl.textContent = 'Top 100 players by match victories in Play mode';
  }

  renderLeaderboardTab(tab);
};

async function renderLeaderboardTab(tab) {
  const listEl = document.getElementById('leaderboard-list');
  if (!listEl) return;

  listEl.innerHTML = '<div class="vs-empty"><span class="spinner-small"></span> Loading Top 100...</div>';

  try {
    const data = await loadLeaderboard(tab);
    const currentUser = getCurrentUser();

    if (!data || data.length === 0) {
      listEl.innerHTML = '<div class="vs-empty">No ranking records yet. Play matches to climb the leaderboard!</div>';
      return;
    }

    listEl.innerHTML = '';
    data.forEach(entry => {
      const card = document.createElement('div');
      const isMe = (currentUser && entry.uid === currentUser.uid);
      card.className = `lb-player-card ${isMe ? 'is-me' : ''}`;

      // Rank position styling (1st = Gold, 2nd = Silver, 3rd = Bronze)
      let posBadge = `#${entry.position}`;
      let posClass = 'lb-pos-regular';
      if (entry.position === 1) { posBadge = '🥇 #1'; posClass = 'lb-pos-1'; }
      else if (entry.position === 2) { posBadge = '🥈 #2'; posClass = 'lb-pos-2'; }
      else if (entry.position === 3) { posBadge = '🥉 #3'; posClass = 'lb-pos-3'; }

      let valueLabel = 'pts';
      if (tab === 'topBlock') valueLabel = 'rows';
      else if (tab === 'wins') valueLabel = 'wins';

      card.innerHTML = `
        <div class="lb-pos ${posClass}">${posBadge}</div>
        <div class="lb-player-info">
          <div class="lb-player-name">${entry.username} ${isMe ? '<span class="lb-me-tag">(You)</span>' : ''}</div>
          <div class="lb-player-rank" style="color: ${entry.rank.color};">
            ${entry.rank.badge} ${entry.rank.name}
          </div>
        </div>
        <div class="lb-player-value">
          <span class="lb-val-num">${formatNumber(entry.value)}</span>
          <span class="lb-val-label">${valueLabel}</span>
        </div>
      `;
      listEl.appendChild(card);
    });
  } catch (e) {
    console.error('Leaderboard render error:', e);
    listEl.innerHTML = '<div class="vs-empty">Failed to load leaderboard. Please try again.</div>';
  }
}

// ── In-Game Chat Handlers ──
window.openChatModal = () => {
  sound.play('click');
  const modal = document.getElementById('chat-modal');
  const input = document.getElementById('chat-input');
  const counter = document.getElementById('chat-char-counter');
  if (modal) modal.classList.add('active');
  if (input) {
    input.value = '';
    setTimeout(() => input.focus(), 100);
  }
  if (counter) counter.textContent = '0/90';
};

window.closeChatModal = () => {
  sound.play('click');
  const modal = document.getElementById('chat-modal');
  if (modal) modal.classList.remove('active');
};

window.sendPresetChat = async (text) => {
  sound.play('click');
  window.closeChatModal();
  try {
    await sendChatMessage(text);
  } catch (err) {
    console.error('Chat error:', err);
  }
};

window.sendCustomChat = async () => {
  const input = document.getElementById('chat-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;

  sound.play('click');
  window.closeChatModal();
  input.value = '';

  try {
    await sendChatMessage(text);
  } catch (err) {
    console.error('Chat send error:', err);
  }
};

// Chat input events
const chatInputEl = document.getElementById('chat-input');
if (chatInputEl) {
  chatInputEl.addEventListener('input', () => {
    const counter = document.getElementById('chat-char-counter');
    if (counter) {
      counter.textContent = `${chatInputEl.value.length}/90`;
    }
  });

  chatInputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      window.sendCustomChat();
    }
  });
}

// ── BGM toggle (only background music) ──
function updateBGMButton() {
  const btn = document.getElementById('menu-mute-btn');
  if (btn) btn.textContent = sound.isBGMEnabled() ? '🔊' : '🔇';
}

window.toggleMenuMute = () => {
  sound.toggleBGM();
  updateBGMButton();
};

// ═══════ VS Mode ═══════
window.switchVsTab = (tab) => {
  sound.play('click');
  activeVsTab = tab;
  document.getElementById('tab-online').classList.toggle('active', tab === 'online');
  document.getElementById('tab-friends').classList.toggle('active', tab === 'friends');
  renderVsList();
};

function renderVsList() {
  const list = document.getElementById('vs-player-list');
  const players = (activeVsTab === 'online') ? onlinePlayersCache : friendsCache;

  list.innerHTML = '';
  if (!players || players.length === 0) {
    list.innerHTML = `<div class="vs-empty">${activeVsTab === 'online'
      ? 'No other players online right now'
      : 'No friends added yet. Search by Player ID above!'
      }</div>`;
    return;
  }

  players.forEach(p => {
    const card = document.createElement('div');
    card.className = 'vs-player-card';
    card.innerHTML = `
      <div class="vs-player-avatar">👤</div>
      <div class="vs-player-info">
        <div class="vs-player-name">${p.username}</div>
        <div class="vs-player-id">ID: ${p.playerId}</div>
      </div>
      <div class="vs-player-status" style="background: ${p.status === 'online' ? 'var(--green)' : '#666'};"></div>
    `;
    card.onclick = () => invitePlayer(p.uid, p.username);
    list.appendChild(card);
  });
}

async function invitePlayer(uid, username) {
  sound.play('click');
  document.getElementById('sent-invite-target').textContent = `Waiting for ${username}...`;
  document.getElementById('sent-invite-overlay').classList.add('active');
  try {
    await sendInvite(uid);
  } catch (err) {
    showToast('Failed to send invite', 'error');
    document.getElementById('sent-invite-overlay').classList.remove('active');
  }
}

window.cancelSentInvite = () => {
  sound.play('click');
  cancelSentInviteAction();
};

window.acceptInvite = async () => {
  sound.play('click');
  await acceptInviteAction();
};

window.declineInvite = async () => {
  sound.play('click');
  await declineInviteAction();
};

// ═══════ Player Search → Show popup → Send friend request ═══════
window.searchPlayerById = async () => {
  sound.play('click');
  const input = document.getElementById('vs-search-input');
  const query = input.value.trim().toUpperCase();
  if (!query) return;

  try {
    const found = await searchPlayer(query);
    if (!found) {
      showToast('Player not found with this ID', 'error');
      return;
    }

    const current = getCurrentUser();
    if (found.uid === current.uid) {
      showToast("That's your own ID!", 'error');
      return;
    }

    // Show search result popup
    searchResultPlayer = found;
    document.getElementById('search-result-name').textContent = found.username;
    document.getElementById('search-result-id').textContent = 'ID: ' + found.playerId;
    document.getElementById('search-result-overlay').classList.add('active');
    input.value = '';

  } catch (err) {
    showToast('Search failed', 'error');
  }
};

window.sendFriendReq = async () => {
  sound.play('click');
  if (!searchResultPlayer) return;

  try {
    await sendFriendRequest(searchResultPlayer.uid);
    document.getElementById('search-result-overlay').classList.remove('active');
    searchResultPlayer = null;
  } catch (err) {
    showToast('Failed to send request', 'error');
  }
};

window.closeSearchResult = () => {
  sound.play('click');
  document.getElementById('search-result-overlay').classList.remove('active');
  searchResultPlayer = null;
};

// ═══════ Friend Requests ═══════
function updateFriendRequestBadge() {
  const badge = document.getElementById('fr-badge');
  if (!badge) return;
  const count = friendRequestsCache.length;
  badge.textContent = count;
  badge.classList.toggle('hidden', count === 0);
}

function renderFriendRequests() {
  const list = document.getElementById('friend-requests-list');
  list.innerHTML = '';

  if (friendRequestsCache.length === 0) {
    list.innerHTML = '<div class="vs-empty">No pending friend requests</div>';
    return;
  }

  friendRequestsCache.forEach(req => {
    const card = document.createElement('div');
    card.className = 'vs-player-card';
    card.style.cursor = 'default';
    card.innerHTML = `
      <div class="vs-player-avatar">👤</div>
      <div class="vs-player-info">
        <div class="vs-player-name">${req.fromUsername}</div>
        <div class="vs-player-id">ID: ${req.fromPlayerId}</div>
      </div>
      <div class="fr-actions">
        <button class="fr-accept-btn" data-id="${req.id}">✅</button>
        <button class="fr-decline-btn" data-id="${req.id}">✖</button>
      </div>
    `;

    // Accept button
    card.querySelector('.fr-accept-btn').onclick = async (e) => {
      e.stopPropagation();
      sound.play('click');
      await acceptFriendRequestAction(req.id);
    };

    // Decline button
    card.querySelector('.fr-decline-btn').onclick = async (e) => {
      e.stopPropagation();
      sound.play('click');
      await declineFriendRequestAction(req.id);
    };

    list.appendChild(card);
  });
}

// ═══════ Game Result & Surrender ═══════
window.returnToMenu = () => {
  sound.play('click');
  document.getElementById('result-overlay').classList.remove('active');
  cleanupGame();
  updateMenuUserInfo();
  switchScreen('menu');
};

window.handleSurrender = () => {
  sound.play('click');
  document.getElementById('surrender-modal').classList.add('active');
};

window.closeSurrenderModal = () => {
  sound.play('click');
  document.getElementById('surrender-modal').classList.remove('active');
};

window.confirmSurrenderAction = async () => {
  sound.play('click');
  document.getElementById('surrender-modal').classList.remove('active');
  await surrenderGame();
};

// ═══════ Powerups (expose to window) ═══════
window.usePowerRotate = usePowerRotate;
window.usePowerHammer = usePowerHammer;
window.usePowerRefresh = usePowerRefresh;

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js')
      .then((reg) => console.log('Service Worker registered!'))
      .catch((err) => console.log('Service Worker registration failed: ', err));
  });
}