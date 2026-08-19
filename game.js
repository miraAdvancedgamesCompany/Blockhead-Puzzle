// ═══════════════════════════════════════
//  Multiplayer Game Engine — Fixed Turn System
// ═══════════════════════════════════════
import {
  db, ref, set, get, update, onValue, off
} from './firebase-config.js';
import { getCurrentUser, getCurrentUserData } from './auth.js';
import { sound } from './sound.js';

// ═══════ CONSTANTS ═══════
const COLS = 8, ROWS = 8;

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
let localGrid = [];
let myShapes = [null, null, null];
let myCoins = 100;
let myScore = 0;
let oppScore = 0;
let myRole = null; // 'player1' or 'player2'
let oppRole = null;
let currentTurn = null;
let isMyTurn = false;
let hammerUsesThisTurn = 0;
let selectedSlot = null;
let hammerMode = false;
let isClearing = false;
let combo = 0;
let CELL_SIZE = 38;
let dragging = null;
let pendingResize = false;

// Timers
let gameTimerInterval = null;
let turnTimerInterval = null;
let gameEndsAt = 0;
let turnStartedAt = 0;
let gameActive = false;

// Track processed moves to avoid double-processing
let lastProcessedMoveTimestamp = 0;
let prevTurnValue = null;
let isFirstLoad = true;

// Callbacks
let onGameEnd = null;

export function setGameCallbacks({ onEnd }) {
  onGameEnd = onEnd;
}

// ═══════════════════════════════════════
//  GAME INITIALIZATION
// ═══════════════════════════════════════

export async function startGame(gId) {
  gameId = gId;
  gameRef = ref(db, `games/${gameId}`);

  const snap = await get(gameRef);
  if (!snap.exists()) {
    console.error('Game not found:', gameId);
    return;
  }

  const gameData = snap.val();
  const user = getCurrentUser();

  // Determine our role
  if (gameData.players.player1.uid === user.uid) {
    myRole = 'player1';
    oppRole = 'player2';
  } else {
    myRole = 'player2';
    oppRole = 'player1';
  }

  // Initialize local state
  localGrid = new Array(ROWS * COLS).fill(null);
  if (gameData.board) {
    localGrid = gameData.board.map(cell =>
      (cell && typeof cell === 'object') ? cell : null
    );
  }

  myCoins = 100;
  myScore = 0;
  oppScore = 0;
  combo = 0;
  hammerUsesThisTurn = 0;
  selectedSlot = null;
  hammerMode = false;
  isClearing = false;
  gameActive = true;
  lastProcessedMoveTimestamp = 0;
  prevTurnValue = null;
  isFirstLoad = true;

  gameEndsAt = gameData.gameEndsAt;
  turnStartedAt = gameData.turnStartedAt;
  currentTurn = gameData.currentTurn;
  isMyTurn = (currentTurn === myRole);

  // Generate initial shapes locally (private)
  myShapes = [randomShape(), randomShape(), randomShape()];

  // Build the UI
  calcCellSize();
  buildBoard();
  paintGrid();
  renderInventory();
  updateGameUI(gameData);
  updateTurnState();
  updatePowerupButtons();

  // Start timers
  startGameTimer();
  startTurnTimer();

  // BGM
  sound.startBGM();

  // Listen for game changes from Firebase
  listenForGameChanges();

  // Setup hammer click handler
  setupBoardInteraction();
}

// ═══════════════════════════════════════
//  FIREBASE LISTENER — Turn & Board Sync
// ═══════════════════════════════════════

