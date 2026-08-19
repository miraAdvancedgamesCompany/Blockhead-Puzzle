// ═══════════════════════════════════════
//  Multiplayer Game Engine — v3 Board Sync + Turns
// ═══════════════════════════════════════
import {
  db, ref, set, get, update, onValue, off
} from './firebase-config.js';
import { getCurrentUser, getCurrentUserData } from './auth.js';
import { sound } from './sound.js';

// ═══════ CONSTANTS ═══════
const COLS = 8, ROWS = 8;
const TOTAL_CELLS = ROWS * COLS; // 64

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
let localGrid = [];          // local view of shared board (null = empty)
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
let CELL_SIZE = 38;
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

// Sync tracking
let lastProcessedMoveTs = 0;
let prevTurnValue = null;
let isFirstLoad = true;
// Timestamp of our last sent board update — used to avoid re-animating our own changes
let myLastBoardSentTs = 0;

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
export async function startGame(gId) {
  gameId = gId;
  gameRef = ref(db, `games/${gameId}`);

  const snap = await get(gameRef);
  if (!snap.exists()) { console.error('Game not found:', gameId); return; }

  const data = snap.val();
  const user = getCurrentUser();

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
  lastProcessedMoveTs = 0;
  myLastBoardSentTs = 0;
  prevTurnValue = null;
  isFirstLoad = true;

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

  // Hammer click handler
  setupBoardInteraction();
}

