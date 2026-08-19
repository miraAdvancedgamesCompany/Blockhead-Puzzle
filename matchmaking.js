// ═══════════════════════════════════════
//  Matchmaking, Invitations & Friend Requests
// ═══════════════════════════════════════
import {
  db, auth,
  ref, set, get, update, remove, push,
  onValue, onChildAdded, onChildRemoved, off,
  onDisconnect
} from './firebase-config.js';
import { getCurrentUser, getCurrentUserData, getUserData, getUserByPlayerId } from './auth.js';

// ── Module state ──
let queueListener = null;
let inviteListener = null;
let inviteRemovedListener = null;
let sentInviteListener = null;
let onlinePlayersListener = null;
let friendRequestsListener = null;

// Current incoming invite
let currentInviteId = null;
let inviteTimerInterval = null;

// Current SENT invite (separate from received)
let currentSentInviteId = null;
let currentSentInviteTarget = null;
let sentInviteTimerInterval = null;

// Callbacks — set by app.js
let onMatchFound = null;
let onInviteReceived = null;
let onInviteCancelled = null;
let onOnlinePlayersUpdate = null;
let onFriendsUpdate = null;
let onFriendRequestsUpdate = null;

export function setMatchmakingCallbacks({
  onMatch, onInvite, onInviteCancel, onOnlinePlayers, onFriends, onFriendRequests
}) {
  onMatchFound = onMatch;
  onInviteReceived = onInvite;
  onInviteCancelled = onInviteCancel;
  onOnlinePlayersUpdate = onOnlinePlayers;
  onFriendsUpdate = onFriends;
  onFriendRequestsUpdate = onFriendRequests;
}

// ═══════════════════════════════════════
//  RANDOM MATCHMAKING (Play button)
// ═══════════════════════════════════════

export async function joinMatchmakingQueue() {
  const user = getCurrentUser();
  const userData = getCurrentUserData();
  if (!user || !userData) return;

  const queueRef = ref(db, 'matchmaking/queue');
  const snap = await get(queueRef);

  if (snap.exists()) {
    const waiters = snap.val();
    const waiterUids = Object.keys(waiters).filter(uid => uid !== user.uid);

    if (waiterUids.length > 0) {
      const opponentUid = waiterUids[0];
      const opponentData = waiters[opponentUid];

      await remove(ref(db, `matchmaking/queue/${opponentUid}`));

      const gameId = await createGameRoom(
        user.uid, userData.username,
        opponentUid, opponentData.username
      );

      if (onMatchFound) onMatchFound(gameId);
      return;
    }
  }

  // No one waiting — add to queue
  const myQueueRef = ref(db, `matchmaking/queue/${user.uid}`);
  await set(myQueueRef, {
    username: userData.username,
    playerId: userData.playerId,
    joinedAt: Date.now()
  });

  onDisconnect(myQueueRef).remove();
  listenForMatch(user.uid);
}

function listenForMatch(uid) {
  const matchRef = ref(db, 'matchmaking/matches/' + uid);

  queueListener = onValue(matchRef, async (snap) => {
    if (snap.exists()) {
      const gameId = snap.val();
      await remove(ref(db, `matchmaking/matches/${uid}`));
      await remove(ref(db, `matchmaking/queue/${uid}`));

      if (onMatchFound) onMatchFound(gameId);
    }
  });
}

export async function leaveMatchmakingQueue() {
  const user = getCurrentUser();
  if (!user) return;

  await remove(ref(db, `matchmaking/queue/${user.uid}`));

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
    gameEndsAt: now + 90000,
    gameDuration: 90,
    turnDuration: 10,
    currentTurn: Math.random() < 0.5 ? 'player1' : 'player2',
    turnStartedAt: now,
    board: new Array(64).fill(0),
    players: {
      player1: {
        uid: uid1,
        username: username1,
        score: 0,
        coins: 100,
        hammerUsesThisTurn: 0,
        linesCleared: 0,
        powerUpsUsed: 0
      },
      player2: {
        uid: uid2,
        username: username2,
        score: 0,
        coins: 100,
        hammerUsesThisTurn: 0,
        linesCleared: 0,
        powerUpsUsed: 0
      }
    },
    lastMove: null
  };

  await set(gameRef, gameData);
  await set(ref(db, `matchmaking/matches/${uid2}`), gameId);

  return gameId;
}

// ═══════════════════════════════════════
//  INVITATION SYSTEM (VS mode — game invite)
// ═══════════════════════════════════════

export async function sendInvite(targetUid) {
  const user = getCurrentUser();
  const userData = getCurrentUserData();
  if (!user || !userData) return null;

  const now = Date.now();
  const inviteRef = push(ref(db, `invitations/${targetUid}`));
  const inviteId = inviteRef.key;

  const inviteData = {
    from: user.uid,
    fromUsername: userData.username,
    fromPlayerId: userData.playerId,
    status: 'pending',
    createdAt: now,
    expiresAt: now + 15000
  };

  await set(inviteRef, inviteData);

  // Store SENT invite info for cancel
  currentSentInviteId = inviteId;
  currentSentInviteTarget = targetUid;

  // Listen for response
  listenForInviteResponse(targetUid, inviteId);

  // Auto-expire timer
  startSentInviteTimer(targetUid, inviteId);

  return inviteId;
}