function listenForGameChanges() {
  gameListener = onValue(gameRef, (snap) => {
    if (!snap.exists() || !gameActive) return;
    const data = snap.val();

    // Game finished?
    if (data.status === 'finished') {
      endGame(data);
      return;
    }

    // ── Update scores from server ──
    if (data.players) {
      myScore = data.players[myRole]?.score || 0;
      oppScore = data.players[oppRole]?.score || 0;
      const serverCoins = data.players[myRole]?.coins;
      if (serverCoins !== undefined && serverCoins !== null) myCoins = serverCoins;
    }

    // ── Handle TURN changes ──
    const newTurn = data.currentTurn;
    if (newTurn !== prevTurnValue) {
      const wasFirst = isFirstLoad;
      isFirstLoad = false;
      prevTurnValue = newTurn;
      currentTurn = newTurn;
      isMyTurn = (currentTurn === myRole);
      turnStartedAt = data.turnStartedAt || Date.now();

      // Reset hammer uses for new turn
      hammerUsesThisTurn = 0;
      if (hammerMode) cancelHammer();
      selectedSlot = null;

      // Restart turn timer
      startTurnTimer();

      // Play sound (not on first load)
      if (!wasFirst) {
        sound.play('turn');
      }
    }

    // ── Handle opponent's MOVE (board update) ──
    if (data.lastMove && data.lastMove.by === oppRole &&
        data.lastMove.timestamp > lastProcessedMoveTimestamp) {
      lastProcessedMoveTimestamp = data.lastMove.timestamp;

      // Update board from server (opponent's move + any line clears)
      if (data.board) {
        // Show pop-in animation on placed cells
        const indices = data.lastMove.indices || [];
        indices.forEach(i => {
          const cell = document.querySelector(`.cell[data-i="${i}"]`);
          if (cell) {
            cell.classList.add('pop-in');
            setTimeout(() => cell.classList.remove('pop-in'), 400);
          }
        });

        // Detect cells that were cleared (present in old grid, gone in new)
        const newBoard = data.board.map(c => (c && typeof c === 'object') ? c : null);
        const clearedCells = [];
        for (let i = 0; i < ROWS * COLS; i++) {
          if (localGrid[i] && !newBoard[i]) {
            clearedCells.push(i);
          }
        }

        // If lines were cleared by opponent, show animation
        if (clearedCells.length > 0) {
          clearedCells.forEach(i => {
            const cell = document.querySelector(`.cell[data-i="${i}"]`);
            if (cell) {
              cell.classList.add('clear-pop');
              const clr = localGrid[i];
              const r = cell.getBoundingClientRect();
              sparkle(r.left + r.width / 2, r.top + r.height / 2, clr ? clr.bg : '#F7C948');
            }
          });

          sound.play('pop');
          document.getElementById('board-wrapper').classList.add('shake');
          setTimeout(() => document.getElementById('board-wrapper').classList.remove('shake'), 400);

          // Update grid after animation
          setTimeout(() => {
            localGrid = newBoard;
            paintGrid();
          }, 300);
        } else {
          localGrid = newBoard;
          paintGrid();
        }
      }

      sound.play('place');
    } else if (data.lastMove && data.lastMove.by === myRole) {
      // Our own move echoed back — just ensure board is synced
      // Don't re-animate, just update if needed
    }

    // Update UI
    updateGameUI(data);
    updateTurnState();
    updatePowerupButtons();
  });
}

// ═══════════════════════════════════════
//  BOARD BUILDING
// ═══════════════════════════════════════

function calcCellSize() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const headerH = 80, invH = 200, padding = 60;
  const maxByW = Math.floor((vw - 40) / COLS) - 3;
  const maxByH = Math.floor((vh - headerH - invH - padding) / ROWS) - 3;
  CELL_SIZE = Math.max(26, Math.min(42, maxByW, maxByH));
}

function buildBoard() {
  const board = document.getElementById('board');
  board.innerHTML = '';
  board.style.gridTemplateColumns = `repeat(${COLS}, ${CELL_SIZE}px)`;
  board.style.gridTemplateRows = `repeat(${ROWS}, ${CELL_SIZE}px)`;
  board.style.gap = '3px';

  for (let i = 0; i < ROWS * COLS; i++) {
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.dataset.i = i;
    board.appendChild(cell);
  }
}

