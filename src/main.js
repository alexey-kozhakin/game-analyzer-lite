import { Chess } from 'chess.js';
import { Chessground } from 'chessground';
import 'chessground/assets/chessground.base.css';
import 'chessground/assets/chessground.brown.css';
import 'chessground/assets/chessground.cburnett.css';
import './style.css';

const app = document.querySelector('#app');
const DEFAULT_USERNAME = 'alexey-kozhakin';
const DEFAULT_DEPTH = 12;
const DEFAULT_GAMES_LIMIT = 10;
const GAME_TIME_CLASS = 'rapid';
const LOSS_EXCELLENT_MAX = 10;
const LOSS_GOOD_MAX = 30;
const LOSS_INACCURACY_MAX = 70;
const LOSS_MISTAKE_MAX = 200;
const BRILLIANT_MATERIAL_DROP = 2;
const GREAT_SWING_THRESHOLD = 150;
const MISS_WIN_THRESHOLD = 85;
const MISS_LOSS_THRESHOLD = 150;
const TRAINER_EQUAL_THRESHOLD = 100;
const TRAINER_LIMIT_OPTIONS = [10, 20, 50];
const TRAINER_BRUSHES = {
  best: { key: 'tb', color: '#22d3ee', opacity: 1, lineWidth: 10 },
  played: { key: 'tp', color: '#ec4899', opacity: 1, lineWidth: 10 },
  oppChecks: { key: 'oc', color: '#e53935', opacity: 1, lineWidth: 10 },
  oppCaptures: { key: 'ox', color: '#fb8c00', opacity: 1, lineWidth: 10 },
  oppAttacks: { key: 'oa', color: '#fdd835', opacity: 1, lineWidth: 10 },
  myChecks: { key: 'mc', color: '#42a5f5', opacity: 1, lineWidth: 10 },
  myCaptures: { key: 'mx', color: '#66bb6a', opacity: 1, lineWidth: 10 },
  myAttacks: { key: 'ma', color: '#ab47bc', opacity: 1, lineWidth: 10 },
};
const PIECE_VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const REVIEW_CATEGORIES = ['Brilliant', 'Great', 'Best', 'Excellent', 'Good', 'Inaccuracy', 'Mistake', 'Miss', 'Blunder'];

const state = {
  username: DEFAULT_USERNAME,
  gamesLimit: DEFAULT_GAMES_LIMIT,
  games: [],
  selected: -1,
  analysis: null,
  analysing: false,
  replayIndex: 0,
  replayBoard: null,
  replayChess: null,
  replayFlipped: false,
  replayHintsColor: 'off',
  replayVersion: 0,
  view: 'game',
  trainer: {
    limit: 20,
    positions: [],
    index: 0,
    scanning: false,
  },
  trainerBoard: null,
  trainerChess: null,
  trainerVersion: 0,
  trainerShowBest: false,
  trainerShowPlayed: false,
  trainerThreats: { oppChecks: false, oppCaptures: false, oppAttacks: false, myChecks: false, myCaptures: false, myAttacks: false },
};

async function fetchArchives(username) {
  const response = await fetch(`https://api.chess.com/pub/player/${encodeURIComponent(username)}/games/archives`);
  if (!response.ok) throw new Error(`Chess.com вернул ошибку ${response.status}`);
  return (await response.json()).archives;
}

async function fetchMonth(archiveUrl) {
  const response = await fetch(archiveUrl);
  if (!response.ok) return [];
  return (await response.json()).games || [];
}

async function fetchLastGames(username, limit) {
  const archives = await fetchArchives(username);
  const games = [];
  for (let index = archives.length - 1; index >= 0 && games.length < limit; index--) {
    const monthGames = await fetchMonth(archives[index]);
    games.push(...monthGames.filter(game => game.time_class === GAME_TIME_CLASS));
  }
  return games.sort((a, b) => b.end_time - a.end_time).slice(0, limit);
}

function playerColorFor(game, username) {
  if (game.white.username.toLowerCase() === username.toLowerCase()) return 'w';
  if (game.black.username.toLowerCase() === username.toLowerCase()) return 'b';
  return null;
}

function gameOutcomeFor(game, color) {
  const playerSide = color === 'w' ? 'white' : 'black';
  const opponentSide = color === 'w' ? 'black' : 'white';
  if (game[playerSide].result === 'win') return 'Победа';
  if (game[opponentSide].result === 'win') return 'Поражение';
  return 'Ничья';
}

function openingNameFor(game) {
  if (!game.eco) return '—';
  const slug = game.eco.split('/').pop() || '';
  return slug.replace(/-/g, ' ');
}

class BrowserStockfish {
  constructor() {
    this.worker = new Worker(`${import.meta.env.BASE_URL}engine/stockfish-18-lite-single.js`);
    this.ready = new Promise((resolve, reject) => {
      this._ready = resolve;
      this._readyReject = reject;
    });
    this.current = null;
    this.worker.onmessage = event => this.receive(String(event.data));
    this.worker.onerror = event => this._readyReject(new Error(`Stockfish не запустился: ${event.message || 'ошибка Web Worker'}`));
    this.worker.postMessage('uci');
  }
  receive(line) {
    if (line === 'uciok') this.worker.postMessage('isready');
    if (line === 'readyok') this._ready();
    if (this.current?.lines && line.startsWith('info ') && line.includes(' score ')) this.current.lines.push(line);
    if (this.current && line.startsWith('bestmove ')) {
      const best = [...this.current.lines].reverse().find(item => item.includes(' pv '));
      const score = best?.match(/score (cp|mate) (-?\d+)/);
      const pv = best?.match(/ pv (.+)$/);
      const resolve = this.current.resolve;
      this.current = null;
      resolve({ score: score ? { type: score[1], value: Number(score[2]) } : { type: 'cp', value: 0 }, pv: pv ? pv[1].split(' ') : [] });
    }
  }
  async analyse(fen, depth = DEFAULT_DEPTH) {
    await this.ready;
    while (this.current) await new Promise(resolve => setTimeout(resolve, 10));
    return new Promise(resolve => {
      this.current = { resolve, lines: [] };
      this.worker.postMessage(`position fen ${fen}`);
      this.worker.postMessage(`go depth ${depth}`);
    });
  }
}
const engine = new BrowserStockfish();

