// ═══════════════════════════════════════
//  Matchmaking & Invitation System
// ═══════════════════════════════════════
import {
  db, auth,
  ref, set, get, update, remove, push,
  onValue, onChildAdded, onChildRemoved, off,
  onDisconnect, serverTimestamp, runTransaction,
  query, orderByChild, equalTo
} from './firebase-config.js';
import { getCurrentUser, getCurrentUserData, getUserData, getUserByPlayerId } from './auth.js';

let queueListener = null;
let inviteListener = null;
let sentInviteListener = null;
let onlinePlayersListener = null;
let friendsCache = {};
let currentInviteId = null;
let currentSentInviteTarget = null;
let inviteTimerInterval = null;
let sentInviteTimerInterval = null;

// Callbacks — set by app.js
let onMatchFound = null;
let onInviteReceived = null;
let onOnlinePlayersUpdate = null;
let onFriendsUpdate = null;

export function setMatchmakingCallbacks({ onMatch, onInvite, onOnlinePlayers, onFriends }) {
  onMatchFound = onMatch;
  onInviteReceived = onInvite;
  onOnlinePlayersUpdate = onOnlinePlayers;
  onFriendsUpdate = onFriends;
}

// ═══════════════════════════════════════
//  RANDOM MATCHMAKING (Play button)
// ═══════════════════════════════════════

export async function joinMatchmakingQueue() {
  const user = getCurrentUser();
  const userData = getCurrentUserData();
  if (!user || !userData) return;

  const queueRef = ref(db, 'matchmaking/queue');

  // First check if there's already someone waiting
  const snap = await get(queueRef);

  if (snap.exists()) {
    const waiters = snap.val();
    const waiterUids = Object.keys(waiters).filter(uid => uid !== user.uid);

    if (waiterUids.length > 0) {
      // Found an opponent! Create a game
      const opponentUid = waiterUids[0];
      const opponentData = waiters[opponentUid];

      // Remove opponent from queue
      await remove(ref(db, `matchmaking/queue/${opponentUid}`));

      // Create game room
      const gameId = await createGameRoom(
        user.uid, userData.username,
        opponentUid, opponentData.username
      );

      if (onMatchFound) onMatchFound(gameId);
      return;
    }
  }

  // No one waiting — add ourselves to the queue
  const myQueueRef = ref(db, `matchmaking/queue/${user.uid}`);
  await set(myQueueRef, {
    username: userData.username,
    playerId: userData.playerId,
    joinedAt: Date.now()
  });

  // Auto-remove on disconnect
  onDisconnect(myQueueRef).remove();

  // Listen for someone to pick us up (our queue entry being removed means we got matched)
  // Also listen for a game being created for us
  listenForMatch(user.uid);
}

function listenForMatch(uid) {
  // Listen for games where we're a player
  const gamesRef = ref(db, 'matchmaking/matches/' + uid);

  queueListener = onValue(gamesRef, async (snap) => {
    if (snap.exists()) {
      const gameId = snap.val();
      // Clean up
      await remove(ref(db, `matchmaking/matches/${uid}`));
      await remove(ref(db, `matchmaking/queue/${uid}`));

      if (onMatchFound) onMatchFound(gameId);
    }
  });
}

export async function leaveMatchmakingQueue() {
  const user = getCurrentUser();
  if (!user) return;

  // Remove from queue
  await remove(ref(db, `matchmaking/queue/${user.uid}`));

  // Stop listening
  if (queueListener) {
    off(ref(db, `matchmaking/matches/${user.uid}`));
    queueListener = null;
  }
}

// ═══════════════════════════════════════
//  GAME ROOM CREATION
// ═══════════════════════════════════════

async function createGameRoom(uid1, username1, uid2, username2) {
  const gameRef = push(ref(db, 'games'));
  const gameId = gameRef.key;
  const now = Date.now();

  const gameData = {
    status: 'playing',
    createdAt: now,
    gameStartedAt: now,
    gameEndsAt: now + 90000, // 90 seconds
    gameDuration: 90,
    turnDuration: 10,
    currentTurn: 'player1',
    turnStartedAt: now,
    board: new Array(64).fill(null), // 8x8
    players: {
      player1: {
        uid: uid1,
        username: username1,
        score: 0,
        coins: 100,
        hammerUsesThisTurn: 0
      },
      player2: {
        uid: uid2,
        username: username2,
        score: 0,
        coins: 100,
        hammerUsesThisTurn: 0
      }
    },
    lastMove: null
  };

  await set(gameRef, gameData);

  // Notify player2 about the game
  await set(ref(db, `matchmaking/matches/${uid2}`), gameId);

  return gameId;
}