function paintGrid() {
  const cells = document.getElementById('board').querySelectorAll('.cell');
  cells.forEach((cell, i) => {
    if (localGrid[i]) {
      const c = localGrid[i];
      cell.classList.add('filled');
      cell.style.background = `linear-gradient(135deg, ${c.bg} 60%, ${c.shadow})`;
      cell.style.borderColor = c.shadow;
    } else {
      cell.classList.remove('filled');
      cell.style.background = '';
      cell.style.borderColor = '';
    }
  });
}

// ═══════════════════════════════════════
//  UI UPDATES
// ═══════════════════════════════════════

function updateGameUI(data) {
  const myData = data.players[myRole];
  const oppData = data.players[oppRole];

  document.getElementById('gps-me-name').textContent = myData?.username || 'You';
  document.getElementById('gps-me-score').textContent = myScore;
  document.getElementById('gps-opp-name').textContent = oppData?.username || 'Opp';
  document.getElementById('gps-opp-score').textContent = oppScore;

  document.getElementById('game-coins-val').textContent = myCoins;

  document.getElementById('gps-me').classList.toggle('active-turn', currentTurn === myRole);
  document.getElementById('gps-opp').classList.toggle('active-turn', currentTurn === oppRole);
}

function updateTurnState() {
  const indicator = document.getElementById('turn-indicator');
  const inventory = document.getElementById('inventory');
  const powerups = document.getElementById('powerups');

  if (isMyTurn) {
    indicator.textContent = '🟢 YOUR TURN';
    indicator.className = 'turn-indicator my-turn';
    inventory.classList.remove('disabled');
    powerups.classList.remove('disabled');
  } else {
    indicator.textContent = '🔴 OPPONENT\'S TURN';
    indicator.className = 'turn-indicator opponent-turn';
    inventory.classList.add('disabled');
    powerups.classList.add('disabled');
    if (hammerMode) cancelHammer();
  }
}

// ═══════════════════════════════════════
//  TIMERS
// ═══════════════════════════════════════

function startGameTimer() {
  if (gameTimerInterval) clearInterval(gameTimerInterval);

  gameTimerInterval = setInterval(() => {
    if (!gameActive) return;

    const remaining = Math.max(0, Math.ceil((gameEndsAt - Date.now()) / 1000));
    const timerEl = document.getElementById('game-timer-val');
    const timerBox = document.getElementById('game-timer-main');

    if (timerEl) timerEl.textContent = remaining;
    if (timerBox) timerBox.classList.toggle('warning', remaining <= 15);

    if (remaining <= 10 && remaining > 0 && remaining % 2 === 0) {
      sound.play('timerWarn');
    }

    if (remaining <= 0) {
      clearInterval(gameTimerInterval);
      finishGame();
    }
  }, 250);
}

function startTurnTimer() {
  if (turnTimerInterval) clearInterval(turnTimerInterval);

  const fill = document.getElementById('turn-timer-fill');
  const turnDuration = 10000; // 10 seconds
  const turnStart = turnStartedAt || Date.now();

  turnTimerInterval = setInterval(() => {
    if (!gameActive) return;

    const elapsed = Date.now() - turnStart;
    const remaining = Math.max(0, 1 - elapsed / turnDuration);

    if (fill) {
      fill.style.width = (remaining * 100) + '%';
      fill.classList.toggle('warning', remaining < 0.3);
    }

    if (elapsed >= turnDuration) {
      clearInterval(turnTimerInterval);
      // Either player can trigger the turn switch
      if (gameActive) {
        forceEndTurn();
      }
    }
  }, 100);
}

// Force end turn when 10s timer runs out
async function forceEndTurn() {
  if (!gameActive || !gameRef) return;

  const newTurn = (currentTurn === 'player1') ? 'player2' : 'player1';
  const now = Date.now();

  try {
    await update(gameRef, {
      currentTurn: newTurn,
      turnStartedAt: now
    });
  } catch (e) {
    console.error('Failed to switch turn:', e);
  }
}

// ═══════════════════════════════════════
//  ATOMIC MOVE + TURN SWITCH
// ═══════════════════════════════════════