function scoreFor(info, color, fen) {
  const raw = info.score.type === 'mate' ? Math.sign(info.score.value) * (100000 - Math.abs(info.score.value)) : info.score.value;
  // UCI reports a score from the point of view of the side to move in `fen`.
  // Convert it first to White's point of view, then to the requested player.
  const whiteScore = fen.split(' ')[1] === 'w' ? raw : -raw;
  return color === 'w' ? whiteScore : -whiteScore;
}
function sanFor(board, uci) { return uci ? board.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || 'q' })?.san : '—'; }
function materialBalance(fen, color) {
  let balance = 0;
  new Chess(fen).board().forEach(row => row.forEach(square => {
    if (!square) return;
    balance += square.color === color ? PIECE_VALUES[square.type] : -PIECE_VALUES[square.type];
  }));
  return balance;
}
function winPercent(cp) {
  const capped = Math.max(-1000, Math.min(1000, cp));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * capped)) - 1);
}
function moveAccuracyFromWinDiff(winDiff) {
  return Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * winDiff) - 3.1669));
}
function harmonicMean(values) {
  if (!values.length) return 0;
  return values.length / values.reduce((sum, value) => sum + 1 / Math.max(value, 0.01), 0);
}
function classifyMove({ loss, winBefore, materialDrop, swing }) {
  let category;
  if (loss <= 0) category = 'Best';
  else if (loss <= LOSS_EXCELLENT_MAX) category = 'Excellent';
  else if (loss <= LOSS_GOOD_MAX) category = 'Good';
  else if (loss <= LOSS_INACCURACY_MAX) category = 'Inaccuracy';
  else if (loss <= LOSS_MISTAKE_MAX) category = 'Mistake';
  else category = 'Blunder';
  if (loss <= LOSS_EXCELLENT_MAX && materialDrop >= BRILLIANT_MATERIAL_DROP) category = 'Brilliant';
  else if (loss <= 0 && swing >= GREAT_SWING_THRESHOLD) category = 'Great';
  if (winBefore >= MISS_WIN_THRESHOLD && loss >= MISS_LOSS_THRESHOLD) category = 'Miss';
  return category;
}
function buildSideReview(moveReviews, color) {
  const moves = moveReviews.filter(item => item.color === color);
  const counts = Object.fromEntries(REVIEW_CATEGORIES.map(category => [category, 0]));
  moves.forEach(move => { counts[move.category]++; });
  const acpl = moves.length ? Math.round(moves.reduce((sum, move) => sum + move.loss, 0) / moves.length) : 0;
  const accuracies = moves.map(move => move.moveAccuracy);
  const accuracy = accuracies.length ? (accuracies.reduce((sum, value) => sum + value, 0) / accuracies.length + harmonicMean(accuracies)) / 2 : 100;
  const estimatedElo = Math.round(Math.max(400, Math.min(2900, 903.7 - 3.37 * Math.log(1 + acpl / 56.32))));
  return { counts, acpl, accuracy, estimatedElo };
}
function formatScore(value) { return `${value >= 0 ? '+' : ''}${(value / 100).toFixed(2)}`; }
function advantageText(whiteScore) {
  if (Math.abs(whiteScore) < 30) return 'примерно равно';
  return `преимущество ${whiteScore > 0 ? 'белых' : 'чёрных'}`;
}
function replayColorName(color) { return color === 'w' ? 'white' : 'black'; }
function evaluationBarHtml(score, idPrefix = 'replay') {
  const whitePercent = Math.max(3, Math.min(97, 50 + score / 20));
  return `<div id="${idPrefix}-eval-bar" class="eval-bar" title="${formatScore(score)} для белых"><div class="eval-bar-black"></div><div class="eval-bar-white" style="height:${whitePercent}%"><b>${formatScore(score)}</b></div></div>`;
}
function updateEvaluationPanel(idPrefix, score, label = 'Оценка позиции') {
  const evaluation = document.querySelector(`#${idPrefix}-eval`);
  const bar = document.querySelector(`#${idPrefix}-eval-bar`);
  if (evaluation) evaluation.innerHTML = `<span>${label}</span><b>${formatScore(score)}</b><span>${advantageText(score)}</span>`;
  if (bar) {
    bar.title = `${formatScore(score)} для белых`;
    bar.querySelector('.eval-bar-white').style.height = `${Math.max(3, Math.min(97, 50 + score / 20))}%`;
    bar.querySelector('.eval-bar-white b').textContent = formatScore(score);
  }
}

function movesForColor(fen, color) {
  const parts = fen.split(' ');
  const targetFen = parts[1] === color ? fen : (() => { parts[1] = color; parts[3] = '-'; return parts.join(' '); })();
  try {
    return new Chess(targetFen).moves({ verbose: true });
  } catch {
    return [];
  }
}

