// ═══════════════════════════════════════
//  Multiplayer Game Engine — Fixed Sync, Turns & Mobile Touch
// ═══════════════════════════════════════
import {
  db, ref, set, get, update, onValue, off, push, onChildAdded
} from './firebase-config.js';
import { getCurrentUser, getCurrentUserData } from './auth.js';
import { sound } from './sound.js';
import { getRankFromPoints } from './ranking.js';

// ═══════ CONSTANTS ═══════
const COLS = 8, ROWS = 8;
const TOTAL_CELLS = ROWS * COLS; // 64
const CELL_GAP = 3;

const BLOCK_COLORS = [
  { bg: '#D62828', shine: '#FF6B6B', shadow: '#8B0000' },
  { bg: '#F46036', shine: '#FFB347', shadow: '#A03000' },
  { bg: '#F7C948', shine: '#FFE680', shadow: '#A08000' },
  { bg: '#3A7D44', shine: '#6FCF7F', shadow: '#1A4020' },
  { bg: '#2D6A9F', shine: '#5DA8E0', shadow: '#0D3060' },
  { bg: '#6B3FA0', shine: '#B07AE0', shadow: '#3A1060' },
];

const SHAPES_DEF = [
  { grid: [[1, 1], [1, 1]], cols: 2 },
  { grid: [[1, 1, 1]], cols: 3 },
  { grid: [[1], [1], [1]], cols: 1 },
  { grid: [[1, 0], [1, 0], [1, 1]], cols: 2 },
  { grid: [[0, 1], [0, 1], [1, 1]], cols: 2 },
  { grid: [[1, 1, 0], [0, 1, 1]], cols: 3 },
  { grid: [[0, 1, 1], [1, 1, 0]], cols: 3 },
  { grid: [[0, 1, 0], [1, 1, 1]], cols: 3 },
  { grid: [[1, 1, 1], [0, 1, 0]], cols: 3 },
  { grid: [[1, 1], [1, 0]], cols: 2 },
  { grid: [[1, 1], [0, 1]], cols: 2 },
  { grid: [[1]], cols: 1 },
  { grid: [[1, 1, 1], [1, 0, 0]], cols: 3 },
  { grid: [[1, 1, 1, 1]], cols: 4 },
];

// ═══════ GAME STATE ═══════
let gameId = null;
let gameRef = null;
let gameListener = null;
let chatListener = null;
let localGrid = [];          // local view of shared board (null = empty cell)
let myShapes = [null, null, null]; // PRIVATE inventory
let myCoins = 100;
let myScore = 0;
let oppScore = 0;
let myRole = null;           // 'player1' or 'player2'
let oppRole = null;
let currentTurn = null;       // 'player1' or 'player2'
let isMyTurn = false;
let hammerUsesThisTurn = 0;
let selectedSlot = null;
let hammerMode = false;
let isClearing = false;
let combo = 0;
let CELL_SIZE = 36;
let dragging = null;
let pendingResize = false;

// Per-player tracking for tiebreaker
let myLinesCleared = 0;
let myPowerUpsUsed = 0;

// Timers
let gameTimerInterval = null;
let turnTimerInterval = null;
let gameEndsAt = 0;
let turnStartedAt = 0;
let gameActive = false;

// Game mode: 'play' or 'vs'
let gameMode = 'play';

// Chat tracking
let lastChatTs = 0;

// Sync tracking
let lastProcessedMoveTs = 0;
let prevTurnValue = null;
let isFirstLoad = true;

// Callbacks
let onGameEnd = null;

export function setGameCallbacks({ onEnd }) {
  onGameEnd = onEnd;
}

// ═══════════════════════════════════════
//  HELPERS: Board serialisation
//  Firebase strips null from arrays, so we use 0 for empty cells.
// ═══════════════════════════════════════
function boardToFirebase(grid) {
  return grid.map(cell => {
    if (!cell) return 0;
    return { bg: cell.bg, shine: cell.shine, shadow: cell.shadow };
  });
}

function boardFromFirebase(fbBoard) {
  const grid = [];
  for (let i = 0; i < TOTAL_CELLS; i++) {
    const c = fbBoard ? fbBoard[i] : null;
    grid[i] = (c && typeof c === 'object') ? c : null;
  }
  return grid;
}

// ═══════════════════════════════════════
//  GAME INITIALIZATION
// ═══════════════════════════════════════
export async function startGame(gId, mode = 'play') {
  gameId = gId;
  gameRef = ref(db, `games/${gameId}`);
  gameMode = mode;

  const snap = await get(gameRef);
  if (!snap.exists()) { console.error('Game not found:', gameId); return; }

  const data = snap.val();
  const user = getCurrentUser();

  // Use gameMode from Firebase if available (for invited games)
  if (data.gameMode) gameMode = data.gameMode;

  // Determine roles
  if (data.players.player1.uid === user.uid) {
    myRole = 'player1'; oppRole = 'player2';
  } else {
    myRole = 'player2'; oppRole = 'player1';
  }

  // Init local state
  localGrid = boardFromFirebase(data.board);
  myCoins = 100;
  myScore = 0;
  oppScore = 0;
  combo = 0;
  hammerUsesThisTurn = 0;
  myLinesCleared = 0;
  myPowerUpsUsed = 0;
  selectedSlot = null;
  hammerMode = false;
  isClearing = false;
  gameActive = true;
  isEndGameCalled = false;
  lastProcessedMoveTs = 0;
  prevTurnValue = null;
  isFirstLoad = true;
  lastChatTs = 0;

  gameEndsAt = data.gameEndsAt;
  turnStartedAt = data.turnStartedAt;
  currentTurn = data.currentTurn;
  isMyTurn = (currentTurn === myRole);

  // Private inventory
  myShapes = [randomShape(), randomShape(), randomShape()];

  // Build UI
  calcCellSize();
  buildBoard();
  paintGrid();
  renderInventory();
  updateGameUI(data);
  updateTurnState();
  updatePowerupButtons();

  // Timers
  startGameTimer();
  startTurnTimer();

  // Music
  sound.startBGM();

  // Firebase listener
  listenForGameChanges();

  // Chat listener
  listenForChatMessages();

  // Hammer click handler
  setupBoardInteraction();
}

