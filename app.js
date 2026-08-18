// ═══════════════════════════════════════
//  Main Application Controller (app.js)
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
  searchPlayer,
  addFriend,
  startInviteTimer,
  setMatchmakingCallbacks,
  showToast
} from './matchmaking.js';
import {
  startGame,
  cleanupGame,
  usePowerRotate,
  usePowerHammer,
  usePowerRefresh,
  setGameCallbacks
} from './game.js';

// Screen Management
const SCREENS = {
  auth: document.getElementById('screen-auth'),
  username: document.getElementById('screen-username'),
  menu: document.getElementById('screen-menu'),
  matchmaking: document.getElementById('screen-matchmaking'),
  vs: document.getElementById('screen-vs'),
  profile: document.getElementById('screen-profile'),
  game: document.getElementById('screen-game')
};

let currentScreen = 'auth';
let activeVsTab = 'online';
let onlinePlayersCache = [];
let friendsCache = [];

function switchScreen(screenName) {
  Object.keys(SCREENS).forEach(name => {
    if (SCREENS[name]) {
      SCREENS[name].classList.remove('active');
    }
  });
  if (SCREENS[screenName]) {
    SCREENS[screenName].classList.add('active');
    currentScreen = screenName;
  }
}

// ═══════════════════════════════════════
//  Auth Callbacks & Navigation
// ═══════════════════════════════════════
sound.preload();

initAuth((state, data) => {
  if (state === 'menu') {
    updateMenuUserInfo();
    startListeningForInvites();
    startListeningOnlinePlayers();
    switchScreen('menu');
  } else if (state === 'username') {
    switchScreen('username');
  } else if (state === 'auth') {
    stopListeningForInvites();
    stopListeningOnlinePlayers();
    switchScreen('auth');
  } else if (state === 'expired') {
    showToast('Guest account has expired (30 days limit). Please sign in with Google.', 'error');
    switchScreen('auth');
  }
});

// Setup Matchmaking & Game Callbacks
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
  onOnlinePlayers: (players) => {
    onlinePlayersCache = players;
    if (currentScreen === 'vs' && activeVsTab === 'online') {
      renderVsList();
    }
  },
  onFriends: (friends) => {
    friendsCache = friends;
    if (currentScreen === 'vs' && activeVsTab === 'friends') {
      renderVsList();
    }
  }
});

setGameCallbacks({
  onEnd: (data) => {
    const overlay = document.getElementById('result-overlay');
    const title = document.getElementById('result-title');
    title.textContent = data.result === 'win' ? '🏆 YOU WIN!' : (data.result === 'lose' ? '💀 YOU LOSE' : '🤝 DRAW!');
    title.className = `result-title ${data.result}`;

    document.getElementById('result-me-name').textContent = data.myName;
    document.getElementById('result-me-score').textContent = data.myScore;
    document.getElementById('result-opp-name').textContent = data.oppName;
    document.getElementById('result-opp-score').textContent = data.oppScore;

    overlay.classList.add('active');
  }
});

// ═══════════════════════════════════════
//  Window-Exposed Handlers for UI Buttons
// ═══════════════════════════════════════

window.handleGoogleLogin = async () => {
  sound.play('click');
  try {
    document.getElementById('auth-status').textContent = 'Signing in with Google...';
    await loginWithGoogle();
  } catch (err) {
    document.getElementById('auth-status').textContent = '';
    showToast(err.message || 'Google sign-in failed', 'error');
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
    startListeningForInvites();
    startListeningOnlinePlayers();
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

window.toggleMenuMute = () => {
  const muted = sound.toggleMute();
  const btn = document.getElementById('menu-mute-btn');
  if (btn) btn.textContent = muted ? '🔇' : '🔊';
};

// VS Mode Functions
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
    list.innerHTML = `<div class="vs-empty">${activeVsTab === 'online' ? 'No other players online right now' : 'No friends added yet. Search by Player ID above!'}</div>`;
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

    await addFriend(found.uid);
    showToast(`Added ${found.username} to your friends!`, 'success');
    input.value = '';
    window.switchVsTab('friends');
  } catch (err) {
    showToast('Search failed', 'error');
  }
};

window.returnToMenu = () => {
  sound.play('click');
  const overlay = document.getElementById('result-overlay');
  overlay.classList.remove('active');
  cleanupGame();
  switchScreen('menu');
};

// Powerups exported
window.usePowerRotate = usePowerRotate;
window.usePowerHammer = usePowerHammer;
window.usePowerRefresh = usePowerRefresh;