async function sendMoveAndSwitchTurn(indices, color) {
  if (!gameRef || !gameActive) return;

  const boardToSend = localGrid.map(cell => {
    if (!cell) return null;
    return { bg: cell.bg, shine: cell.shine, shadow: cell.shadow };
  });

  const newTurn = oppRole;
  const now = Date.now();

  // ATOMIC update: board + score + coins + turn switch all at once
  const updates = {
    board: boardToSend,
    [`players/${myRole}/score`]: myScore,
    [`players/${myRole}/coins`]: myCoins,
    [`players/${oppRole}/hammerUsesThisTurn`]: 0,
    currentTurn: newTurn,
    turnStartedAt: now,
    lastMove: {
      by: myRole,
      indices: indices,
      color: { bg: color.bg, shine: color.shine, shadow: color.shadow },
      timestamp: now
    }
  };

  try {
    await update(gameRef, updates);
  } catch (e) {
    console.error('Failed to send move:', e);
  }
}

async function finishGame() {
  if (!gameActive) return;
  gameActive = false;

  const snap = await get(gameRef);
  if (!snap.exists()) return;

  const data = snap.val();
  if (data.status === 'finished') return; // Already finished by other player

  const myFinalScore = data.players[myRole]?.score || 0;
  const oppFinalScore = data.players[oppRole]?.score || 0;

  let winnerRole = 'draw';
  if (myFinalScore > oppFinalScore) winnerRole = myRole;
  else if (oppFinalScore > myFinalScore) winnerRole = oppRole;

  await update(gameRef, {
    status: 'finished',
    result: {
      winner: winnerRole,
      player1Score: data.players.player1?.score || 0,
      player2Score: data.players.player2?.score || 0
    }
  });

  // Update stats
  const user = getCurrentUser();
  const statsRef = ref(db, `users/${user.uid}/stats`);
  const statsSnap = await get(statsRef);
  const stats = statsSnap.exists() ? statsSnap.val() : { gamesPlayed: 0, wins: 0, losses: 0 };

  stats.gamesPlayed = (stats.gamesPlayed || 0) + 1;
  const iWon = (winnerRole === myRole);
  const iLost = (winnerRole !== 'draw' && winnerRole !== myRole);
  if (iWon) stats.wins = (stats.wins || 0) + 1;
  if (iLost) stats.losses = (stats.losses || 0) + 1;

  await set(statsRef, stats);
}

function endGame(data) {
  gameActive = false;

  if (gameTimerInterval) clearInterval(gameTimerInterval);
  if (turnTimerInterval) clearInterval(turnTimerInterval);

  if (gameListener) {
    off(gameRef);
    gameListener = null;
  }

  sound.stopBGM();

  const myFinalScore = data.players[myRole]?.score || 0;
  const oppFinalScore = data.players[oppRole]?.score || 0;

  let result = 'draw';
  if (myFinalScore > oppFinalScore) result = 'win';
  else if (myFinalScore < oppFinalScore) result = 'lose';

  if (result === 'win') sound.play('victory');
  else sound.play('gameover');

  if (onGameEnd) {
    onGameEnd({
      result,
      myScore: myFinalScore,
      oppScore: oppFinalScore,
      myName: data.players[myRole]?.username || 'You',
      oppName: data.players[oppRole]?.username || 'Opponent'
    });
  }
}

// ═══════════════════════════════════════
//  SHAPES
// ═══════════════════════════════════════

function randomShape() {
  const src = SHAPES_DEF[Math.floor(Math.random() * SHAPES_DEF.length)];
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

    if (myShapes[s]) {
      const el = buildShapeEl(myShapes[s], s);
      slot.appendChild(el);
    }

    inv.appendChild(slot);
  }

  updatePowerupButtons();
}