// ═══════════════════════════════════════
//  FIREBASE LISTENER — Board Sync + Turns
// ═══════════════════════════════════════
function listenForGameChanges() {
  gameListener = onValue(gameRef, (snap) => {
    if (!snap.exists()) return;
    const data = snap.val();

    // ── Game finished (ALWAYS check before gameActive) ──
    if (data.status === 'finished') {
      endGame(data);
      return;
    }

    if (!gameActive) return;

    // ── Scores & coins ──
    if (data.players) {
      myScore  = data.players[myRole]?.score  || 0;
      oppScore = data.players[oppRole]?.score || 0;
      const c  = data.players[myRole]?.coins;
      if (c !== undefined && c !== null) myCoins = c;

      // Keep tiebreaker fields synced
      myLinesCleared = data.players[myRole]?.linesCleared || 0;
      myPowerUpsUsed = data.players[myRole]?.powerUpsUsed || 0;
    }

    // ── BOARD SYNC ──
    if (data.board) {
      const serverGrid = boardFromFirebase(data.board);

      // Find differences between local board and server board
      const addedCells   = [];   // empty → filled
      const removedCells = [];  // filled → empty

      for (let i = 0; i < TOTAL_CELLS; i++) {
        const hasLocal  = !!localGrid[i];
        const hasServer = !!serverGrid[i];
        if (!hasLocal && hasServer)  addedCells.push(i);
        if (hasLocal  && !hasServer) removedCells.push(i);
      }

      const boardChanged = addedCells.length > 0 || removedCells.length > 0;

      if (boardChanged) {
        const isOpponentChange = data.lastMove &&
          data.lastMove.by === oppRole &&
          data.lastMove.timestamp > lastProcessedMoveTs;

        if (isOpponentChange) {
          lastProcessedMoveTs = data.lastMove.timestamp;

          // Animate placed cells
          if (addedCells.length > 0) {
            addedCells.forEach(i => {
              const cell = document.querySelector(`.cell[data-i="${i}"]`);
              if (cell) {
                cell.classList.add('pop-in');
                setTimeout(() => cell.classList.remove('pop-in'), 350);
              }
            });
            sound.play('place');
          }

          // Animate cleared cells
          if (removedCells.length > 0) {
            removedCells.forEach(i => {
              const cell = document.querySelector(`.cell[data-i="${i}"]`);
              if (cell) {
                cell.classList.add('clear-pop');
                const clr = localGrid[i];
                const r = cell.getBoundingClientRect();
                sparkle(r.left + r.width / 2, r.top + r.height / 2, clr ? clr.bg : '#F7C948');
              }
            });
            sound.play('pop');
            const bw = document.getElementById('board-wrapper');
            if (bw) {
              bw.classList.add('shake');
              setTimeout(() => bw.classList.remove('shake'), 400);
            }

            // Sync after animation completes, cleanly resetting cell states
            setTimeout(() => {
              localGrid = serverGrid;
              paintGrid();
            }, 320);
          } else {
            localGrid = serverGrid;
            paintGrid();
          }
        } else {
          // Own move or silent sync
          localGrid = serverGrid;
          paintGrid();
        }
      }
    }

    // ── TURN CHANGES ──
    const newTurn = data.currentTurn;
    if (newTurn !== prevTurnValue) {
      const wasFirst = isFirstLoad;
      isFirstLoad = false;
      prevTurnValue = newTurn;
      currentTurn = newTurn;
      isMyTurn = (currentTurn === myRole);
      turnStartedAt = data.turnStartedAt || Date.now();

      // Reset per-turn state
      hammerUsesThisTurn = 0;
      if (hammerMode) cancelHammer();

      // Restart turn timer
      startTurnTimer();

      if (!wasFirst) sound.play('turn');
    }

    // ── Update UI ──
    updateGameUI(data);
    updateTurnState();
    updatePowerupButtons();
  });
}

// ═══════════════════════════════════════
//  BOARD UI & RESPONSIVE SIZING
// ═══════════════════════════════════════
function calcCellSize() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Account for header, turn timer, inventory, powerups, paddings
  const overheadH = 250;
  const availableH = Math.max(160, vh - overheadH);
  const availableW = Math.min(vw - 28, 440);

  const maxByW = Math.floor((availableW - 35) / COLS);
  const maxByH = Math.floor((availableH - 35) / ROWS);

  CELL_SIZE = Math.max(22, Math.min(42, maxByW, maxByH));
}

function buildBoard() {
  const board = document.getElementById('board');
  if (!board) return;
  board.innerHTML = '';
  board.style.gridTemplateColumns = `repeat(${COLS}, ${CELL_SIZE}px)`;
  board.style.gridTemplateRows    = `repeat(${ROWS}, ${CELL_SIZE}px)`;
  board.style.gap = `${CELL_GAP}px`;

  for (let i = 0; i < TOTAL_CELLS; i++) {
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.dataset.i = i;
    board.appendChild(cell);
  }
}

function paintGrid() {
  const board = document.getElementById('board');
  if (!board) return;
  const cells = board.querySelectorAll('.cell');
  cells.forEach((cell, i) => {
    const c = localGrid[i];
    if (c) {
      cell.classList.add('filled');
      cell.classList.remove('clear-pop', 'hammer-smash');
      cell.style.background  = `linear-gradient(135deg, ${c.bg} 60%, ${c.shadow})`;
      cell.style.borderColor = c.shadow;
    } else {
      cell.classList.remove('filled', 'clear-pop', 'hammer-smash', 'pop-in');
      cell.style.background  = '';
      cell.style.borderColor = '';
    }
  });
}