// ═══════════════════════════════════════
//  INVITATION SYSTEM (VS mode)
// ═══════════════════════════════════════

export async function sendInvite(targetUid) {
  const user = getCurrentUser();
  const userData = getCurrentUserData();
  if (!user || !userData) return null;

  const now = Date.now();
  const inviteRef = push(ref(db, `invitations/${targetUid}`));

  const inviteData = {
    from: user.uid,
    fromUsername: userData.username,
    fromPlayerId: userData.playerId,
    status: 'pending',
    createdAt: now,
    expiresAt: now + 15000 // 15 seconds
  };

  await set(inviteRef, inviteData);

  currentSentInviteTarget = targetUid;
  const inviteId = inviteRef.key;

  // Listen for response
  listenForInviteResponse(targetUid, inviteId);

  // Auto-expire after 15s
  startSentInviteTimer(targetUid, inviteId);

  return inviteId;
}

function listenForInviteResponse(targetUid, inviteId) {
  const inviteRef = ref(db, `invitations/${targetUid}/${inviteId}`);

  sentInviteListener = onValue(inviteRef, async (snap) => {
    if (!snap.exists()) {
      // Invite was removed (expired or cancelled)
      cleanupSentInvite();
      return;
    }

    const data = snap.val();

    if (data.status === 'accepted') {
      // Opponent accepted! Create game
      cleanupSentInvite();
      await remove(inviteRef);

      const user = getCurrentUser();
      const userData = getCurrentUserData();
      const targetData = await getUserData(targetUid);

      const gameId = await createGameRoom(
        user.uid, userData.username,
        targetUid, targetData.username
      );

      if (onMatchFound) onMatchFound(gameId);
    } else if (data.status === 'declined') {
      cleanupSentInvite();
      await remove(inviteRef);
      // Show toast notification
      showToast('Invite was declined', 'error');
    }
  });
}

function startSentInviteTimer(targetUid, inviteId) {
  const startTime = Date.now();
  const duration = 15000;
  const fill = document.getElementById('sent-invite-timer-fill');

  sentInviteTimerInterval = setInterval(async () => {
    const elapsed = Date.now() - startTime;
    const remaining = Math.max(0, 1 - elapsed / duration);
    if (fill) fill.style.width = (remaining * 100) + '%';

    if (elapsed >= duration) {
      // Expired
      clearInterval(sentInviteTimerInterval);
      cleanupSentInvite();
      await remove(ref(db, `invitations/${targetUid}/${inviteId}`));
      showToast('Invite expired', 'error');
    }
  }, 100);
}

function cleanupSentInvite() {
  if (sentInviteTimerInterval) {
    clearInterval(sentInviteTimerInterval);
    sentInviteTimerInterval = null;
  }
  if (sentInviteListener) {
    sentInviteListener = null;
  }
  currentSentInviteTarget = null;

  const overlay = document.getElementById('sent-invite-overlay');
  if (overlay) overlay.classList.remove('active');
}

export function cancelSentInviteAction() {
  if (currentSentInviteTarget && currentInviteId) {
    remove(ref(db, `invitations/${currentSentInviteTarget}/${currentInviteId}`));
  }
  cleanupSentInvite();
}

// ═══════════════════════════════════════
//  LISTENING FOR INCOMING INVITES
// ═══════════════════════════════════════

export function startListeningForInvites() {
  const user = getCurrentUser();
  if (!user) return;

  const invitesRef = ref(db, `invitations/${user.uid}`);

  inviteListener = onChildAdded(invitesRef, (snap) => {
    const invite = snap.val();
    const inviteId = snap.key;

    if (!invite || invite.status !== 'pending') return;

    // Check if expired
    if (Date.now() > invite.expiresAt) {
      remove(ref(db, `invitations/${user.uid}/${inviteId}`));
      return;
    }

    currentInviteId = inviteId;

    if (onInviteReceived) {
      onInviteReceived({
        id: inviteId,
        fromUsername: invite.fromUsername,
        fromUid: invite.from,
        expiresAt: invite.expiresAt
      });
    }
  });
}