// ═══════════════════════════════════════
//  FIREBASE LISTENER — Board Sync + Turns
// ═══════════════════════════════════════
function listenForGameChanges() {
  gameListener = onValue(gameRef, (snap) => {
    if (!snap.exists() || !gameActive) return;
    const data = snap.val();

    // ── Game finished ──
    if (data.status === 'finished') { endGame(data); return; }

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

    // ── BOARD SYNC — always compare & update ──
    if (data.board) {
      const serverGrid = boardFromFirebase(data.board);

      // Find differences between our local board and server board
      const addedCells  = [];   // empty → filled
      const removedCells = [];  // filled → empty

      for (let i = 0; i < TOTAL_CELLS; i++) {
        const hasLocal  = !!localGrid[i];
        const hasServer = !!serverGrid[i];
        if (!hasLocal && hasServer)  addedCells.push(i);
        if (hasLocal  && !hasServer) removedCells.push(i);
      }

      const boardChanged = addedCells.length > 0 || removedCells.length > 0;

      if (boardChanged) {
        // Determine if the change came from the OPPONENT
        const isOpponentChange = data.lastMove &&
          data.lastMove.by === oppRole &&
          data.lastMove.timestamp > lastProcessedMoveTs;

        if (isOpponentChange) {
          lastProcessedMoveTs = data.lastMove.timestamp;

          // Animate placed cells
          if (addedCells.length > 0) {
            addedCells.forEach(i => {
              const cell = document.querySelector(`.cell[data-i="${i}"]`);
              if (cell) { cell.classList.add('pop-in'); setTimeout(() => cell.classList.remove('pop-in'), 400); }
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
            bw.classList.add('shake');
            setTimeout(() => bw.classList.remove('shake'), 400);

            // Delay grid update so animation is visible
            setTimeout(() => { localGrid = serverGrid; paintGrid(); }, 300);
            // Skip immediate paint below
          } else {
            localGrid = serverGrid;
            paintGrid();
          }
        } else {
          // Our own change echoed back, OR an unknown change
          // Just sync silently
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
//  BOARD UI
// ═══════════════════════════════════════
function calcCellSize() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const maxByW = Math.floor((vw - 40) / COLS) - 3;
  const maxByH = Math.floor((vh - 280) / ROWS) - 3;
  CELL_SIZE = Math.max(26, Math.min(42, maxByW, maxByH));
}

function buildBoard() {
  const board = document.getElementById('board');
  board.innerHTML = '';
  board.style.gridTemplateColumns = `repeat(${COLS}, ${CELL_SIZE}px)`;
  board.style.gridTemplateRows    = `repeat(${ROWS}, ${CELL_SIZE}px)`;
  board.style.gap = '3px';

  for (let i = 0; i < TOTAL_CELLS; i++) {
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.dataset.i = i;
    board.appendChild(cell);
  }
}

function paintGrid() {
  const cells = document.getElementById('board').querySelectorAll('.cell');
  cells.forEach((cell, i) => {
    const c = localGrid[i];
    if (c) {
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
  const my  = data.players[myRole];
  const opp = data.players[oppRole];

  document.getElementById('gps-me-name').textContent  = my?.username  || 'You';
  document.getElementById('gps-me-score').textContent  = my?.score || 0;
  document.getElementById('gps-opp-name').textContent  = opp?.username || 'Opp';
  document.getElementById('gps-opp-score').textContent = opp?.score || 0;

  document.getElementById('game-coins-val').textContent = myCoins;

  document.getElementById('gps-me').classList.toggle('active-turn',  currentTurn === myRole);
  document.getElementById('gps-opp').classList.toggle('active-turn', currentTurn === oppRole);
}

function updateTurnState() {
  const indicator = document.getElementById('turn-indicator');
  const inventory = document.getElementById('inventory');
  const powerups  = document.getElementById('powerups');

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

async function forceEndTurn() {
  if (!gameActive || !gameRef) return;
  const newTurn = (currentTurn === 'player1') ? 'player2' : 'player1';
  try {
    await update(gameRef, { currentTurn: newTurn, turnStartedAt: Date.now() });
  } catch (e) { console.error('Turn switch failed:', e); }
}

// ═══════════════════════════════════════
//  SEND MOVE + SWITCH TURN (atomic)
//  Called ONLY when a shape is placed on the board.
//  Power-ups do NOT call this.
// ═══════════════════════════════════════
async function sendMoveAndSwitchTurn(indices, color) {
  if (!gameRef || !gameActive) return;

  const now = Date.now();
  myLastBoardSentTs = now;

  await update(gameRef, {
    board: boardToFirebase(localGrid),
    [`players/${myRole}/score`]:           myScore,
    [`players/${myRole}/coins`]:           myCoins,
    [`players/${myRole}/linesCleared`]:     myLinesCleared,
    [`players/${myRole}/powerUpsUsed`]:     myPowerUpsUsed,
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
  myLastBoardSentTs = Date.now();

  await update(gameRef, {
    board: boardToFirebase(localGrid),
    [`players/${myRole}/coins`]:       myCoins,
    [`players/${myRole}/powerUpsUsed`]: myPowerUpsUsed,
    [`players/${myRole}/hammerUsesThisTurn`]: hammerUsesThisTurn
  });
}

// ═══════════════════════════════════════
//  GAME END + TIEBREAKER
// ═══════════════════════════════════════
async function finishGame() {
  if (!gameActive) return;
  gameActive = false;

  const snap = await get(gameRef);
  if (!snap.exists()) return;
  const data = snap.val();
  if (data.status === 'finished') return;

  const p1 = data.players.player1;
  const p2 = data.players.player2;

  const p1Lines = p1?.linesCleared || 0;
  const p2Lines = p2?.linesCleared || 0;
  const p1PU    = p1?.powerUpsUsed || 0;
  const p2PU    = p2?.powerUpsUsed || 0;
  const lastTurn = data.currentTurn; // who was playing when time expired

  let winner = 'draw';

  // 1) More lines cleared wins
  if (p1Lines > p2Lines)      winner = 'player1';
  else if (p2Lines > p1Lines) winner = 'player2';
  // 2) Tie → fewer power-ups wins
  else if (p1PU < p2PU)       winner = 'player1';
  else if (p2PU < p1PU)       winner = 'player2';
  // 3) Still tie → player NOT on their turn wins
  else if (lastTurn === 'player2') winner = 'player1';
  else if (lastTurn === 'player1') winner = 'player2';

  await update(gameRef, {
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
  });

  // Update our stats
  const user = getCurrentUser();
  const statsRef = ref(db, `users/${user.uid}/stats`);
  const statsSnap = await get(statsRef);
  const stats = statsSnap.exists() ? statsSnap.val() : { gamesPlayed: 0, wins: 0, losses: 0 };
  stats.gamesPlayed = (stats.gamesPlayed || 0) + 1;

  const iWon  = (winner === myRole);
  const iLost = (winner !== 'draw' && winner !== myRole);
  if (iWon)  stats.wins   = (stats.wins   || 0) + 1;
  if (iLost) stats.losses = (stats.losses || 0) + 1;
  await set(statsRef, stats);
}

function endGame(data) {
  gameActive = false;
  if (gameTimerInterval) clearInterval(gameTimerInterval);
  if (turnTimerInterval) clearInterval(turnTimerInterval);
  if (gameListener) { off(gameRef); gameListener = null; }

  sound.stopBGM();

  const myFinal  = data.players[myRole]?.score  || 0;
  const oppFinal = data.players[oppRole]?.score || 0;
  const winner   = data.result?.winner;

  let result = 'draw';
  if (winner === myRole)       result = 'win';
  else if (winner === oppRole) result = 'lose';

  if (result === 'win') sound.play('victory');
  else sound.play('gameover');

  if (onGameEnd) onGameEnd({
    result,
    myScore:  myFinal,
    oppScore: oppFinal,
    myName:  data.players[myRole]?.username  || 'You',
    oppName: data.players[oppRole]?.username || 'Opponent'
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
  for (let s = 0; s < 3; s++) if (!myShapes[s]) myShapes[s] = randomShape();
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

  const scale = Math.min(1, 68 / (Math.max(rows, cols) * (CELL_SIZE + 3)));
  const bSize = Math.round(CELL_SIZE * scale);

  el.style.gridTemplateColumns = `repeat(${cols}, ${bSize}px)`;
  el.style.gridTemplateRows    = `repeat(${rows}, ${bSize}px)`;
  el.style.gap = '3px';
  el.style.position = 'absolute';

  flat.forEach(v => {
    const b = document.createElement('div');
    b.className = 'block';
    if (!v) { b.style.visibility = 'hidden'; b.style.pointerEvents = 'none'; }
    else {
      b.style.background  = `linear-gradient(135deg, ${color.shine} 0%, ${color.bg} 55%, ${color.shadow} 100%)`;
      b.style.borderColor  = color.shadow;
      b.style.width  = bSize + 'px';
      b.style.height = bSize + 'px';
    }
    el.appendChild(b);
  });

  setupDragForShape(el, slotIdx);
  return el;
}

// ═══════════════════════════════════════
//  DRAG & DROP — Mobile-first
// ═══════════════════════════════════════
function getDragOffset() { return Math.max(30, window.innerHeight * 0.04); }

function setupDragForShape(el, slotIdx) {
  el.addEventListener('pointerdown', (e) => onPointerDown(e, el, slotIdx), { passive: false });
}

function onPointerDown(e, el, slotIdx) {
  if (isClearing || !isMyTurn || !gameActive || hammerMode || dragging) return;
  e.preventDefault();
  e.stopPropagation();

  const shape = myShapes[slotIdx];
  if (!shape) return;

  const isTouch = (e.pointerType === 'touch');

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

  // On touch: immediately start drag (no threshold wait)
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
  dragEl.style.gap = '3px';
  dragEl.style.position = 'fixed';
  dragEl.style.zIndex = 1000;
  dragEl.style.pointerEvents = 'none';

  def.grid.flat().forEach(v => {
    const b = document.createElement('div');
    b.className = 'block';
    b.style.width  = CELL_SIZE + 'px';
    b.style.height = CELL_SIZE + 'px';
    if (!v) b.style.visibility = 'hidden';
    else {
      b.style.background  = `linear-gradient(135deg, ${color.shine} 0%, ${color.bg} 55%, ${color.shadow} 100%)`;
      b.style.borderColor  = color.shadow;
    }
    dragEl.appendChild(b);
  });

  const totalW = cols * CELL_SIZE + (cols - 1) * 3;
  const totalH = rows * CELL_SIZE + (rows - 1) * 3;
  dragEl.style.left = (e.clientX - totalW / 2) + 'px';
  dragEl.style.top  = (e.clientY - totalH / 2 - offset) + 'px';

  document.body.appendChild(dragEl);
  dragging.dragEl = dragEl;
  dragging.el.classList.add('shape-ghost');
}

function globalPointerMove(e) {
  if (!dragging) return;
  e.preventDefault();

  // Desktop: wait for threshold before starting drag
  if (!dragging.hasMoved) {
    const dx = e.clientX - dragging.startX;
    const dy = e.clientY - dragging.startY;
    if (Math.sqrt(dx * dx + dy * dy) < 8) return;

    dragging.hasMoved = true;
    createDragElement(e);
    sound.play('pickup');
  }

  const { def } = dragging;
  const rows   = def.grid.length, cols = def.cols;
  const totalW = cols * CELL_SIZE + (cols - 1) * 3;
  const totalH = rows * CELL_SIZE + (rows - 1) * 3;
  const offset = getDragOffset();
  dragging.dragEl.style.left = (e.clientX - totalW / 2) + 'px';
  dragging.dragEl.style.top  = (e.clientY - totalH / 2 - offset) + 'px';

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

  // TAP on desktop (no movement) → toggle selection
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
    // ══ PLACE the shape ══
    cells.indices.forEach(i => {
      localGrid[i] = color;
      const cell = document.querySelector(`.cell[data-i="${i}"]`);
      if (cell) {
        cell.classList.add('pop-in');
        cell.style.background  = `linear-gradient(135deg, ${color.bg} 60%, ${color.shadow})`;
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

    // Check lines → then send move + switch turn ATOMICALLY
    setTimeout(() => {
      checkLines(() => {
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

// ── Prevent scrolling & zooming during gameplay ──
document.addEventListener('touchmove', (e) => {
  if (gameActive) e.preventDefault();
}, { passive: false });
document.addEventListener('gesturestart',  (e) => e.preventDefault(), { passive: false });
document.addEventListener('gesturechange', (e) => e.preventDefault(), { passive: false });

// ═══════════════════════════════════════
//  HIT DETECTION
// ═══════════════════════════════════════
function getTargetCells(px, py, def) {
  const rows = def.grid.length, cols = def.cols;
  const totalW = cols * CELL_SIZE + (cols - 1) * 3;
  const totalH = rows * CELL_SIZE + (rows - 1) * 3;
  const offset = getDragOffset();
  const shapeLeft = px - totalW / 2;
  const shapeTop  = py - totalH / 2 - offset;

  const boardEl   = document.getElementById('board');
  const boardRect = boardEl.getBoundingClientRect();
  const gap = 3;

  const col0 = Math.round((shapeLeft - boardRect.left - 8) / (CELL_SIZE + gap));
  const row0 = Math.round((shapeTop  - boardRect.top  - 8) / (CELL_SIZE + gap));

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
//  LINE CLEARING — tracks linesCleared
// ═══════════════════════════════════════
function checkLines(callback) {
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

  const cleared = rowsToClear.length + colsToClear.length;
  myLinesCleared += cleared;  // ← track for tiebreaker
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

  // Score
  const pts = cleared * 100 * combo;
  myScore += pts;

  const bx = document.getElementById('board-wrapper');
  const cx = bx.getBoundingClientRect().left + bx.offsetWidth / 2;
  const cy = bx.getBoundingClientRect().top  + bx.offsetHeight / 2;
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
      sparkle(r.left + r.width / 2, r.top + r.height / 2, saved[i] ? saved[i].bg : '#F7C948');
    }
  });

  sound.play('pop');
  bx.classList.add('shake');
  setTimeout(() => bx.classList.remove('shake'), 400);

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
//  POWER-UPS — do NOT end the turn
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
    inv.classList.remove('flash-hint');
    void inv.offsetWidth;
    inv.classList.add('flash-hint');
    return;
  }

  myCoins -= 20;
  myPowerUpsUsed++;  // ← track for tiebreaker
  document.getElementById('game-coins-val').textContent = myCoins;

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
  btn.classList.remove('used'); void btn.offsetWidth; btn.classList.add('used');

  // Sync coins + powerups to server (NO turn switch)
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
  document.getElementById('board-wrapper').classList.toggle('hammer-mode', hammerMode);
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
  myPowerUpsUsed++;  // ← track
  document.getElementById('game-coins-val').textContent = myCoins;

  selectedSlot = null;
  myShapes = [null, null, null];

  sound.play('powerup');
  const btn = document.getElementById('btn-refresh');
  btn.classList.remove('used'); void btn.offsetWidth; btn.classList.add('used');

  // Sync (NO turn switch)
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
//  HAMMER BOARD INTERACTION — does NOT end turn
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
  if (myCoins < 30 || hammerUsesThisTurn >= 3) { cancelHammer(); return; }

  // Destroy block
  const color = localGrid[i];
  localGrid[i] = null;
  cell.classList.add('hammer-smash');
  setTimeout(() => {
    cell.classList.remove('hammer-smash', 'filled');
    cell.style.background  = '';
    cell.style.borderColor = '';
  }, 350);

  const r = cell.getBoundingClientRect();
  sparkle(r.left + r.width / 2, r.top + r.height / 2, color.bg);

  myCoins -= 30;
  hammerUsesThisTurn++;
  myPowerUpsUsed++;  // ← track
  document.getElementById('game-coins-val').textContent = myCoins;
  sound.play('hammer');

  // Send board + coins (NO turn switch)
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
  el.style.left = x + 'px';
  el.style.top  = y + 'px';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1000);
}

function sparkle(x, y, color) {
  for (let i = 0; i < 10; i++) {
    const s = document.createElement('div');
    s.className = 'spark';
    s.style.left = x + 'px';
    s.style.top  = y + 'px';
    s.style.background = color;
    const angle = Math.random() * 360;
    const dist  = 30 + Math.random() * 50;
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
  if (gameListener) { off(gameRef); gameListener = null; }
  sound.stopBGM();
  gameId = null;
  gameRef = null;
  prevTurnValue = null;
  isFirstLoad = true;
  lastProcessedMoveTs = 0;
  myLastBoardSentTs = 0;
}