// ═══════════════════════════════════════
//  UI UPDATES
// ═══════════════════════════════════════
function updateGameUI(data) {
  const my  = data.players[myRole];
  const opp = data.players[oppRole];

  const myNameEl = document.getElementById('gps-me-name');
  const myScoreEl = document.getElementById('gps-me-score');
  const oppNameEl = document.getElementById('gps-opp-name');
  const oppScoreEl = document.getElementById('gps-opp-score');
  const coinsEl = document.getElementById('game-coins-val');

  if (myNameEl) myNameEl.textContent = my?.username || 'You';
  if (myScoreEl) myScoreEl.textContent = my?.score || 0;
  if (oppNameEl) oppNameEl.textContent = opp?.username || 'Opp';
  if (oppScoreEl) oppScoreEl.textContent = opp?.score || 0;
  if (coinsEl) coinsEl.textContent = myCoins;

  const gpsMe = document.getElementById('gps-me');
  const gpsOpp = document.getElementById('gps-opp');
  if (gpsMe) gpsMe.classList.toggle('active-turn', currentTurn === myRole);
  if (gpsOpp) gpsOpp.classList.toggle('active-turn', currentTurn === oppRole);
}

function updateTurnState() {
  const indicator = document.getElementById('turn-indicator');
  const inventory = document.getElementById('inventory');
  const powerups  = document.getElementById('powerups');

  if (indicator) {
    if (isMyTurn) {
      indicator.textContent = '🟢 YOUR TURN';
      indicator.className = 'turn-indicator my-turn';
    } else {
      indicator.textContent = '🔴 OPPONENT\'S TURN';
      indicator.className = 'turn-indicator opponent-turn';
    }
  }

  if (inventory) inventory.classList.toggle('disabled', !isMyTurn);
  if (powerups) powerups.classList.toggle('disabled', !isMyTurn);
  if (!isMyTurn && hammerMode) cancelHammer();
}

// ═══════════════════════════════════════
//  TIMERS
// ═══════════════════════════════════════
function startGameTimer() {
  if (gameTimerInterval) clearInterval(gameTimerInterval);

  gameTimerInterval = setInterval(() => {
    if (!gameActive) return;
    const remaining = Math.max(0, Math.ceil((gameEndsAt - Date.now()) / 1000));
    const el  = document.getElementById('game-timer-val');
    const box = document.getElementById('game-timer-main');
    if (el)  el.textContent = remaining;
    if (box) box.classList.toggle('warning', remaining <= 15);

    if (remaining <= 10 && remaining > 0 && remaining % 2 === 0) sound.play('timerWarn');

    if (remaining <= 0) {
      clearInterval(gameTimerInterval);
      finishGame();
    }
  }, 250);
}

function startTurnTimer() {
  if (turnTimerInterval) clearInterval(turnTimerInterval);

  const fill = document.getElementById('turn-timer-fill');
  const turnDur = 10000;
  const turnStart = turnStartedAt || Date.now();

  turnTimerInterval = setInterval(() => {
    if (!gameActive) return;
    const elapsed   = Date.now() - turnStart;
    const remaining = Math.max(0, 1 - elapsed / turnDur);

    if (fill) {
      fill.style.width = (remaining * 100) + '%';
      fill.classList.toggle('warning', remaining < 0.3);
    }

    if (elapsed >= turnDur) {
      clearInterval(turnTimerInterval);
      if (gameActive) forceEndTurn();
    }
  }, 100);
}

// Safe turn switch with race-condition guard
async function forceEndTurn() {
  if (!gameActive || !gameRef) return;
  try {
    const snap = await get(gameRef);
    if (!snap.exists()) return;
    const data = snap.val();
    if (data.status !== 'playing') return;

    // Only switch if >= 9.8s have elapsed
    const elapsed = Date.now() - (data.turnStartedAt || 0);
    if (elapsed >= 9800) {
      const nextTurn = (data.currentTurn === 'player1') ? 'player2' : 'player1';
      await update(gameRef, {
        currentTurn: nextTurn,
        turnStartedAt: Date.now(),
        [`players/${data.currentTurn}/hammerUsesThisTurn`]: 0
      });
    }
  } catch (e) {
    console.error('Turn switch failed:', e);
  }
}

// ═══════════════════════════════════════
//  SEND MOVE + SWITCH TURN (atomic)
//  Called ONLY when a shape is placed on the board.
// ═══════════════════════════════════════
async function sendMoveAndSwitchTurn(indices, color) {
  if (!gameRef || !gameActive) return;

  const now = Date.now();

  await update(gameRef, {
    board: boardToFirebase(localGrid),
    [`players/${myRole}/score`]:           myScore,
    [`players/${myRole}/coins`]:           myCoins,
    [`players/${myRole}/linesCleared`]:     myLinesCleared,
    [`players/${myRole}/powerUpsUsed`]:     myPowerUpsUsed,
    [`players/${myRole}/hammerUsesThisTurn`]: 0,
    currentTurn:     oppRole,          // switch turn
    turnStartedAt:   now,
    lastMove: {
      by: myRole,
      indices,
      color: { bg: color.bg, shine: color.shine, shadow: color.shadow },
      timestamp: now
    }
  });
}

// Send board-only update (for hammer — does NOT switch turn)
async function sendBoardUpdate() {
  if (!gameRef || !gameActive) return;

  await update(gameRef, {
    board: boardToFirebase(localGrid),
    [`players/${myRole}/coins`]:              myCoins,
    [`players/${myRole}/powerUpsUsed`]:        myPowerUpsUsed,
    [`players/${myRole}/hammerUsesThisTurn`]: hammerUsesThisTurn
  });
}

// ═══════════════════════════════════════
//  GAME END + 3-LEVEL TIEBREAKER
// ═══════════════════════════════════════
let isEndGameCalled = false;

