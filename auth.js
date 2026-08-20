// ═══════════════════════════════════════
//  Authentication System
// ═══════════════════════════════════════
import {
  auth, db,
  GoogleAuthProvider, signInWithPopup, signInAnonymously,
  onAuthStateChanged, signOut,
  ref, set, get, update, onValue, onDisconnect, serverTimestamp
} from './firebase-config.js';

let currentUser = null;
let currentUserData = null;
let userDataListener = null;
let onAuthReadyCallback = null;

// ── Generate unique Player ID: 1 uppercase letter + 7 digits ──
function generatePlayerId() {
  const letter = String.fromCharCode(65 + Math.floor(Math.random() * 26));
  const digits = String(Math.floor(Math.random() * 10000000)).padStart(7, '0');
  return letter + digits;
}

// ── Ensure Player ID is unique ──
async function getUniquePlayerId() {
  let attempts = 0;
  while (attempts < 20) {
    const pid = generatePlayerId();
    const snap = await get(ref(db, `playerIds/${pid}`));
    if (!snap.exists()) return pid;
    attempts++;
  }
  // Fallback: use timestamp-based
  const letter = String.fromCharCode(65 + Math.floor(Math.random() * 26));
  return letter + String(Date.now()).slice(-7);
}

// ── Validate username ──
function validateUsername(name) {
  if (!name || name.length === 0) return 'Username is required';
  if (name.length > 14) return 'Max 14 characters';
  if (/\s/.test(name)) return 'No spaces allowed';
  if (!/^[a-zA-Z0-9]+$/.test(name)) return 'Letters and numbers only';
  if (name.length < 2) return 'At least 2 characters';
  return null;
}

// ── Check if username is taken ──
async function isUsernameTaken(name) {
  const snap = await get(ref(db, `usernames/${name.toLowerCase()}`));
  return snap.exists();
}

// ── Create user profile in RTDB ──
async function createUserProfile(uid, username, isGuest) {
  const playerId = await getUniquePlayerId();
  const now = Date.now();

  const userData = {
    username: username,
    playerId: playerId,
    isGuest: isGuest,
    createdAt: now,
    guestExpiresAt: isGuest ? now + (30 * 24 * 60 * 60 * 1000) : null,
    stats: {
      gamesPlayed: 0,
      wins: 0,
      losses: 0
    },
    rankStats: {
      totalPoints: 0,
      totalRowsCleared: 0,
      totalWins: 0
    },
    status: 'online',
    lastSeen: now
  };

  // Atomic writes
  const updates = {};
  updates[`users/${uid}`] = userData;
  updates[`usernames/${username.toLowerCase()}`] = uid;
  updates[`playerIds/${playerId}`] = uid;

  await update(ref(db), updates);
  return userData;
}

// ── Setup presence system ──
function setupPresence(uid) {
  const userStatusRef = ref(db, `users/${uid}/status`);
  const lastSeenRef = ref(db, `users/${uid}/lastSeen`);
  const connRef = ref(db, '.info/connected');

  onValue(connRef, (snap) => {
    if (snap.val() === true) {
      // Set offline on disconnect
      onDisconnect(userStatusRef).set('offline');
      onDisconnect(lastSeenRef).set(Date.now());

      // Set online
      set(userStatusRef, 'online');
      set(lastSeenRef, Date.now());
    }
  });
}

// ── Check guest expiration ──
function isGuestExpired(userData) {
  if (!userData.isGuest) return false;
  if (!userData.guestExpiresAt) return false;
  return Date.now() > userData.guestExpiresAt;
}

function getGuestDaysLeft(userData) {
  if (!userData.isGuest || !userData.guestExpiresAt) return 0;
  const msLeft = userData.guestExpiresAt - Date.now();
  return Math.max(0, Math.ceil(msLeft / (24 * 60 * 60 * 1000)));
}

// ═══════ PUBLIC API ═══════

export function getCurrentUser() { return currentUser; }
export function getCurrentUserData() { return currentUserData; }

export async function loginWithGoogle() {
  const provider = new GoogleAuthProvider();
  try {
    const result = await signInWithPopup(auth, provider);
    return result.user;
  } catch (error) {
    console.error('Google login error:', error);
    throw error;
  }
}

export async function loginAsGuest() {
  try {
    const result = await signInAnonymously(auth);
    return result.user;
  } catch (error) {
    console.error('Guest login error:', error);
    throw error;
  }
}

export async function logout() {
  if (currentUser) {
    try {
      await set(ref(db, `users/${currentUser.uid}/status`), 'offline');
    } catch (e) { /* ignore */ }
  }
  await signOut(auth);
  currentUser = null;
  currentUserData = null;
}

export async function setUsername(username) {
  if (!currentUser) throw new Error('Not logged in');

  // Validate
  const error = validateUsername(username);
  if (error) throw new Error(error);

  // Check taken
  const taken = await isUsernameTaken(username);
  if (taken) throw new Error('Username already taken');

  // Create profile
  const isGuest = currentUser.isAnonymous;
  currentUserData = await createUserProfile(currentUser.uid, username, isGuest);
  setupPresence(currentUser.uid);

  return currentUserData;
}

export async function getUserData(uid) {
  const snap = await get(ref(db, `users/${uid}`));
  return snap.exists() ? snap.val() : null;
}

export async function getUserByPlayerId(playerId) {
  const snap = await get(ref(db, `playerIds/${playerId}`));
  if (!snap.exists()) return null;
  const uid = snap.val();
  const userData = await getUserData(uid);
  if (!userData) return null;
  return { uid, ...userData };
}

export function onUserDataChange(callback) {
  if (!currentUser) return;
  if (userDataListener) {
    // Already listening
  }
  userDataListener = onValue(ref(db, `users/${currentUser.uid}`), (snap) => {
    if (snap.exists()) {
      currentUserData = snap.val();
      callback(currentUserData);
    }
  });
}

// ── Auth state initialization ──
export function initAuth(onReady) {
  onAuthReadyCallback = onReady;

  onAuthStateChanged(auth, async (user) => {
    if (user) {
      currentUser = user;

      // Check if user has a profile
      const userData = await getUserData(user.uid);

      if (userData) {
        // Check guest expiration
        if (isGuestExpired(userData)) {
          // Guest expired — sign out and show message
          await signOut(auth);
          currentUser = null;
          currentUserData = null;
          onAuthReadyCallback('expired');
          return;
        }

        currentUserData = userData;
        setupPresence(user.uid);
        onAuthReadyCallback('menu', userData);
      } else {
        // New user — needs username
        onAuthReadyCallback('username');
      }
    } else {
      currentUser = null;
      currentUserData = null;
      onAuthReadyCallback('auth');
    }
  });
}

export { validateUsername, isGuestExpired, getGuestDaysLeft };
