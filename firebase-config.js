// ═══════════════════════════════════════
//  Firebase Configuration & Initialization
// ═══════════════════════════════════════
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInAnonymously,
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js";
import {
  getDatabase,
  ref,
  set,
  get,
  update,
  remove,
  push,
  child,
  onValue,
  onChildAdded,
  onChildChanged,
  onChildRemoved,
  off,
  onDisconnect,
  serverTimestamp,
  runTransaction,
  query,
  orderByChild,
  equalTo,
  limitToFirst
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyBft4Dls54W_oBi5GTILHFErL2RbE-2QbQ",
  authDomain: "test-f9a4b.firebaseapp.com",
  databaseURL: "https://test-f9a4b-default-rtdb.firebaseio.com",
  projectId: "test-f9a4b",
  storageBucket: "test-f9a4b.firebasestorage.app",
  messagingSenderId: "268341978270",
  appId: "1:268341978270:web:94cacd33c1067a3c5ec78f"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

// Re-export everything modules need
export {
  auth, db, app,
  // Auth methods
  GoogleAuthProvider, signInWithPopup, signInAnonymously,
  onAuthStateChanged, signOut,
  // Database methods
  ref, set, get, update, remove, push, child,
  onValue, onChildAdded, onChildChanged, onChildRemoved, off,
  onDisconnect, serverTimestamp, runTransaction,
  query, orderByChild, equalTo, limitToFirst
};