async function finishGame() {
  if (!gameRef) return;

  try {
    const snap = await get(gameRef);
    if (!snap.exists()) return;
    const data = snap.val();
    if (data.status === 'finished') return; // Already processed

    const p1 = data.players?.player1;
    const p2 = data.players?.player2;

    const p1Lines = p1?.linesCleared || 0;
    const p2Lines = p2?.linesCleared || 0;
    const p1PU    = p1?.powerUpsUsed || 0;
    const p2PU    = p2?.powerUpsUsed || 0;
    const lastTurn = data.currentTurn; // who had the turn when time expired

    let winner = 'draw';

    // Rule 1: More lines cleared wins
    if (p1Lines > p2Lines) {
      winner = 'player1';
    } else if (p2Lines > p1Lines) {
      winner = 'player2';
    }
    // Rule 2: Tie → fewer power-ups used wins
    else if (p1PU < p2PU) {
      winner = 'player1';
    } else if (p2PU < p1PU) {
      winner = 'player2';
    }
    // Rule 3: Still tie → player who was NOT on turn wins (player on turn timed out)
    else if (lastTurn === 'player2') {
      winner = 'player1';
    } else if (lastTurn === 'player1') {
      winner = 'player2';
    }

    const finishData = {
      status: 'finished',
      result: {
        winner,
        player1Score: p1?.score || 0,
        player2Score: p2?.score || 0,
        player1Lines: p1Lines,
        player2Lines: p2Lines,
        player1PU: p1PU,
        player2PU: p2PU
      }
    };

    await update(gameRef, finishData);
    endGame({ ...data, ...finishData });
  } catch (e) {
    console.error('Error in finishGame:', e);
  }
}

// ── Surrender / Leave Match ──
export async function surrenderGame() {
  if (!gameRef) return;
  try {
    const snap = await get(gameRef);
    if (!snap.exists()) return;
    const data = snap.val();
    if (data.status === 'finished') return;

    const p1 = data.players?.player1;
    const p2 = data.players?.player2;

    const finishData = {
      status: 'finished',
      result: {
        winner: oppRole,
        surrendered: myRole,
        player1Score: p1?.score || 0,
        player2Score: p2?.score || 0,
        player1Lines: p1?.linesCleared || 0,
        player2Lines: p2?.linesCleared || 0,
        player1PU: p1?.powerUpsUsed || 0,
        player2PU: p2?.powerUpsUsed || 0
      }
    };

    await update(gameRef, finishData);
    endGame({ ...data, ...finishData });
  } catch (e) {
    console.error('Surrender error:', e);
  }
}

function endGame(data) {
  if (isEndGameCalled) return;
  isEndGameCalled = true;
  gameActive = false;

  if (gameTimerInterval) { clearInterval(gameTimerInterval); gameTimerInterval = null; }
  if (turnTimerInterval) { clearInterval(turnTimerInterval); turnTimerInterval = null; }
  if (gameListener) { off(gameRef); gameListener = null; }
  if (chatListener) { chatListener = null; }

  sound.stopBGM();

  const myFinal  = data.players?.[myRole]?.score  || 0;
  const oppFinal = data.players?.[oppRole]?.score || 0;
  const winner   = data.result?.winner;

  let result = 'draw';
  if (winner === myRole)       result = 'win';
  else if (winner === oppRole) result = 'lose';

  if (result === 'win') sound.play('victory');
  else sound.play('gameover');

  // Update user stats — ONLY in Play mode, NOT VS
  const user = getCurrentUser();
  const userData = getCurrentUserData();
  const isGuest = userData?.isGuest || false;

  if (user && gameMode === 'play') {
    // Update basic stats for all play mode users
    const statsRef = ref(db, `users/${user.uid}/stats`);
    get(statsRef).then((statsSnap) => {
      const stats = statsSnap.exists() ? statsSnap.val() : { gamesPlayed: 0, wins: 0, losses: 0 };
      stats.gamesPlayed = (stats.gamesPlayed || 0) + 1;
      if (result === 'win') stats.wins = (stats.wins || 0) + 1;
      if (result === 'lose') stats.losses = (stats.losses || 0) + 1;
      set(statsRef, stats).catch(() => {});
    }).catch(() => {});

    // Update ranking stats — only for NON-Guest users in Play mode
    if (!isGuest) {
      const rankRef = ref(db, `users/${user.uid}/rankStats`);
      get(rankRef).then((rankSnap) => {
        const rs = rankSnap.exists() ? rankSnap.val() : { totalPoints: 0, totalRowsCleared: 0, totalWins: 0 };
        rs.totalPoints = (rs.totalPoints || 0) + myFinal;
        rs.totalRowsCleared = (rs.totalRowsCleared || 0) + (data.players?.[myRole]?.linesCleared || 0);
        if (result === 'win') rs.totalWins = (rs.totalWins || 0) + 1;
        set(rankRef, rs).catch(() => {});
      }).catch(() => {});
    }
  }
  // VS mode: NO stats updates at all

  if (onGameEnd) onGameEnd({
    result,
    myScore:  myFinal,
    oppScore: oppFinal,
    myName:  data.players?.[myRole]?.username  || 'You',
    oppName: data.players?.[oppRole]?.username || 'Opponent',
    surrendered: data.result?.surrendered
  });
}

// ═══════════════════════════════════════
//  SHAPES (private inventory)
// ═══════════════════════════════════════
function randomShape() {
  const src   = SHAPES_DEF[Math.floor(Math.random() * SHAPES_DEF.length)];
  const color = BLOCK_COLORS[Math.floor(Math.random() * BLOCK_COLORS.length)];
  return { def: { grid: src.grid.map(r => [...r]), cols: src.cols }, color };
}

function refillShapes() {
  for (let s = 0; s < 3; s++) {
    if (!myShapes[s]) myShapes[s] = randomShape();
  }
  renderInventory();
}

function renderInventory() {
  const inv = document.getElementById('inventory');
  if (!inv) return;
  inv.innerHTML = '';

  for (let s = 0; s < 3; s++) {
    const slot = document.createElement('div');
    slot.className = 'shape-slot';
    if (s === selectedSlot && myShapes[s]) slot.classList.add('selected');
    slot.dataset.slot = s;

    if (myShapes[s]) slot.appendChild(buildShapeEl(myShapes[s], s));
    inv.appendChild(slot);
  }
  updatePowerupButtons();
}