function listenForInviteResponse(targetUid, inviteId) {
  const inviteRef = ref(db, `invitations/${targetUid}/${inviteId}`);

  sentInviteListener = onValue(inviteRef, async (snap) => {
    if (!snap.exists()) {
      // Invite removed (expired/cancelled)
      cleanupSentInvite();
      return;
    }

    const data = snap.val();

    if (data.status === 'accepted') {
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
      clearInterval(sentInviteTimerInterval);
      sentInviteTimerInterval = null;
      cleanupSentInvite();
      try { await remove(ref(db, `invitations/${targetUid}/${inviteId}`)); } catch(e) {}
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
    // The listener auto-detaches when ref is removed, but clean up our reference
    sentInviteListener = null;
  }
  currentSentInviteId = null;
  currentSentInviteTarget = null;

  const overlay = document.getElementById('sent-invite-overlay');
  if (overlay) overlay.classList.remove('active');
}

// ── Cancel a SENT invite (properly removes from Firebase) ──
export function cancelSentInviteAction() {
  if (currentSentInviteTarget && currentSentInviteId) {
    // Remove the invite from Firebase — this triggers removal on receiver's end too
    remove(ref(db, `invitations/${currentSentInviteTarget}/${currentSentInviteId}`))
      .catch(e => console.error('Failed to cancel invite:', e));
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

  // Listen for new invites
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

  // Listen for invites being REMOVED (sender cancelled)
  inviteRemovedListener = onChildRemoved(invitesRef, (snap) => {
    const removedId = snap.key;
    if (removedId === currentInviteId) {
      // The invite we're looking at was cancelled by sender
      currentInviteId = null;
      clearInviteTimer();
      if (onInviteCancelled) onInviteCancelled();
    }
  });
}

export function stopListeningForInvites() {
  const user = getCurrentUser();
  if (!user) return;

  if (inviteListener || inviteRemovedListener) {
    off(ref(db, `invitations/${user.uid}`));
    inviteListener = null;
    inviteRemovedListener = null;
  }
}

export async function acceptInviteAction() {
  const user = getCurrentUser();
  if (!user || !currentInviteId) return;

  await update(ref(db, `invitations/${user.uid}/${currentInviteId}`), {
    status: 'accepted'
  });

  // Listen for game creation
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
      inviteTimerInterval = null;
      declineInviteAction();
    }
  }, 100);
}

// ═══════════════════════════════════════
//  FRIEND REQUEST SYSTEM (persistent, no timer)
// ═══════════════════════════════════════

export async function sendFriendRequest(targetUid) {
  const user = getCurrentUser();
  const userData = getCurrentUserData();
  if (!user || !userData) return;

  // Check if already friends
  const myFriends = userData.friends || {};
  if (myFriends[targetUid]) {
    showToast('Already friends!', 'error');
    return;
  }

  // Check for existing request
  const existingSnap = await get(ref(db, `friendRequests/${targetUid}`));
  if (existingSnap.exists()) {
    const reqs = existingSnap.val();
    for (const [id, req] of Object.entries(reqs)) {
      if (req.from === user.uid && req.status === 'pending') {
        showToast('Friend request already sent!', 'error');
        return;
      }
    }
  }

  // Also check if they sent US a request (auto-accept)
  const reverseSnap = await get(ref(db, `friendRequests/${user.uid}`));
  if (reverseSnap.exists()) {
    const reqs = reverseSnap.val();
    for (const [id, req] of Object.entries(reqs)) {
      if (req.from === targetUid && req.status === 'pending') {
        // They already sent us a request — auto-accept both ways
        await acceptFriendRequestAction(id);
        showToast('You are now friends!', 'success');
        return;
      }
    }
  }

  const reqRef = push(ref(db, `friendRequests/${targetUid}`));
  await set(reqRef, {
    from: user.uid,
    fromUsername: userData.username,
    fromPlayerId: userData.playerId,
    status: 'pending',
    createdAt: Date.now()
  });

  showToast('Friend request sent!', 'success');
}

export async function acceptFriendRequestAction(requestId) {
  const user = getCurrentUser();
  if (!user) return;

  const reqRef = ref(db, `friendRequests/${user.uid}/${requestId}`);
  const snap = await get(reqRef);
  if (!snap.exists()) return;

  const req = snap.val();

  // Add both as friends
  const updates = {};
  updates[`users/${user.uid}/friends/${req.from}`] = true;
  updates[`users/${req.from}/friends/${user.uid}`] = true;

  await update(ref(db), updates);

  // Remove the request
  await remove(reqRef);

  showToast(`You and ${req.fromUsername} are now friends!`, 'success');
}

export async function declineFriendRequestAction(requestId) {
  const user = getCurrentUser();
  if (!user) return;

  await remove(ref(db, `friendRequests/${user.uid}/${requestId}`));
  showToast('Friend request declined', '');
}

// ── Listen for friend requests ──
export function startListeningFriendRequests() {
  const user = getCurrentUser();
  if (!user) return;

  const reqRef = ref(db, `friendRequests/${user.uid}`);
  friendRequestsListener = onValue(reqRef, (snap) => {
    const requests = [];
    if (snap.exists()) {
      const data = snap.val();
      for (const [id, req] of Object.entries(data)) {
        if (req.status === 'pending') {
          requests.push({ id, ...req });
        }
      }
    }
    if (onFriendRequestsUpdate) onFriendRequestsUpdate(requests);
  });
}

export function stopListeningFriendRequests() {
  const user = getCurrentUser();
  if (!user) return;
  if (friendRequestsListener) {
    off(ref(db, `friendRequests/${user.uid}`));
    friendRequestsListener = null;
  }
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
//  PLAYER SEARCH
// ═══════════════════════════════════════

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