function buildShapeEl(shapeData, slotIdx) {
  const { def, color } = shapeData;
  const flatCells = def.grid.flat();
  const rows = def.grid.length, cols = def.cols;

  const el = document.createElement('div');
  el.className = 'shape';
  el.dataset.slot = slotIdx;

  const scale = Math.min(1, 68 / (Math.max(rows, cols) * (CELL_SIZE + 3)));
  const bSize = Math.round(CELL_SIZE * scale);

  el.style.gridTemplateColumns = `repeat(${cols}, ${bSize}px)`;
  el.style.gridTemplateRows = `repeat(${rows}, ${bSize}px)`;
  el.style.gap = '3px';
  el.style.position = 'absolute';

  flatCells.forEach(v => {
    const b = document.createElement('div');
    b.className = 'block';
    if (!v) { b.style.visibility = 'hidden'; b.style.pointerEvents = 'none'; }
    else {
      b.style.background = `linear-gradient(135deg, ${color.shine} 0%, ${color.bg} 55%, ${color.shadow} 100%)`;
      b.style.borderColor = color.shadow;
      b.style.width = bSize + 'px';
      b.style.height = bSize + 'px';
    }
    el.appendChild(b);
  });

  setupDragForShape(el, slotIdx);
  return el;
}

// ═══════════════════════════════════════
//  DRAG & DROP — Mobile-friendly
// ═══════════════════════════════════════

const DRAG_THRESHOLD = ('ontouchstart' in window) ? 15 : 8; // Larger threshold on mobile

function getDragOffset() {
  return Math.max(30, window.innerHeight * 0.04);
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

  dragging = {
    slotIdx,
    def: shape.def,
    color: shape.color,
    el,
    dragEl: null,
    startX: e.clientX,
    startY: e.clientY,
    hasMoved: false
  };

  document.addEventListener('pointermove', globalPointerMove, { passive: false });
  document.addEventListener('pointerup', globalPointerUp, { passive: false });
  document.addEventListener('pointercancel', globalPointerCancel);
}

function createDragElement(e) {
  const { def, color } = dragging;
  const rows = def.grid.length, cols = def.cols;
  const offset = getDragOffset();

  const dragEl = document.createElement('div');
  dragEl.className = 'shape dragging';
  dragEl.style.gridTemplateColumns = `repeat(${cols}, ${CELL_SIZE}px)`;
  dragEl.style.gridTemplateRows = `repeat(${rows}, ${CELL_SIZE}px)`;
  dragEl.style.gap = '3px';
  dragEl.style.position = 'fixed';
  dragEl.style.zIndex = 1000;
  dragEl.style.pointerEvents = 'none';

  def.grid.flat().forEach(v => {
    const b = document.createElement('div');
    b.className = 'block';
    b.style.width = CELL_SIZE + 'px';
    b.style.height = CELL_SIZE + 'px';
    if (!v) { b.style.visibility = 'hidden'; }
    else {
      b.style.background = `linear-gradient(135deg, ${color.shine} 0%, ${color.bg} 55%, ${color.shadow} 100%)`;
      b.style.borderColor = color.shadow;
    }
    dragEl.appendChild(b);
  });

  const totalW = cols * CELL_SIZE + (cols - 1) * 3;
  const totalH = rows * CELL_SIZE + (rows - 1) * 3;
  dragEl.style.left = (e.clientX - totalW / 2) + 'px';
  dragEl.style.top = (e.clientY - totalH / 2 - offset) + 'px';

  document.body.appendChild(dragEl);
  dragging.dragEl = dragEl;
  dragging.el.classList.add('shape-ghost');
}