function moveAttacksEnemyPiece(fen, move) {
  const parts = fen.split(' ');
  const startFen = parts[1] === move.color ? fen : (() => { parts[1] = move.color; parts[3] = '-'; return parts.join(' '); })();
  const chess = new Chess(startFen);
  try {
    chess.move(move);
  } catch {
    return false;
  }
  const afterParts = chess.fen().split(' ');
  afterParts[1] = move.color;
  afterParts[3] = '-';
  try {
    return new Chess(afterParts.join(' ')).moves({ square: move.to, verbose: true }).some(candidate => candidate.captured);
  } catch {
    return false;
  }
}

function categorizeThreats(fen, color) {
  const moves = movesForColor(fen, color);
  const checks = moves.filter(move => move.san.includes('+') || move.san.includes('#'));
  const captures = moves.filter(move => move.captured);
  const attacks = moves.filter(move => !move.captured && moveAttacksEnemyPiece(fen, move));
  return { checks, captures, attacks };
}

function legalDestsFor(chess) {
  const destinations = new Map();
  chess.moves({ verbose: true }).forEach(move => {
    const list = destinations.get(move.from) || [];
    list.push(move.to);
    destinations.set(move.from, list);
  });
  return destinations;
}

async function computeGameAnalysis(game, onProgress) {
  const chess = new Chess();
  chess.loadPgn(game.pgn);
  const history = chess.history({ verbose: true });
  if (!history.length) throw new Error('В PGN не найдены ходы.');
  const color = playerColorFor(game, state.username);
  if (!color) throw new Error('Не удалось определить цвет игрока в этой партии.');
  const board = new Chess();
  const errors = [];
  const evaluations = [{ ply: 0, score: 0, label: 'Начальная позиция' }];
  const moveReviews = [];
  // Reused as next ply's "before" analysis — it's the same position, so no need to re-run Stockfish on it.
  let prevInfo = await engine.analyse(board.fen());
  for (let index = 0; index < history.length; index++) {
    const move = history[index];
    if (onProgress) onProgress(index + 1, history.length);
    const mover = board.turn();
    const fen = board.fen();
    const beforeInfo = prevInfo;
    const before = scoreFor(beforeInfo, mover, fen);
    const bestUci = beforeInfo.pv[0];
    const playedUci = `${move.from}${move.to}${move.promotion || ''}`;
    const materialBefore = materialBalance(fen, mover);
    board.move(move);
    const afterFen = board.fen();
    const afterInfo = await engine.analyse(afterFen);
    const after = scoreFor(afterInfo, mover, afterFen);
    const materialAfter = materialBalance(afterFen, mover);
    prevInfo = afterInfo;
    evaluations.push({ ply: index + 1, score: scoreFor(afterInfo, 'w', afterFen), label: `${Math.floor(index / 2) + 1}${index % 2 === 0 ? '.' : '…'} ${move.san}` });
    const loss = Math.max(0, before - after);
    const winBefore = winPercent(before);
    const moveAccuracy = moveAccuracyFromWinDiff(Math.max(0, winBefore - winPercent(after)));
    const swing = evaluations.length >= 2 ? Math.abs(evaluations[evaluations.length - 1].score - evaluations[evaluations.length - 2].score) : 0;
    const category = classifyMove({ loss, winBefore, materialDrop: materialBefore - materialAfter, swing });
    moveReviews.push({ ply: index + 1, moveNumber: Math.floor(index / 2) + 1, color: mover, category, loss, moveAccuracy });
    if (mover === color && ['Mistake', 'Blunder', 'Miss'].includes(category)) {
      const beforeBoard = new Chess(fen);
      const replyUci = afterInfo.pv[0];
      const replyBoard = new Chess(afterFen);
      errors.push({ fen, afterFen, color, played: move.san, playedUci, best: sanFor(beforeBoard, bestUci), bestUci, reply: sanFor(replyBoard, replyUci), replyUci, before, after, loss, moveNumber: Math.floor(index / 2) + 1, label: category });
    }
  }
  // Standard PGNs have no FEN header. Passing null to chess.js breaks its parser;
  // undefined deliberately selects the ordinary starting position.
  const replayChess = new Chess(chess.header().FEN || undefined);
  const positions = [replayChess.fen()];
  history.forEach(move => { replayChess.move(move); positions.push(replayChess.fen()); });
  const review = { w: buildSideReview(moveReviews, 'w'), b: buildSideReview(moveReviews, 'b') };
  return { game, color, errors: errors.sort((a, b) => a.moveNumber - b.moveNumber), evaluations, positions, moves: history, review };
}

async function analyseGame(game) {
  state.analysing = true;
  state.analysis = null;
  const progress = document.querySelector('#progress');
  try {
    const analysis = await computeGameAnalysis(game, (done, total) => {
      if (progress) progress.textContent = `Stockfish: ${done}/${total} полуходов`;
    });
    state.analysis = analysis;
    state.replayIndex = 0;
    state.replayFlipped = false;
    if (progress) progress.textContent = `Анализ завершён: критических позиций — ${analysis.errors.length}.`;
    renderReport();
  } catch (error) {
    console.error(error);
    if (progress) progress.textContent = `Ошибка анализа: ${error.message}`;
    document.querySelector('#report').innerHTML = `<p class="analysis-error">Ошибка анализа: ${error.message}</p>`;
  } finally {
    state.analysing = false;
  }
}

