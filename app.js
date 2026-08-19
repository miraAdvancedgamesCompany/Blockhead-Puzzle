// ═══════════════════════════════════════
//  Main Application Controller — All fixes applied
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
  setGameCallbacks
} from './game.js';

// ═══════ Screen Management ═══════
const SCREENS = {
  auth: document.getElementById('screen-auth'),
  username: document.getElementById('screen-username'),
  menu: document.getElementById('screen-menu'),
  matchmaking: document.getElementById('screen-matchmaking'),
  vs: document.getElementById('screen-vs'),
  profile: document.getElementById('screen-profile'),
  game: document.getElementById('screen-game'),
  friendRequests: document.getElementById('screen-friend-requests')
};

let currentScreen = 'auth';
let activeVsTab = 'online';
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
    startGame(gameId);
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
    list.innerHTML = `<div class="vs-empty">${
      activeVsTab === 'online'
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