function globalPointerMove(e) {
  if (!dragging) return;
  e.preventDefault();

  const dx = e.clientX - dragging.startX;
  const dy = e.clientY - dragging.startY;

  if (!dragging.hasMoved && Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD) return;

  if (!dragging.hasMoved) {
    dragging.hasMoved = true;
    createDragElement(e);
    sound.play('pickup');
  }

  const { def } = dragging;
  const rows = def.grid.length, cols = def.cols;
  const totalW = cols * CELL_SIZE + (cols - 1) * 3;
  const totalH = rows * CELL_SIZE + (rows - 1) * 3;
  const offset = getDragOffset();
  dragging.dragEl.style.left = (e.clientX - totalW / 2) + 'px';
  dragging.dragEl.style.top = (e.clientY - totalH / 2 - offset) + 'px';

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

  // TAP (no significant movement) → select shape
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
    // ── PLACE the shape ──
    cells.indices.forEach(i => {
      localGrid[i] = color;
      const cell = document.querySelector(`.cell[data-i="${i}"]`);
      if (cell) {
        cell.classList.add('pop-in');
        cell.style.background = `linear-gradient(135deg, ${color.bg} 60%, ${color.shadow})`;
        cell.style.borderColor = color.shadow;
        cell.classList.add('filled');
        setTimeout(() => cell.classList.remove('pop-in'), 400);
      }
    });

    myShapes[slotIdx] = null;
    if (selectedSlot === slotIdx) selectedSlot = null;
    placed = true;
    sparkle(e.clientX, e.clientY, color.bg);
    sound.play('place');

    if (dragEl) dragEl.remove();
    el.remove();

    // Check lines THEN send move + switch turn atomically
    setTimeout(() => {
      checkLines(() => {
        // Send FINAL board state + switch turn in ONE update
        sendMoveAndSwitchTurn(cells.indices, color);

        if (myShapes.every(s => !s)) refillShapes();
        else renderInventory();
      });
    }, 150);
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

function globalPointerCancel() {
  cleanupDrag();
}

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
  document.removeEventListener('pointerup', globalPointerUp);
  document.removeEventListener('pointercancel', globalPointerCancel);

  if (pendingResize) {
    pendingResize = false;
    handleResize();
  }
}

window.addEventListener('blur', cleanupDrag);
document.addEventListener('visibilitychange', () => { if (document.hidden) cleanupDrag(); });

// Prevent mobile zoom & scroll in game
document.addEventListener('gesturestart', e => e.preventDefault(), { passive: false });
document.addEventListener('gesturechange', e => e.preventDefault(), { passive: false });

// ═══════════════════════════════════════
//  HIT DETECTION
// ═══════════════════════════════════════

function getTargetCells(px, py, def) {
  const rows = def.grid.length, cols = def.cols;
  const totalW = cols * CELL_SIZE + (cols - 1) * 3;
  const totalH = rows * CELL_SIZE + (rows - 1) * 3;
  const offset = getDragOffset();
  const shapeLeft = px - totalW / 2;
  const shapeTop = py - totalH / 2 - offset;

  const boardEl = document.getElementById('board');
  const boardRect = boardEl.getBoundingClientRect();
  const gap = 3;

  const col0 = Math.round((shapeLeft - boardRect.left - 8) / (CELL_SIZE + gap));
  const row0 = Math.round((shapeTop - boardRect.top - 8) / (CELL_SIZE + gap));

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
  return indices.every(i => i >= 0 && i < ROWS * COLS && !g[i]);
}

function clearHighlights() {
  document.querySelectorAll('.cell.highlight, .cell.highlight-bad').forEach(c => {
    c.classList.remove('highlight', 'highlight-bad');
  });
}

// ═══════════════════════════════════════
//  LINE CLEARING
// ═══════════════════════════════════════