function renderSummary() {
  const { game, color, errors } = state.analysis;
  const outcome = gameOutcomeFor(game, color);
  const blunders = errors.filter(e => e.label === 'Blunder').length;
  const mistakes = errors.filter(e => e.label === 'Mistake').length;
  const avgLoss = errors.length ? Math.round(errors.reduce((sum, e) => sum + e.loss, 0) / errors.length) : 0;
  document.querySelector('#summary').innerHTML = `<div class="card summary-card">
    <div class="eyebrow">${new Date(game.end_time * 1000).toLocaleString()}</div>
    <h2>${game.white.username} — ${game.black.username}</h2>
    <div class="summary-grid">
      <div><span>Результат</span><b>${outcome}</b></div>
      <div><span>Цвет</span><b>${color === 'w' ? 'Белые' : 'Чёрные'}</b></div>
      <div><span>Дебют</span><b>${openingNameFor(game)}</b></div>
      <div><span>Ошибки / Зевки</span><b>${mistakes} / ${blunders}</b></div>
      <div><span>Средняя потеря</span><b>${formatScore(avgLoss)}</b></div>
    </div>
    <a href="${game.url}" target="_blank">Открыть на Chess.com</a>
  </div>`;
}

function renderGameReview() {
  const target = document.querySelector('#game-review');
  const { review, game } = state.analysis;
  if (!target || !review) return;
  const rows = REVIEW_CATEGORIES.map(category => `<tr>
    <td>${review.w.counts[category]}</td>
    <td class="review-icon"><span class="tag ${category.toLowerCase()}">${category}</span></td>
    <td>${review.b.counts[category]}</td>
  </tr>`).join('');
  target.innerHTML = `<div class="card review-card">
    <div class="eyebrow">Game Review</div>
    <h2>Разбор партии по категориям ходов</h2>
    <div class="summary-grid">
      <div><span>Точность — ${game.white.username}</span><b>${review.w.accuracy.toFixed(1)}</b></div>
      <div><span>Точность — ${game.black.username}</span><b>${review.b.accuracy.toFixed(1)}</b></div>
      <div><span>Рейтинг партии — ${game.white.username}</span><b>${review.w.estimatedElo}</b></div>
      <div><span>Рейтинг партии — ${game.black.username}</span><b>${review.b.estimatedElo}</b></div>
    </div>
    <table class="error-table review-table"><thead><tr><th>${game.white.username}</th><th>Категория</th><th>${game.black.username}</th></tr></thead><tbody>${rows}</tbody></table>
  </div>`;
}

function renderEvaluationChart() {
  const { evaluations, errors } = state.analysis;
  const target = document.querySelector('#evaluation-chart');
  if (!target || !evaluations?.length) return;
  const width = 760;
  const height = 230;
  const center = height / 2;
  const scale = 900;
  const pointFor = (item, index) => {
    const x = evaluations.length === 1 ? 0 : index / (evaluations.length - 1) * width;
    const score = Math.max(-scale, Math.min(scale, item.score));
    const y = center - score / scale * (center - 20);
    return { x, y };
  };
  const points = evaluations.map(pointFor);
  const line = points.map(point => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
  const area = `${line} ${width},${center} 0,${center}`;
  const errorsByPly = new Map(errors.map(error => [error.color === 'w' ? error.moveNumber * 2 - 1 : error.moveNumber * 2, error]));
  const pointMarkup = points.map((point, index) => {
    const error = errorsByPly.get(index);
    const status = error ? ` · ${error.label}: потеря ${formatScore(error.loss)}` : '';
    return `<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="${error ? 7 : 4}" class="chart-point ${error ? `chart-${error.label.toLowerCase()}` : ''}" ${error ? `data-chart-ply="${index}" role="button" tabindex="0"` : ''}><title>${evaluations[index].label}: ${formatScore(evaluations[index].score)} для белых${status}</title></circle>`;
  }).join('');
  target.innerHTML = `<div class="chart-card"><div class="chart-heading"><div><div class="eyebrow">Оценка Stockfish после каждого хода</div><h2>Преимущество в партии</h2></div><span class="score-label">Белые ↑ · Чёрные ↓</span></div><svg class="evaluation-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="График преимущества белых и чёрных"><line x1="0" y1="${center}" x2="${width}" y2="${center}" class="chart-zero"/><line x1="0" y1="40" x2="${width}" y2="40" class="chart-grid"/><line x1="0" y1="190" x2="${width}" y2="190" class="chart-grid"/><polygon points="${area}" class="chart-area"/><polyline points="${line}" class="chart-line"/>${pointMarkup}</svg><div class="chart-caption"><span>Начальная позиция</span><span><i class="chart-key blunder"></i> Blunder <i class="chart-key mistake"></i> Mistake <i class="chart-key miss"></i> Miss · нажмите на метку, чтобы открыть позицию</span><span>Конец партии</span></div></div>`;
  const openPly = element => {
    state.replayIndex = Number(element.dataset.chartPly);
    renderReplay();
    document.querySelector('#game-replay')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  target.querySelectorAll('[data-chart-ply]').forEach(marker => {
    marker.addEventListener('click', () => openPly(marker));
    marker.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openPly(marker); }
    });
  });
}