function buildShapeEl(shapeData, slotIdx) {
  const { def, color } = shapeData;
  const flat = def.grid.flat();
  const rows = def.grid.length, cols = def.cols;

  const el = document.createElement('div');
  el.className = 'shape';
  el.dataset.slot = slotIdx;

  const scale = Math.min(1, 62 / (Math.max(rows, cols) * (CELL_SIZE + CELL_GAP)));
  const bSize = Math.round(CELL_SIZE * scale);

  el.style.gridTemplateColumns = `repeat(${cols}, ${bSize}px)`;
  el.style.gridTemplateRows    = `repeat(${rows}, ${bSize}px)`;
  el.style.gap = `${CELL_GAP}px`;
  el.style.position = 'absolute';

  flat.forEach(v => {
    const b = document.createElement('div');
    b.className = 'block';
    if (!v) {
      b.style.visibility = 'hidden';
      b.style.pointerEvents = 'none';
    } else {
      b.style.background  = `linear-gradient(135deg, ${color.shine} 0%, ${color.bg} 55%, ${color.shadow} 100%)`;
      b.style.borderColor  = color.shadow;
      b.style.width  = `${bSize}px`;
      b.style.height = `${bSize}px`;
    }
    el.appendChild(b);
  });

  setupDragForShape(el, slotIdx);
  return el;
}

// ═══════════════════════════════════════
//  DRAG & DROP — Mobile-first & Touch-friendly
// ═══════════════════════════════════════
function getDragOffset() {
  // Comfortable vertical offset above finger
  return Math.max(35, Math.min(65, window.innerHeight * 0.07));
}

function setupDragForShape(el, slotIdx) {
  el.addEventListener('pointerdown', (e) => onPointerDown(e, el, slotIdx), { passive: false });
}

function onPointerDown(e, el, slotIdx) {
  if (isClearing || !isMyTurn || !gameActive || hammerMode || dragging) return;
  e.preventDefault();
  e.stopPropagation();

  const shape = myShapes[slotIdx];
  if (!shape) return;

  const isTouch = (e.pointerType === 'touch' || e.pointerType === 'pen');

  dragging = {
    slotIdx,
    def: shape.def,
    color: shape.color,
    el,
    dragEl: null,
    startX: e.clientX,
    startY: e.clientY,
    hasMoved: false,
    isTouch
  };

  // Immediate drag initialization on touch
  if (isTouch) {
    dragging.hasMoved = true;
    createDragElement(e);
    sound.play('pickup');
  }

  document.addEventListener('pointermove', globalPointerMove, { passive: false });
  document.addEventListener('pointerup',   globalPointerUp,   { passive: false });
  document.addEventListener('pointercancel', globalPointerCancel);
}

function createDragElement(e) {
  const { def, color } = dragging;
  const rows = def.grid.length, cols = def.cols;
  const offset = getDragOffset();

  const dragEl = document.createElement('div');
  dragEl.className = 'shape dragging';
  dragEl.style.gridTemplateColumns = `repeat(${cols}, ${CELL_SIZE}px)`;
  dragEl.style.gridTemplateRows    = `repeat(${rows}, ${CELL_SIZE}px)`;
  dragEl.style.gap = `${CELL_GAP}px`;
  dragEl.style.position = 'fixed';
  dragEl.style.zIndex = 1000;
  dragEl.style.pointerEvents = 'none';

  def.grid.flat().forEach(v => {
    const b = document.createElement('div');
    b.className = 'block';
    b.style.width  = `${CELL_SIZE}px`;
    b.style.height = `${CELL_SIZE}px`;
    if (!v) {
      b.style.visibility = 'hidden';
    } else {
      b.style.background  = `linear-gradient(135deg, ${color.shine} 0%, ${color.bg} 55%, ${color.shadow} 100%)`;
      b.style.borderColor  = color.shadow;
    }
    dragEl.appendChild(b);
  });

  const totalW = cols * CELL_SIZE + (cols - 1) * CELL_GAP;
  const totalH = rows * CELL_SIZE + (rows - 1) * CELL_GAP;
  dragEl.style.left = `${e.clientX - totalW / 2}px`;
  dragEl.style.top  = `${e.clientY - totalH / 2 - offset}px`;

  document.body.appendChild(dragEl);
  dragging.dragEl = dragEl;
  dragging.el.classList.add('shape-ghost');
}

function globalPointerMove(e) {
  if (!dragging) return;
  e.preventDefault();

  if (!dragging.hasMoved) {
    const dx = e.clientX - dragging.startX;
    const dy = e.clientY - dragging.startY;
    if (Math.sqrt(dx * dx + dy * dy) < 6) return;

    dragging.hasMoved = true;
    createDragElement(e);
    sound.play('pickup');
  }

  const { def } = dragging;
  const rows   = def.grid.length, cols = def.cols;
  const totalW = cols * CELL_SIZE + (cols - 1) * CELL_GAP;
  const totalH = rows * CELL_SIZE + (rows - 1) * CELL_GAP;
  const offset = getDragOffset();

  if (dragging.dragEl) {
    dragging.dragEl.style.left = `${e.clientX - totalW / 2}px`;
    dragging.dragEl.style.top  = `${e.clientY - totalH / 2 - offset}px`;
  }

  clearHighlights();
  const cells = getTargetCells(e.clientX, e.clientY, def);
  if (cells) {
    const valid = canPlace(cells.indices, localGrid);
    cells.indices.forEach(i => {
      const cell = document.querySelector(`.cell[data-i="${i}"]`);
      if (cell) cell.classList.add(valid ? 'highlight' : 'highlight-bad');
    });
  }
}