function checkLines(callback) {
  let cleared = 0;
  const rowsToClear = [], colsToClear = [];

  for (let r = 0; r < ROWS; r++) {
    if (localGrid.slice(r * COLS, r * COLS + COLS).every(v => v)) rowsToClear.push(r);
  }
  for (let c = 0; c < COLS; c++) {
    let full = true;
    for (let r = 0; r < ROWS; r++) if (!localGrid[r * COLS + c]) { full = false; break; }
    if (full) colsToClear.push(c);
  }

  if (!rowsToClear.length && !colsToClear.length) {
    combo = 0;
    if (callback) callback();
    return;
  }

  cleared = rowsToClear.length + colsToClear.length;
  combo++;
  isClearing = true;

  const toKill = new Set();
  rowsToClear.forEach(r => { for (let c = 0; c < COLS; c++) toKill.add(r * COLS + c); });
  colsToClear.forEach(c => { for (let r = 0; r < ROWS; r++) toKill.add(r * COLS + c); });

  const savedColors = {};
  toKill.forEach(i => { savedColors[i] = localGrid[i]; });

  toKill.forEach(i => {
    const cell = document.querySelector(`.cell[data-i="${i}"]`);
    if (cell) cell.classList.add('clear-pop');
  });

  // Score
  const pts = cleared * 100 * combo;
  myScore += pts;

  const bx = document.getElementById('board-wrapper');
  const cx = bx.getBoundingClientRect().left + bx.offsetWidth / 2;
  const cy = bx.getBoundingClientRect().top + bx.offsetHeight / 2;
  showScorePop(cx, cy - 30, '+' + pts);

  if (combo >= 2) {
    const banner = document.getElementById('combo-banner');
    banner.textContent = combo + 'x COMBO! 🔥';
    banner.classList.add('show');
    setTimeout(() => banner.classList.remove('show'), 1200);
    sound.play('combo');
  }

  toKill.forEach(i => {
    const cell = document.querySelector(`.cell[data-i="${i}"]`);
    if (cell) {
      const r = cell.getBoundingClientRect();
      const clr = savedColors[i];
      sparkle(r.left + r.width / 2, r.top + r.height / 2, clr ? clr.bg : '#F7C948');
    }
  });

  sound.play('pop');
  document.getElementById('board-wrapper').classList.add('shake');
  setTimeout(() => document.getElementById('board-wrapper').classList.remove('shake'), 400);

  // After animation: clear grid and call back
  setTimeout(() => {
    toKill.forEach(i => {
      localGrid[i] = null;
      const cell = document.querySelector(`.cell[data-i="${i}"]`);
      if (cell) {
        cell.classList.remove('clear-pop', 'filled');
        cell.style.background = '';
        cell.style.borderColor = '';
      }
    });
    isClearing = false;
    if (callback) callback();
  }, 320);
}

// ═══════════════════════════════════════
//  SHAPE SELECTION
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
//  POWER-UPS
// ═══════════════════════════════════════

function updatePowerupButtons() {
  const rotBtn = document.getElementById('btn-rotate');
  const hamBtn = document.getElementById('btn-hammer');
  const refBtn = document.getElementById('btn-refresh');

  if (!rotBtn || !hamBtn || !refBtn) return;

  if (!isMyTurn || !gameActive) {
    rotBtn.classList.add('disabled');
    hamBtn.classList.add('disabled');
    refBtn.classList.add('disabled');
    return;
  }

  rotBtn.classList.toggle('disabled', myCoins < 20 || selectedSlot === null || !myShapes[selectedSlot]);
  hamBtn.classList.toggle('disabled', myCoins < 30 || hammerUsesThisTurn >= 3);
  refBtn.classList.toggle('disabled', myCoins < 40);

  hamBtn.classList.toggle('active', hammerMode);

  const usesEl = document.getElementById('hammer-uses');
  if (usesEl) usesEl.textContent = `${3 - hammerUsesThisTurn}/3`;
}

export function usePowerRotate() {
  if (isClearing || !isMyTurn || !gameActive) return;
  if (myCoins < 20) return;
  if (selectedSlot === null || !myShapes[selectedSlot]) {
    const inv = document.getElementById('inventory');
    inv.classList.remove('flash-hint');
    void inv.offsetWidth;
    inv.classList.add('flash-hint');
    return;
  }

  myCoins -= 20;
  document.getElementById('game-coins-val').textContent = myCoins;

  const shape = myShapes[selectedSlot];
  const oldGrid = shape.def.grid;
  const oldRows = oldGrid.length;
  const oldCols = shape.def.cols;
  const newGrid = [];
  for (let c = 0; c < oldCols; c++) {
    const row = [];
    for (let r = oldRows - 1; r >= 0; r--) {
      row.push(oldGrid[r][c]);
    }
    newGrid.push(row);
  }
  shape.def = { grid: newGrid, cols: oldRows };

  sound.play('powerup');
  const btn = document.getElementById('btn-rotate');
  btn.classList.remove('used');
  void btn.offsetWidth;
  btn.classList.add('used');

  update(gameRef, { [`players/${myRole}/coins`]: myCoins });
  renderInventory();
}