function renderErrorTable() {
  const { errors } = state.analysis;
  const target = document.querySelector('#error-table');
  if (!errors.length) {
    target.innerHTML = '<div class="empty">Крупных ошибок с потерей 0.70+ не найдено.</div>';
    return;
  }
  const rows = errors.map((error, index) => `<tr class="error-row ${error.label.toLowerCase()}" data-error-index="${index}">
    <td>${error.moveNumber}${error.color === 'w' ? '.' : '…'}</td>
    <td>${error.played}</td>
    <td>${error.best}</td>
    <td>${formatScore(error.loss)}</td>
    <td><span class="tag ${error.label.toLowerCase()}">${error.label}</span></td>
  </tr>`).join('');
  target.innerHTML = `<div class="card">
    <div class="eyebrow">Ошибки и зевки</div>
    <h2>Список критических позиций</h2>
    <table class="error-table"><thead><tr><th>Ход</th><th>Сыграно</th><th>Лучший</th><th>Потеря</th><th>Тип</th></tr></thead><tbody>${rows}</tbody></table>
  </div>`;
  target.querySelectorAll('[data-error-index]').forEach(row => row.onclick = () => {
    const error = errors[Number(row.dataset.errorIndex)];
    state.replayIndex = error.color === 'w' ? error.moveNumber * 2 - 1 : error.moveNumber * 2;
    renderReplay();
    document.querySelector('#game-replay')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

function renderReplay() {
  const target = document.querySelector('#game-replay');
  const analysis = state.analysis;
  if (!target || !analysis?.positions?.length) return;
  const lastIndex = analysis.positions.length - 1;
  const index = state.replayIndex;
  const move = index ? analysis.moves[index - 1] : null;
  const evaluation = analysis.evaluations[index];
  const orientation = state.replayFlipped ? (analysis.color === 'w' ? 'black' : 'white') : (analysis.color === 'w' ? 'white' : 'black');
  state.replayChess = new Chess(analysis.positions[index]);
  const replayVersion = ++state.replayVersion;
  const replayColor = state.replayChess.turn();
  const moveButtons = analysis.moves.map((item, moveIndex) => {
    const ply = moveIndex + 1;
    const error = analysis.errors.find(itemError => itemError.moveNumber === Math.ceil(ply / 2) && itemError.color === (ply % 2 ? 'w' : 'b'));
    const errorClass = error ? error.label.toLowerCase() : '';
    return `<button class="move ${errorClass} ${ply === index ? 'active' : ''}" data-replay-index="${ply}"><span>${Math.floor(moveIndex / 2) + 1}${moveIndex % 2 === 0 ? '.' : '…'}</span>${item.san}${error ? `<i>${error.label}</i>` : ''}</button>`;
  }).join('');
  target.innerHTML = `<div class="replay-card"><div class="chart-heading"><div><div class="eyebrow">Просмотр партии</div><h2>${index === 0 ? 'Начальная позиция' : `${Math.ceil(index / 2)}${index % 2 ? '.' : '…'} ${move.san}`}</h2></div><label class="hint-toggle">Подсказки Stockfish <select id="replay-hints"><option value="off" ${state.replayHintsColor === 'off' ? 'selected' : ''}>Выключены</option><option value="w" ${state.replayHintsColor === 'w' ? 'selected' : ''}>Только белые</option><option value="b" ${state.replayHintsColor === 'b' ? 'selected' : ''}>Только чёрные</option></select></label></div><div class="replay-grid"><div><div id="replay-eval" class="eval-status"><span>Оценка позиции</span><b>${formatScore(evaluation?.score || 0)}</b><span>${advantageText(evaluation?.score || 0)}</span></div><div class="replay-analysis-board">${evaluationBarHtml(evaluation?.score || 0)}<div id="replay-board" class="replay-board"></div></div><div class="replay-controls"><button id="replay-prev" class="secondary" ${index === 0 ? 'disabled' : ''}>← Назад</button><span>${index} / ${lastIndex}</span><button id="replay-next" class="secondary" ${index === lastIndex ? 'disabled' : ''}>Вперёд →</button><button id="replay-flip" class="secondary">↻</button><button id="replay-reset" class="secondary" disabled>↶ К партии</button></div><p class="hint">Ходите за обе стороны и стройте вариант столько ходов, сколько нужно. Stockfish пересчитывает позицию после каждого хода. Клавиатура: <b>←</b> и <b>→</b>.</p></div><div class="move-list">${moveButtons}</div></div></div>`;
  state.replayBoard = Chessground(document.querySelector('#replay-board'), {
    fen: analysis.positions[index], orientation, turnColor: replayColor === 'w' ? 'white' : 'black', coordinates: true,
    events: { move: tryReplayMove },
    movable: { free: false, color: replayColor === 'w' ? 'white' : 'black', dests: legalDestsFor(state.replayChess) },
  });
  document.querySelector('#replay-prev').onclick = () => navigateReplay(-1);
  document.querySelector('#replay-next').onclick = () => navigateReplay(1);
  document.querySelector('#replay-flip').onclick = () => { state.replayFlipped = !state.replayFlipped; renderReplay(); };
  document.querySelector('#replay-reset').onclick = renderReplay;
  document.querySelector('#replay-hints').onchange = event => {
    state.replayHintsColor = event.target.value;
    if (state.replayHintsColor === replayColor) showReplayHint(replayVersion);
    else state.replayBoard.set({ drawable: { autoShapes: [] } });
  };
  document.querySelectorAll('[data-replay-index]').forEach(button => button.onclick = () => {
    state.replayIndex = Number(button.dataset.replayIndex); renderReplay();
  });
  if (state.replayHintsColor === replayColor) showReplayHint(replayVersion);
}

async function tryReplayMove(orig, dest) {
  const move = state.replayChess.move({ from: orig, to: dest, promotion: 'q' });
  if (!move) return;
  const color = state.replayChess.turn();
  const version = ++state.replayVersion;
  state.replayBoard.set({ fen: state.replayChess.fen(), turnColor: replayColorName(color), movable: { color: replayColorName(color), dests: legalDestsFor(state.replayChess) }, drawable: { autoShapes: [] } });
  const info = await engine.analyse(state.replayChess.fen());
  if (version !== state.replayVersion) return;
  const score = scoreFor(info, 'w', state.replayChess.fen());
  updateEvaluationPanel('replay', score, `После варианта ${move.san}`);
  if (state.replayHintsColor === color) showReplayHint(version, info);
  document.querySelector('#replay-reset').disabled = false;
}

async function showReplayHint(version = state.replayVersion, readyInfo = null) {
  const chess = state.replayChess;
  const info = readyInfo || await engine.analyse(chess.fen());
  if (state.replayHintsColor !== chess.turn() || version !== state.replayVersion || chess !== state.replayChess) return;
  const best = info.pv?.[0];
  if (!best) return;
  state.replayBoard.set({ drawable: { autoShapes: [{ orig: best.slice(0, 2), dest: best.slice(2, 4), brush: 'green' }] } });
}

function navigateReplay(delta) {
  if (!state.analysis?.positions) return;
  const next = Math.max(0, Math.min(state.analysis.positions.length - 1, state.replayIndex + delta));
  if (next === state.replayIndex) return;
  state.replayIndex = next;
  renderReplay();
}

function renderReport() {
  document.querySelector('#report').innerHTML = `<div id="summary"></div><div id="game-review"></div><div id="evaluation-chart"></div><div id="game-replay"></div><div id="error-table"></div>`;
  renderSummary();
  renderGameReview();
  renderEvaluationChart();
  renderReplay();
  renderErrorTable();
}

function currentTrainerColors() {
  const mover = state.trainerChess.turn();
  return { mover, opponent: mover === 'w' ? 'b' : 'w' };
}

function buildTrainerAutoShapes(position) {
  const shapes = [];
  if (state.trainerShowBest && position.bestUci) {
    shapes.push({ orig: position.bestUci.slice(0, 2), dest: position.bestUci.slice(2, 4), brush: 'best' });
  }
  if (state.trainerShowPlayed && position.playedUci) {
    shapes.push({ orig: position.playedUci.slice(0, 2), dest: position.playedUci.slice(2, 4), brush: 'played' });
  }
  const fen = state.trainerChess.fen();
  const { mover, opponent } = currentTrainerColors();
  [
    { prefix: 'opp', color: opponent },
    { prefix: 'my', color: mover },
  ].forEach(({ prefix, color }) => {
    const activeKinds = ['Checks', 'Captures', 'Attacks'].filter(kind => state.trainerThreats[`${prefix}${kind}`]);
    if (!activeKinds.length) return;
    const threats = categorizeThreats(fen, color);
    activeKinds.forEach(kind => {
      const brush = `${prefix}${kind}`;
      threats[kind.toLowerCase()].forEach(move => shapes.push({ orig: move.from, dest: move.to, brush }));
    });
  });
  return shapes;
}

function renderThreatsPanel() {
  const panel = document.querySelector('#trainer-threats');
  if (!panel) return;
  const fen = state.trainerChess.fen();
  const { mover, opponent } = currentTrainerColors();
  const groups = [
    { prefix: 'opp', label: `Угрозы соперника (${opponent === 'w' ? 'белые' : 'чёрные'})`, threats: categorizeThreats(fen, opponent) },
    { prefix: 'my', label: `Мои угрозы (${mover === 'w' ? 'белые' : 'чёрные'})`, threats: categorizeThreats(fen, mover) },
  ];
  const kinds = [['Checks', 'Шахи', 'checks'], ['Captures', 'Взятия', 'captures'], ['Attacks', 'Нападения', 'attacks']];
  panel.innerHTML = groups.map(group => `<div class="threats-group">
    <div class="eyebrow">${group.label}</div>
    <div class="threats-buttons">${kinds.map(([kind, label, field]) => {
      const key = `${group.prefix}${kind}`;
      const active = state.trainerThreats[key];
      const color = TRAINER_BRUSHES[key].color;
      const style = active ? `border-color:${color};background:${color}26;` : '';
      return `<button data-threat-key="${key}" class="threat-btn" style="${style}">${label} ${active ? `<b>${group.threats[field].length}</b>` : ''}</button>`;
    }).join('')}</div>
  </div>`).join('');
  panel.querySelectorAll('[data-threat-key]').forEach(button => button.onclick = () => {
    const key = button.dataset.threatKey;
    state.trainerThreats[key] = !state.trainerThreats[key];
    renderThreatsPanel();
    state.trainerBoard.set({ drawable: { autoShapes: buildTrainerAutoShapes(currentTrainerPosition()) } });
  });
}

async function scanBlunderTrainer(limit) {
  if (state.trainer.scanning) return;
  state.trainer.scanning = true;
  state.trainer.limit = limit;
  state.trainer.positions = [];
  state.trainer.index = 0;
  state.trainerShowBest = false;
  state.trainerShowPlayed = false;
  state.trainerThreats = { oppChecks: false, oppCaptures: false, oppAttacks: false, myChecks: false, myCaptures: false, myAttacks: false };
  renderTrainer();
  const found = [];
  for (let gameIndex = 0; gameIndex < state.games.length && found.length < limit; gameIndex++) {
    const game = state.games[gameIndex];
    const progressEl = document.querySelector('#trainer-progress');
    if (progressEl) progressEl.textContent = `Партия ${gameIndex + 1}/${state.games.length}, найдено позиций: ${found.length}/${limit}…`;
    try {
      const analysis = await computeGameAnalysis(game);
      analysis.errors
        .filter(error => error.label === 'Blunder' && Math.abs(error.before) <= TRAINER_EQUAL_THRESHOLD)
        .forEach(error => { if (found.length < limit) found.push({ ...error, game }); });
    } catch (error) {
      console.error(error);
    }
  }
  state.trainer.positions = found;
  state.trainer.index = 0;
  state.trainer.scanning = false;
  renderTrainer();
}

function currentTrainerPosition() {
  return state.trainer.positions[state.trainer.index] || null;
}

function renderTrainerCard() {
  const target = document.querySelector('#trainer-card');
  if (!target) return;
  const position = currentTrainerPosition();
  if (!position) {
    target.innerHTML = state.trainer.scanning
      ? '<div class="empty">Ищу блендерные позиции…</div>'
      : '<div class="empty">Нажмите «Найти позиции», чтобы собрать зевки из загруженных партий.</div>';
    return;
  }
  state.trainerChess = new Chess(position.fen);
  const version = ++state.trainerVersion;
  const mover = state.trainerChess.turn();
  const orientation = position.color === 'w' ? 'white' : 'black';
  const whiteScore = position.color === 'w' ? position.before : -position.before;
  target.innerHTML = `<div class="replay-card"><div class="chart-heading"><div><div class="eyebrow">Зевок ${state.trainer.index + 1} из ${state.trainer.positions.length}</div><h2>${position.moveNumber}${position.color === 'w' ? '.' : '…'} — найдите лучшее продолжение за ${position.color === 'w' ? 'белых' : 'чёрных'}</h2></div><span class="score-label">${position.game.white.username} — ${position.game.black.username}</span></div><div class="replay-grid"><div><div id="trainer-eval" class="eval-status"><span>Оценка позиции</span><b>${formatScore(whiteScore)}</b><span>${advantageText(whiteScore)}</span></div><div class="replay-analysis-board">${evaluationBarHtml(whiteScore, 'trainer')}<div id="trainer-board" class="replay-board"></div></div><div class="replay-controls"><button id="trainer-prev" class="secondary" ${state.trainer.index === 0 ? 'disabled' : ''}>← Предыдущий</button><span>${state.trainer.index + 1} / ${state.trainer.positions.length}</span><button id="trainer-next" class="secondary" ${state.trainer.index === state.trainer.positions.length - 1 ? 'disabled' : ''}>Следующий →</button><button id="trainer-reset" class="secondary">↶ Сброс</button></div><div class="trainer-toggles"><label class="hint-toggle"><input id="trainer-show-best" type="checkbox" ${state.trainerShowBest ? 'checked' : ''}> Показать лучший ход</label><label class="hint-toggle"><input id="trainer-show-played" type="checkbox" ${state.trainerShowPlayed ? 'checked' : ''}> Показать сыгранный ход (${position.played}, потеря ${formatScore(position.loss)})</label></div></div><div id="trainer-threats" class="threats-panel"></div></div></div>`;
  state.trainerBoard = Chessground(document.querySelector('#trainer-board'), {
    fen: position.fen, orientation, turnColor: mover === 'w' ? 'white' : 'black', coordinates: true,
    events: { move: tryTrainerMove },
    movable: { free: false, color: mover === 'w' ? 'white' : 'black', dests: legalDestsFor(state.trainerChess) },
    drawable: { autoShapes: buildTrainerAutoShapes(position), brushes: TRAINER_BRUSHES },
  });
  document.querySelector('#trainer-prev').onclick = () => { if (state.trainer.index > 0) { state.trainer.index--; renderTrainerCard(); } };
  document.querySelector('#trainer-next').onclick = () => { if (state.trainer.index < state.trainer.positions.length - 1) { state.trainer.index++; renderTrainerCard(); } };
  document.querySelector('#trainer-reset').onclick = () => renderTrainerCard();
  document.querySelector('#trainer-show-best').onchange = event => {
    state.trainerShowBest = event.target.checked;
    state.trainerBoard.set({ drawable: { autoShapes: buildTrainerAutoShapes(position) } });
  };
  document.querySelector('#trainer-show-played').onchange = event => {
    state.trainerShowPlayed = event.target.checked;
    state.trainerBoard.set({ drawable: { autoShapes: buildTrainerAutoShapes(position) } });
  };
  renderThreatsPanel();
}

async function tryTrainerMove(orig, dest) {
  const move = state.trainerChess.move({ from: orig, to: dest, promotion: 'q' });
  if (!move) return;
  const position = currentTrainerPosition();
  const color = state.trainerChess.turn();
  const version = ++state.trainerVersion;
  state.trainerBoard.set({ fen: state.trainerChess.fen(), turnColor: replayColorName(color), movable: { color: replayColorName(color), dests: legalDestsFor(state.trainerChess) }, drawable: { autoShapes: buildTrainerAutoShapes(position) } });
  renderThreatsPanel();
  const info = await engine.analyse(state.trainerChess.fen());
  if (version !== state.trainerVersion) return;
  const score = scoreFor(info, 'w', state.trainerChess.fen());
  updateEvaluationPanel('trainer', score, `После хода ${move.san}`);
}

function renderTrainer() {
  const target = document.querySelector('#trainer');
  if (!target) return;
  const limitOptions = TRAINER_LIMIT_OPTIONS.map(value => `<option value="${value}" ${value === state.trainer.limit ? 'selected' : ''}>${value}</option>`).join('');
  target.innerHTML = `<div class="card">
    <div class="eyebrow">Blunder Training</div>
    <h2>Тренажёр зевков</h2>
    <p class="hint">Ищет в партиях, загруженных во вкладке «Партии», моменты, где позиция была примерно равной (±1 пешка), а следующим ходом вы допустили зевок. Найдите лучшее продолжение сами.</p>
    <form id="trainer-form" class="trainer-form">
      <label>Сколько позиций<select id="trainer-limit">${limitOptions}</select></label>
      <button type="submit" ${state.trainer.scanning ? 'disabled' : ''}>${state.trainer.scanning ? 'Ищу…' : 'Найти позиции'}</button>
    </form>
    <div id="trainer-progress" class="hint"></div>
  </div>
  <div id="trainer-card"></div>`;
  document.querySelector('#trainer-form').onsubmit = event => {
    event.preventDefault();
    scanBlunderTrainer(Number(document.querySelector('#trainer-limit').value));
  };
  renderTrainerCard();
}

const TAB_ICONS = {
  games: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="4" rx="1.2"/><rect x="3" y="10" width="18" height="4" rx="1.2"/><rect x="3" y="16" width="18" height="4" rx="1.2"/></svg>',
  review: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19V9M11 19V5M18 19v-7"/><path d="M2 19h20"/></svg>',
  trainer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r=".6" fill="currentColor"/></svg>',
};
const TAB_TITLES = { games: 'Партии', review: 'Разбор партии', trainer: 'Тренажёр зевков' };

function switchTab(tab) {
  state.view = tab;
  document.querySelectorAll('.tab-item').forEach(button => button.classList.toggle('active', button.dataset.tab === tab));
  document.querySelectorAll('.panel').forEach(panel => panel.classList.toggle('active', panel.id === `panel-${tab}`));
  document.querySelector('#screen-title').textContent = TAB_TITLES[tab];
  window.scrollTo({ top: 0 });
  if (tab === 'trainer') renderTrainer();
}

function renderGames() {
  document.querySelector('#games').innerHTML = state.games.map((game, index) => {
    const color = playerColorFor(game, state.username);
    const outcome = color ? gameOutcomeFor(game, color) : '—';
    const resultClass = outcome === 'Победа' ? 'result-win' : outcome === 'Поражение' ? 'result-loss' : 'result-draw';
    return `<button class="game ${index === state.selected ? 'active' : ''}" data-game="${index}">
      <span class="who">
        <b>${game.white.username} — ${game.black.username}</b>
        <span>${new Date(game.end_time * 1000).toLocaleString()}</span>
      </span>
      <span class="result-pill ${resultClass}">${outcome}</span>
      <span class="chev">›</span>
    </button>`;
  }).join('') || '<p class="hint">Партии не найдены.</p>';
  document.querySelectorAll('[data-game]').forEach(button => button.onclick = () => selectGame(Number(button.dataset.game)));
}

function selectGame(index) {
  state.selected = index;
  renderGames();
  switchTab('review');
  const progress = document.querySelector('#progress');
  progress.textContent = 'Проверяю PGN и запускаю Stockfish…';
  document.querySelector('#report').innerHTML = '<div class="empty">Анализирую партию…</div>';
  analyseGame(state.games[index]);
}

async function loadGames(username, limit) {
  const progress = document.querySelector('#progress');
  progress.textContent = 'Загрузка партий…';
  state.username = username;
  state.gamesLimit = limit;
  state.selected = -1;
  state.analysis = null;
  document.querySelector('#report').innerHTML = '<div class="empty">Выберите партию во вкладке «Партии».</div>';
  try {
    state.games = await fetchLastGames(username, limit);
    progress.textContent = `Загружено rapid-партий: ${state.games.length}.`;
    renderGames();
  } catch (error) {
    console.error(error);
    progress.textContent = `Не удалось загрузить партии: ${error.message}`;
    state.games = [];
    renderGames();
  }
}

function render() {
  const limitOptions = [10, 20, 50, 100].map(value => `<option value="${value}" ${value === DEFAULT_GAMES_LIMIT ? 'selected' : ''}>${value}</option>`).join('');
  const tabs = ['games', 'review', 'trainer'].map(tab => `<button class="tab-item ${tab === 'games' ? 'active' : ''}" data-tab="${tab}">${TAB_ICONS[tab]}${TAB_TITLES[tab]}</button>`).join('');
  app.innerHTML = `<div class="shell">
    <header class="topbar">
      <h1>Game Analyzer Lite</h1>
      <p class="tagline">Rapid-партии Chess.com с разбором Stockfish прямо в браузере</p>
      <div class="screen-title" id="screen-title">Партии</div>
    </header>
    <main class="content">
      <section class="panel active" id="panel-games">
        <div class="card">
          <form id="username-form">
            <label>Chess.com username<input id="username" value="${DEFAULT_USERNAME}" required></label>
            <label>Количество партий<select id="games-limit">${limitOptions}</select></label>
            <button>Загрузить партии</button>
          </form>
          <div id="progress"></div>
        </div>
        <div id="games"></div>
      </section>
      <section class="panel" id="panel-review">
        <div id="report"><div class="empty">Выберите партию во вкладке «Партии».</div></div>
      </section>
      <section class="panel" id="panel-trainer">
        <div id="trainer"></div>
      </section>
    </main>
    <nav class="tabbar">${tabs}</nav>
  </div>`;
  document.querySelector('#username-form').onsubmit = event => {
    event.preventDefault();
    loadGames(document.querySelector('#username').value.trim(), Number(document.querySelector('#games-limit').value));
  };
  document.querySelectorAll('.tab-item').forEach(button => button.onclick = () => switchTab(button.dataset.tab));
  loadGames(DEFAULT_USERNAME, DEFAULT_GAMES_LIMIT);
}

document.addEventListener('keydown', event => {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault();
    navigateReplay(event.key === 'ArrowLeft' ? -1 : 1);
  }
});
render();