function globalPointerUp(e) {
  if (!dragging) return;
  e.preventDefault();

  // Desktop click without movement: toggle selection
  if (!dragging.hasMoved) {
    selectShape(dragging.slotIdx);
    dragging = null;
    removeDragListeners();
    return;
  }

  clearHighlights();

  const { slotIdx, def, color, dragEl, el } = dragging;
  const cells = getTargetCells(e.clientX, e.clientY, def);
  let placed = false;

  if (cells && canPlace(cells.indices, localGrid)) {
    // ══ PLACE THE SHAPE ON BOARD ══
    cells.indices.forEach(i => {
      localGrid[i] = color;
      const cell = document.querySelector(`.cell[data-i="${i}"]`);
      if (cell) {
        cell.classList.add('filled', 'pop-in');
        cell.style.background  = `linear-gradient(135deg, ${color.bg} 60%, ${color.shadow})`;
        cell.style.borderColor = color.shadow;
        setTimeout(() => cell.classList.remove('pop-in'), 350);
      }
    });

    myShapes[slotIdx] = null;
    if (selectedSlot === slotIdx) selectedSlot = null;
    placed = true;
    sparkle(e.clientX, e.clientY, color.bg);
    sound.play('place');

    if (dragEl) dragEl.remove();
    el.remove();

    // Check lines → then send move + switch turn ATOMICALLY
    setTimeout(() => {
      checkLines(() => {
        sendMoveAndSwitchTurn(cells.indices, color);
        if (myShapes.every(s => !s)) refillShapes();
        else renderInventory();
      });
    }, 120);
  }

  if (!placed) {
    if (dragEl) dragEl.remove();
    el.classList.remove('shape-ghost');
    el.classList.add('snap-back');
    setTimeout(() => el.classList.remove('snap-back'), 400);
    sound.play('snap');
  }

  dragging = null;
  removeDragListeners();
}

function globalPointerCancel() { cleanupDrag(); }

function cleanupDrag() {
  if (dragging) {
    if (dragging.dragEl) dragging.dragEl.remove();
    if (dragging.el) {
      dragging.el.classList.remove('shape-ghost');
      dragging.el.classList.add('snap-back');
      const el = dragging.el;
      setTimeout(() => el.classList.remove('snap-back'), 400);
    }
    dragging = null;
  }
  clearHighlights();
  removeDragListeners();
}

function removeDragListeners() {
  document.removeEventListener('pointermove', globalPointerMove);
  document.removeEventListener('pointerup',   globalPointerUp);
  document.removeEventListener('pointercancel', globalPointerCancel);
  if (pendingResize) { pendingResize = false; handleResize(); }
}

window.addEventListener('blur', cleanupDrag);
document.addEventListener('visibilitychange', () => { if (document.hidden) cleanupDrag(); });

// ── Prevent mobile scroll and zoom during gameplay ──
document.addEventListener('touchmove', (e) => {
  if (gameActive) e.preventDefault();
}, { passive: false });
document.addEventListener('gesturestart',  (e) => e.preventDefault(), { passive: false });
document.addEventListener('gesturechange', (e) => e.preventDefault(), { passive: false });

// ═══════════════════════════════════════
//  HIT DETECTION (Pixel-Perfect)
// ═══════════════════════════════════════
function getTargetCells(px, py, def) {
  const rows = def.grid.length, cols = def.cols;
  const totalW = cols * CELL_SIZE + (cols - 1) * CELL_GAP;
  const totalH = rows * CELL_SIZE + (rows - 1) * CELL_GAP;
  const offset = getDragOffset();
  const shapeLeft = px - totalW / 2;
  const shapeTop  = py - totalH / 2 - offset;

  const boardEl = document.getElementById('board');
  if (!boardEl) return null;
  const boardRect = boardEl.getBoundingClientRect();

  const col0 = Math.round((shapeLeft - boardRect.left) / (CELL_SIZE + CELL_GAP));
  const row0 = Math.round((shapeTop  - boardRect.top)  / (CELL_SIZE + CELL_GAP));

  const indices = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!def.grid[r][c]) continue;
      const gr = row0 + r, gc = col0 + c;
      if (gr < 0 || gr >= ROWS || gc < 0 || gc >= COLS) return null;
      indices.push(gr * COLS + gc);
    }
  }
  return { indices };
}

function canPlace(indices, g) {
  return indices.every(i => i >= 0 && i < TOTAL_CELLS && !g[i]);
}

function clearHighlights() {
  document.querySelectorAll('.cell.highlight, .cell.highlight-bad').forEach(c => {
    c.classList.remove('highlight', 'highlight-bad');
  });
}

// ═══════════════════════════════════════
//  LINE CLEARING — Clears Blocks, Keeps Grid Slots
// ═══════════════════════════════════════
function checkLines(callback) {
  const rowsToClear = [], colsToClear = [];

  for (let r = 0; r < ROWS; r++) {
    if (localGrid.slice(r * COLS, r * COLS + COLS).every(v => v)) rowsToClear.push(r);
  }
  for (let c = 0; c < COLS; c++) {
    let full = true;
    for (let r = 0; r < ROWS; r++) {
      if (!localGrid[r * COLS + c]) { full = false; break; }
    }
    if (full) colsToClear.push(c);
  }

  if (!rowsToClear.length && !colsToClear.length) {
    combo = 0;
    if (callback) callback();
    return;
  }

  const cleared = rowsToClear.length + colsToClear.length;
  myLinesCleared += cleared;
  combo++;
  isClearing = true;

  const toKill = new Set();
  rowsToClear.forEach(r => { for (let c = 0; c < COLS; c++) toKill.add(r * COLS + c); });
  colsToClear.forEach(c => { for (let r = 0; r < ROWS; r++) toKill.add(r * COLS + c); });

  const saved = {};
  toKill.forEach(i => { saved[i] = localGrid[i]; });

  toKill.forEach(i => {
    const cell = document.querySelector(`.cell[data-i="${i}"]`);
    if (cell) cell.classList.add('clear-pop');
  });

  // Score calculation
  const pts = cleared * 100 * combo;
  myScore += pts;

  const bx = document.getElementById('board-wrapper');
  if (bx) {
    const rect = bx.getBoundingClientRect();
    showScorePop(rect.left + rect.width / 2, rect.top + rect.height / 2 - 30, `+${pts}`);
    bx.classList.add('shake');
    setTimeout(() => bx.classList.remove('shake'), 400);
  }

  if (combo >= 2) {
    const banner = document.getElementById('combo-banner');
    if (banner) {
      banner.textContent = `${combo}x COMBO! 🔥`;
      banner.classList.add('show');
      setTimeout(() => banner.classList.remove('show'), 1200);
    }
    sound.play('combo');
  }

  toKill.forEach(i => {
    const cell = document.querySelector(`.cell[data-i="${i}"]`);
    if (cell) {
      const r = cell.getBoundingClientRect();
      sparkle(r.left + r.width / 2, r.top + r.height / 2, saved[i] ? saved[i].bg : '#F7C948');
    }
  });

  sound.play('pop');

  // After pop animation: cleanly empty the cells so they can receive blocks again
  setTimeout(() => {
    toKill.forEach(i => {
      localGrid[i] = null;
      const cell = document.querySelector(`.cell[data-i="${i}"]`);
      if (cell) {
        cell.classList.remove('clear-pop', 'filled', 'pop-in', 'hammer-smash');
        cell.style.background  = '';
        cell.style.borderColor = '';
      }
    });
    isClearing = false;
    if (callback) callback();
  }, 320);
}