export function usePowerHammer() {
  if (isClearing || !isMyTurn || !gameActive) return;
  if (myCoins < 30 || hammerUsesThisTurn >= 3) return;

  hammerMode = !hammerMode;
  document.getElementById('board-wrapper').classList.toggle('hammer-mode', hammerMode);
  updatePowerupButtons();

  if (hammerMode) {
    sound.play('click');
  } else {
    cancelHammer();
  }
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

  const hasShapes = myShapes.some(s => s);
  if (!hasShapes) return;

  myCoins -= 40;
  document.getElementById('game-coins-val').textContent = myCoins;

  selectedSlot = null;
  myShapes = [null, null, null];

  sound.play('powerup');
  const btn = document.getElementById('btn-refresh');
  btn.classList.remove('used');
  void btn.offsetWidth;
  btn.classList.add('used');

  update(gameRef, { [`players/${myRole}/coins`]: myCoins });
  refillShapes();

  setTimeout(() => {
    document.querySelectorAll('.shape').forEach(s => {
      s.classList.add('refresh-spin');
      setTimeout(() => s.classList.remove('refresh-spin'), 500);
    });
  }, 50);
}

// ═══════════════════════════════════════
//  HAMMER BOARD INTERACTION
// ═══════════════════════════════════════

function setupBoardInteraction() {
  const board = document.getElementById('board');
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

  if (myCoins < 30 || hammerUsesThisTurn >= 3) {
    cancelHammer();
    return;
  }

  const color = localGrid[i];
  localGrid[i] = null;
  cell.classList.add('hammer-smash');
  setTimeout(() => {
    cell.classList.remove('hammer-smash', 'filled');
    cell.style.background = '';
    cell.style.borderColor = '';
  }, 350);

  const r = cell.getBoundingClientRect();
  sparkle(r.left + r.width / 2, r.top + r.height / 2, color.bg);

  myCoins -= 30;
  hammerUsesThisTurn++;
  document.getElementById('game-coins-val').textContent = myCoins;
  sound.play('hammer');

  // Update server (board + coins + hammer uses) — NOT switching turn
  const boardToSend = localGrid.map(c => {
    if (!c) return null;
    return { bg: c.bg, shine: c.shine, shadow: c.shadow };
  });

  update(gameRef, {
    board: boardToSend,
    [`players/${myRole}/coins`]: myCoins,
    [`players/${myRole}/hammerUsesThisTurn`]: hammerUsesThisTurn
  });

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
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1000);
}

function sparkle(x, y, color) {
  for (let i = 0; i < 10; i++) {
    const s = document.createElement('div');
    s.className = 'spark';
    s.style.left = x + 'px';
    s.style.top = y + 'px';
    s.style.background = color;
    const angle = Math.random() * 360;
    const dist = 30 + Math.random() * 50;
    s.style.setProperty('--tx', Math.cos(angle * Math.PI / 180) * dist + 'px');
    s.style.setProperty('--ty', Math.sin(angle * Math.PI / 180) * dist + 'px');
    s.style.animationDuration = (0.4 + Math.random() * 0.4) + 's';
    document.body.appendChild(s);
    setTimeout(() => s.remove(), 900);
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
//  CLEANUP
// ═══════════════════════════════════════

export function cleanupGame() {
  gameActive = false;
  if (gameTimerInterval) clearInterval(gameTimerInterval);
  if (turnTimerInterval) clearInterval(turnTimerInterval);
  if (gameListener) {
    off(gameRef);
    gameListener = null;
  }
  sound.stopBGM();
  gameId = null;
  gameRef = null;
  prevTurnValue = null;
  isFirstLoad = true;
  lastProcessedMoveTimestamp = 0;
}