export function stopListeningForInvites() {
  const user = getCurrentUser();
  if (!user) return;

  if (inviteListener) {
    off(ref(db, `invitations/${user.uid}`));
    inviteListener = null;
  }
}

export async function acceptInviteAction() {
  const user = getCurrentUser();
  if (!user || !currentInviteId) return;

  await update(ref(db, `invitations/${user.uid}/${currentInviteId}`), {
    status: 'accepted'
  });

  // Wait for the game to be created by the inviter — listen for match
  listenForMatch(user.uid);

  hideInviteOverlay();
}

export async function declineInviteAction() {
  const user = getCurrentUser();
  if (!user || !currentInviteId) return;

  await update(ref(db, `invitations/${user.uid}/${currentInviteId}`), {
    status: 'declined'
  });

  currentInviteId = null;
  hideInviteOverlay();
}

function hideInviteOverlay() {
  clearInviteTimer();
  const overlay = document.getElementById('invite-overlay');
  if (overlay) overlay.classList.remove('active');
}

function clearInviteTimer() {
  if (inviteTimerInterval) {
    clearInterval(inviteTimerInterval);
    inviteTimerInterval = null;
  }
}

export function startInviteTimer(expiresAt) {
  clearInviteTimer();
  const fill = document.getElementById('invite-timer-fill');

  const duration = expiresAt - Date.now();
  const startTime = Date.now();

  inviteTimerInterval = setInterval(() => {
    const elapsed = Date.now() - startTime;
    const remaining = Math.max(0, 1 - elapsed / duration);
    if (fill) fill.style.width = (remaining * 100) + '%';

    if (elapsed >= duration) {
      clearInterval(inviteTimerInterval);
      // Auto-decline
      declineInviteAction();
    }
  }, 100);
}

// ═══════════════════════════════════════
//  ONLINE PLAYERS LIST
// ═══════════════════════════════════════

export function startListeningOnlinePlayers() {
  const user = getCurrentUser();
  if (!user) return;

  const usersRef = ref(db, 'users');

  onlinePlayersListener = onValue(usersRef, (snap) => {
    if (!snap.exists()) return;

    const allUsers = snap.val();
    const onlinePlayers = [];
    const friends = [];

    const myFriends = (getCurrentUserData() || {}).friends || {};

    for (const [uid, data] of Object.entries(allUsers)) {
      if (uid === user.uid) continue;
      if (!data.username) continue;

      const playerInfo = {
        uid,
        username: data.username,
        playerId: data.playerId,
        status: data.status || 'offline',
        isFriend: !!myFriends[uid]
      };

      if (data.status === 'online') {
        onlinePlayers.push(playerInfo);
      }

      if (myFriends[uid]) {
        friends.push(playerInfo);
      }
    }

    if (onOnlinePlayersUpdate) onOnlinePlayersUpdate(onlinePlayers);
    if (onFriendsUpdate) onFriendsUpdate(friends);
  });
}

export function stopListeningOnlinePlayers() {
  if (onlinePlayersListener) {
    off(ref(db, 'users'));
    onlinePlayersListener = null;
  }
}

// ═══════════════════════════════════════
//  FRIEND SYSTEM
// ═══════════════════════════════════════

export async function addFriend(targetUid) {
  const user = getCurrentUser();
  if (!user || targetUid === user.uid) return;

  const updates = {};
  updates[`users/${user.uid}/friends/${targetUid}`] = true;
  updates[`users/${targetUid}/friends/${user.uid}`] = true;

  await update(ref(db), updates);
}

export async function removeFriend(targetUid) {
  const user = getCurrentUser();
  if (!user) return;

  const updates = {};
  updates[`users/${user.uid}/friends/${targetUid}`] = null;
  updates[`users/${targetUid}/friends/${user.uid}`] = null;

  await update(ref(db), updates);
}

export async function searchPlayer(playerId) {
  return getUserByPlayerId(playerId.toUpperCase());
}

// ═══════════════════════════════════════
//  TOAST HELPER
// ═══════════════════════════════════════

function showToast(message, type = '') {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.className = 'toast' + (type ? ' ' + type : '');
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 3000);
}

export { showToast, createGameRoom };