// ═══════════════════════════════════════
//  SHAPE SELECTION (Desktop click)
// ═══════════════════════════════════════
function selectShape(slotIdx) {
  if (!myShapes[slotIdx] || !isMyTurn || !gameActive) return;

  selectedSlot = (selectedSlot === slotIdx) ? null : slotIdx;
  document.querySelectorAll('.shape-slot').forEach((slot, i) => {
    slot.classList.toggle('selected', i === selectedSlot && myShapes[i]);
  });
  updatePowerupButtons();
  sound.play('click');
}

// ═══════════════════════════════════════
//  POWER-UPS — Do NOT end the turn
// ═══════════════════════════════════════
function updatePowerupButtons() {
  const rot = document.getElementById('btn-rotate');
  const ham = document.getElementById('btn-hammer');
  const ref = document.getElementById('btn-refresh');
  if (!rot || !ham || !ref) return;

  if (!isMyTurn || !gameActive) {
    rot.classList.add('disabled');
    ham.classList.add('disabled');
    ref.classList.add('disabled');
    return;
  }

  rot.classList.toggle('disabled', myCoins < 20 || selectedSlot === null || !myShapes[selectedSlot]);
  ham.classList.toggle('disabled', myCoins < 30 || hammerUsesThisTurn >= 3);
  ref.classList.toggle('disabled', myCoins < 40);
  ham.classList.toggle('active', hammerMode);

  const usesEl = document.getElementById('hammer-uses');
  if (usesEl) usesEl.textContent = `${3 - hammerUsesThisTurn}/3`;
}

export function usePowerRotate() {
  if (isClearing || !isMyTurn || !gameActive) return;
  if (myCoins < 20) return;
  if (selectedSlot === null || !myShapes[selectedSlot]) {
    const inv = document.getElementById('inventory');
    if (inv) {
      inv.classList.remove('flash-hint');
      void inv.offsetWidth;
      inv.classList.add('flash-hint');
    }
    return;
  }

  myCoins -= 20;
  myPowerUpsUsed++;
  const coinsEl = document.getElementById('game-coins-val');
  if (coinsEl) coinsEl.textContent = myCoins;

  const shape = myShapes[selectedSlot];
  const old = shape.def.grid;
  const oldR = old.length, oldC = shape.def.cols;
  const rotated = [];
  for (let c = 0; c < oldC; c++) {
    const row = [];
    for (let r = oldR - 1; r >= 0; r--) row.push(old[r][c]);
    rotated.push(row);
  }
  shape.def = { grid: rotated, cols: oldR };

  sound.play('powerup');
  const btn = document.getElementById('btn-rotate');
  if (btn) {
    btn.classList.remove('used');
    void btn.offsetWidth;
    btn.classList.add('used');
  }

  update(gameRef, {
    [`players/${myRole}/coins`]:       myCoins,
    [`players/${myRole}/powerUpsUsed`]: myPowerUpsUsed
  });

  renderInventory();
}

export function usePowerHammer() {
  if (isClearing || !isMyTurn || !gameActive) return;
  if (myCoins < 30 || hammerUsesThisTurn >= 3) return;

  hammerMode = !hammerMode;
  const bw = document.getElementById('board-wrapper');
  if (bw) bw.classList.toggle('hammer-mode', hammerMode);
  updatePowerupButtons();
  if (hammerMode) sound.play('click');
  else cancelHammer();
}

function cancelHammer() {
  hammerMode = false;
  const bw = document.getElementById('board-wrapper');
  if (bw) bw.classList.remove('hammer-mode');
  updatePowerupButtons();
}

export function usePowerRefresh() {
  if (isClearing || !isMyTurn || !gameActive) return;
  if (myCoins < 40) return;
  if (!myShapes.some(s => s)) return;

  myCoins -= 40;
  myPowerUpsUsed++;
  const coinsEl = document.getElementById('game-coins-val');
  if (coinsEl) coinsEl.textContent = myCoins;

  selectedSlot = null;
  myShapes = [null, null, null];

  sound.play('powerup');
  const btn = document.getElementById('btn-refresh');
  if (btn) {
    btn.classList.remove('used');
    void btn.offsetWidth;
    btn.classList.add('used');
  }

  update(gameRef, {
    [`players/${myRole}/coins`]:       myCoins,
    [`players/${myRole}/powerUpsUsed`]: myPowerUpsUsed
  });

  refillShapes();
  setTimeout(() => {
    document.querySelectorAll('.shape').forEach(s => {
      s.classList.add('refresh-spin');
      setTimeout(() => s.classList.remove('refresh-spin'), 500);
    });
  }, 50);
}

// ═══════════════════════════════════════
//  HAMMER BOARD INTERACTION — Does NOT end turn
// ═══════════════════════════════════════
function setupBoardInteraction() {
  const board = document.getElementById('board');
  if (!board) return;
  board.removeEventListener('pointerdown', handleBoardClick);
  board.addEventListener('pointerdown', handleBoardClick, { passive: false });
}

function handleBoardClick(e) {
  if (!hammerMode || !isMyTurn || !gameActive) return;
  e.preventDefault();
  e.stopPropagation();

  const cell = e.target.closest('.cell');
  if (!cell) { cancelHammer(); return; }

  const i = parseInt(cell.dataset.i);
  if (!localGrid[i]) { cancelHammer(); return; }
  if (myCoins < 30 || hammerUsesThisTurn >= 3) { cancelHammer(); return; }

  // Destroy single block
  const color = localGrid[i];
  localGrid[i] = null;
  cell.classList.add('hammer-smash');
  setTimeout(() => {
    cell.classList.remove('hammer-smash', 'filled', 'pop-in', 'clear-pop');
    cell.style.background  = '';
    cell.style.borderColor = '';
  }, 350);

  const r = cell.getBoundingClientRect();
  sparkle(r.left + r.width / 2, r.top + r.height / 2, color.bg);

  myCoins -= 30;
  hammerUsesThisTurn++;
  myPowerUpsUsed++;
  const coinsEl = document.getElementById('game-coins-val');
  if (coinsEl) coinsEl.textContent = myCoins;
  sound.play('hammer');

  // Send board update (NO turn switch)
  sendBoardUpdate();

  if (hammerUsesThisTurn >= 3) cancelHammer();
  updatePowerupButtons();
}

// ═══════════════════════════════════════
//  VISUAL EFFECTS
// ═══════════════════════════════════════
function showScorePop(x, y, text) {
  const el = document.createElement('div');
  el.className = 'score-pop';
  el.textContent = text;
  el.style.left = `${x}px`;
  el.style.top  = `${y}px`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1000);
}

function sparkle(x, y, color) {
  for (let i = 0; i < 8; i++) {
    const s = document.createElement('div');
    s.className = 'spark';
    s.style.left = `${x}px`;
    s.style.top  = `${y}px`;
    s.style.background = color;
    const angle = Math.random() * 360;
    const dist  = 25 + Math.random() * 45;
    s.style.setProperty('--tx', `${Math.cos(angle * Math.PI / 180) * dist}px`);
    s.style.setProperty('--ty', `${Math.sin(angle * Math.PI / 180) * dist}px`);
    s.style.animationDuration = `${0.35 + Math.random() * 0.35}s`;
    document.body.appendChild(s);
    setTimeout(() => s.remove(), 750);
  }
}

// ═══════════════════════════════════════
//  RESIZE
// ═══════════════════════════════════════
function handleResize() {
  calcCellSize();
  buildBoard();
  paintGrid();
  renderInventory();
}

window.addEventListener('resize', () => {
  if (dragging) { pendingResize = true; return; }
  if (gameActive) handleResize();
});

// ═══════════════════════════════════════
//  IN-GAME CHAT SYSTEM (💬)
// ═══════════════════════════════════════
let chatTimeouts = [];

export async function sendChatMessage(text) {
  if (!gameRef || !gameActive) return;
  const cleanText = (text || '').trim();
  if (!cleanText || cleanText.length === 0) return;
  const finalMsg = cleanText.slice(0, 90);

  const now = Date.now();
  const chatRef = push(ref(db, `games/${gameId}/chat`));
  await set(chatRef, {
    senderRole: myRole,
    senderName: (getCurrentUserData() || {}).username || 'Player',
    text: finalMsg,
    timestamp: now
  });
}

function listenForChatMessages() {
  if (!gameRef) return;
  const chatListRef = ref(db, `games/${gameId}/chat`);

  chatListener = onChildAdded(chatListRef, (snap) => {
    if (!snap.exists()) return;
    const msg = snap.val();
    if (!msg || !msg.text) return;

    // Ignore stale messages
    if (msg.timestamp < (turnStartedAt || Date.now()) - 60000) return;

    const isMe = (msg.senderRole === myRole);
    displayChatBubble(msg.text, msg.senderName, isMe);
  });
}

function displayChatBubble(text, senderName, isMe) {
  let container = document.getElementById('chat-bubbles-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'chat-bubbles-container';
    container.className = 'chat-bubbles-container';
    document.body.appendChild(container);
  }

  const bubble = document.createElement('div');
  bubble.className = `chat-bubble ${isMe ? 'is-me' : 'is-opp'}`;

  // Safe text escaping
  const safeText = text.replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[m]);

  bubble.innerHTML = `
    <div class="chat-bubble-header">
      <span class="chat-bubble-avatar">${isMe ? '🔵' : '🔴'}</span>
      <span class="chat-bubble-sender">${isMe ? 'You' : (senderName || 'Opponent')}</span>
    </div>
    <div class="chat-bubble-text">${safeText}</div>
  `;

  container.appendChild(bubble);
  sound.play('click');

  // Fade out and remove after 5 seconds
  const t1 = setTimeout(() => {
    bubble.classList.add('fading-out');
  }, 4600);

  const t2 = setTimeout(() => {
    bubble.remove();
  }, 5000);

  chatTimeouts.push(t1, t2);
}

// ═══════════════════════════════════════
//  CLEANUP
// ═══════════════════════════════════════
export function cleanupGame() {
  gameActive = false;
  isEndGameCalled = false;
  if (gameTimerInterval) clearInterval(gameTimerInterval);
  if (turnTimerInterval) clearInterval(turnTimerInterval);
  if (gameListener && gameRef) { off(gameRef); gameListener = null; }
  if (chatListener && gameRef) { off(ref(db, `games/${gameId}/chat`)); chatListener = null; }

  // Clear chat bubbles and timeouts
  chatTimeouts.forEach(t => clearTimeout(t));
  chatTimeouts = [];
  const container = document.getElementById('chat-bubbles-container');
  if (container) container.innerHTML = '';

  const chatModal = document.getElementById('chat-modal');
  if (chatModal) chatModal.classList.remove('active');

  sound.stopBGM();
  gameId = null;
  gameRef = null;
  prevTurnValue = null;
  isFirstLoad = true;
  lastProcessedMoveTs = 0;
}

