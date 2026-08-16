import { Chess } from 'chess.js';
import { Chessground } from 'chessground';
import 'chessground/assets/chessground.base.css';
import 'chessground/assets/chessground.brown.css';
import 'chessground/assets/chessground.cburnett.css';
import './style.css';

const app = document.querySelector('#app');
const DEFAULT_USERNAME = 'alexey-kozhakin';
const DEFAULT_DEPTH = 12;
const GAMES_LIMIT = 10;
const MISTAKE_THRESHOLD = 70;
const BLUNDER_THRESHOLD = 200;

const state = {
  username: DEFAULT_USERNAME,
  games: [],
  selected: -1,
  analysis: null,
  analysing: false,
  replayIndex: 0,
  replayBoard: null,
  replayChess: null,
  replayFlipped: false,
  replayHints: false,
  replayVersion: 0,
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

async function fetchLastGames(username) {
  const archives = await fetchArchives(username);
  if (!archives.length) return [];
  let games = await fetchMonth(archives[archives.length - 1]);
  if (games.length < GAMES_LIMIT && archives.length > 1) {
    const previous = await fetchMonth(archives[archives.length - 2]);
    games = [...previous, ...games];
  }
  return games.sort((a, b) => b.end_time - a.end_time).slice(0, GAMES_LIMIT);
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
function formatScore(value) { return `${value >= 0 ? '+' : ''}${(value / 100).toFixed(2)}`; }
function advantageText(whiteScore) {
  if (Math.abs(whiteScore) < 30) return 'примерно равно';
  return `преимущество ${whiteScore > 0 ? 'белых' : 'чёрных'}`;
}
function replayColorName(color) { return color === 'w' ? 'white' : 'black'; }
function evaluationBarHtml(score) {
  const whitePercent = Math.max(3, Math.min(97, 50 + score / 20));
  return `<div id="replay-eval-bar" class="eval-bar" title="${formatScore(score)} для белых"><div class="eval-bar-black"></div><div class="eval-bar-white" style="height:${whitePercent}%"><b>${formatScore(score)}</b></div></div>`;
}
function updateReplayEvaluation(score, label = 'Оценка позиции') {
  const evaluation = document.querySelector('#replay-eval');
  const bar = document.querySelector('#replay-eval-bar');
  if (evaluation) evaluation.innerHTML = `<span>${label}</span><b>${formatScore(score)}</b><span>${advantageText(score)}</span>`;
  if (bar) {
    bar.title = `${formatScore(score)} для белых`;
    bar.querySelector('.eval-bar-white').style.height = `${Math.max(3, Math.min(97, 50 + score / 20))}%`;
    bar.querySelector('.eval-bar-white b').textContent = formatScore(score);
  }
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

async function analyseGame(game) {
  state.analysing = true;
  state.analysis = null;
  const progress = document.querySelector('#progress');
  try {
    const chess = new Chess();
    chess.loadPgn(game.pgn);
    const history = chess.history({ verbose: true });
    if (!history.length) throw new Error('В PGN не найдены ходы.');
    const color = playerColorFor(game, state.username);
    if (!color) throw new Error('Не удалось определить цвет игрока в этой партии.');
    const board = new Chess();
    const errors = [];
    const evaluations = [{ ply: 0, score: 0, label: 'Начальная позиция' }];
    for (let index = 0; index < history.length; index++) {
      const move = history[index];
      if (progress) progress.textContent = `Stockfish: ${index + 1}/${history.length} полуходов`;
      if (board.turn() === color) {
        const fen = board.fen();
        const beforeInfo = await engine.analyse(fen);
        const before = scoreFor(beforeInfo, color, fen);
        const bestUci = beforeInfo.pv[0];
        const playedUci = `${move.from}${move.to}${move.promotion || ''}`;
        board.move(move);
        const afterInfo = await engine.analyse(board.fen());
        const afterFen = board.fen();
        const after = scoreFor(afterInfo, color, afterFen);
        evaluations.push({ ply: index + 1, score: scoreFor(afterInfo, 'w', afterFen), label: `${Math.floor(index / 2) + 1}${index % 2 === 0 ? '.' : '…'} ${move.san}` });
        const loss = Math.max(0, before - after);
        if (loss >= MISTAKE_THRESHOLD) {
          const beforeBoard = new Chess(fen);
          const replyUci = afterInfo.pv[0];
          const replyBoard = new Chess(afterFen);
          errors.push({ fen, afterFen, color, played: move.san, playedUci, best: sanFor(beforeBoard, bestUci), bestUci, reply: sanFor(replyBoard, replyUci), replyUci, before, after, loss, moveNumber: Math.floor(index / 2) + 1, label: loss >= BLUNDER_THRESHOLD ? 'Blunder' : 'Mistake' });
        }
      } else {
        board.move(move);
        const afterInfo = await engine.analyse(board.fen());
        evaluations.push({ ply: index + 1, score: scoreFor(afterInfo, 'w', board.fen()), label: `${Math.floor(index / 2) + 1}… ${move.san}` });
      }
    }
    // Standard PGNs have no FEN header. Passing null to chess.js breaks its parser;
    // undefined deliberately selects the ordinary starting position.
    const replayChess = new Chess(chess.header().FEN || undefined);
    const positions = [replayChess.fen()];
    history.forEach(move => { replayChess.move(move); positions.push(replayChess.fen()); });
    state.analysis = { game, color, errors: errors.sort((a, b) => a.moveNumber - b.moveNumber), evaluations, positions, moves: history };
    state.replayIndex = 0;
    state.replayFlipped = false;
    if (progress) progress.textContent = `Анализ завершён: критических позиций — ${errors.length}.`;
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
  target.innerHTML = `<div class="chart-card"><div class="chart-heading"><div><div class="eyebrow">Оценка Stockfish после каждого хода</div><h2>Преимущество в партии</h2></div><span class="score-label">Белые ↑ · Чёрные ↓</span></div><svg class="evaluation-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="График преимущества белых и чёрных"><line x1="0" y1="${center}" x2="${width}" y2="${center}" class="chart-zero"/><line x1="0" y1="40" x2="${width}" y2="40" class="chart-grid"/><line x1="0" y1="190" x2="${width}" y2="190" class="chart-grid"/><polygon points="${area}" class="chart-area"/><polyline points="${line}" class="chart-line"/>${pointMarkup}</svg><div class="chart-caption"><span>Начальная позиция</span><span><i class="chart-key blunder"></i> Blunder <i class="chart-key mistake"></i> Mistake · нажмите на метку, чтобы открыть позицию</span><span>Конец партии</span></div></div>`;
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
  target.innerHTML = `<div class="replay-card"><div class="chart-heading"><div><div class="eyebrow">Просмотр партии</div><h2>${index === 0 ? 'Начальная позиция' : `${Math.ceil(index / 2)}${index % 2 ? '.' : '…'} ${move.san}`}</h2></div><label class="hint-toggle"><input id="replay-hints" type="checkbox" ${state.replayHints ? 'checked' : ''}> Подсказки Stockfish</label></div><div class="replay-grid"><div><div id="replay-eval" class="eval-status"><span>Оценка позиции</span><b>${formatScore(evaluation?.score || 0)}</b><span>${advantageText(evaluation?.score || 0)}</span></div><div class="replay-analysis-board">${evaluationBarHtml(evaluation?.score || 0)}<div id="replay-board" class="replay-board"></div></div><div class="replay-controls"><button id="replay-prev" class="secondary" ${index === 0 ? 'disabled' : ''}>← Назад</button><span>${index} / ${lastIndex}</span><button id="replay-next" class="secondary" ${index === lastIndex ? 'disabled' : ''}>Вперёд →</button><button id="replay-flip" class="secondary">↻</button><button id="replay-reset" class="secondary" disabled>↶ К партии</button></div><p class="hint">Ходите за обе стороны и стройте вариант столько ходов, сколько нужно. Stockfish пересчитывает позицию после каждого хода. Клавиатура: <b>←</b> и <b>→</b>.</p></div><div class="move-list">${moveButtons}</div></div></div>`;
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
    state.replayHints = event.target.checked;
    if (state.replayHints) showReplayHint(replayVersion);
    else state.replayBoard.set({ drawable: { autoShapes: [] } });
  };
  document.querySelectorAll('[data-replay-index]').forEach(button => button.onclick = () => {
    state.replayIndex = Number(button.dataset.replayIndex); renderReplay();
  });
  if (state.replayHints) showReplayHint(replayVersion);
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
  updateReplayEvaluation(score, `После варианта ${move.san}`);
  if (state.replayHints) showReplayHint(version, info);
  document.querySelector('#replay-reset').disabled = false;
}

async function showReplayHint(version = state.replayVersion, readyInfo = null) {
  const chess = state.replayChess;
  const info = readyInfo || await engine.analyse(chess.fen());
  if (!state.replayHints || version !== state.replayVersion || chess !== state.replayChess) return;
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
  document.querySelector('#report').innerHTML = `<div id="summary"></div><div id="evaluation-chart"></div><div id="game-replay"></div><div id="error-table"></div>`;
  renderSummary();
  renderEvaluationChart();
  renderReplay();
  renderErrorTable();
}

function renderGames() {
  document.querySelector('#games').innerHTML = state.games.map((game, index) => {
    const color = playerColorFor(game, state.username);
    const outcome = color ? gameOutcomeFor(game, color) : '—';
    return `<button class="game ${index === state.selected ? 'active' : ''}" data-game="${index}"><b>${game.white.username} — ${game.black.username}</b><span>${new Date(game.end_time * 1000).toLocaleString()} · ${outcome}</span></button>`;
  }).join('') || '<p class="hint">Партии не найдены.</p>';
  document.querySelectorAll('[data-game]').forEach(button => button.onclick = () => selectGame(Number(button.dataset.game)));
}

function selectGame(index) {
  state.selected = index;
  renderGames();
  const progress = document.querySelector('#progress');
  progress.textContent = 'Проверяю PGN и запускаю Stockfish…';
  document.querySelector('#report').innerHTML = '<div class="empty">Анализирую партию…</div>';
  analyseGame(state.games[index]);
}

async function loadGames(username) {
  const progress = document.querySelector('#progress');
  progress.textContent = 'Загрузка партий…';
  state.username = username;
  state.selected = -1;
  state.analysis = null;
  document.querySelector('#report').innerHTML = '<div class="empty">Выберите партию слева.</div>';
  try {
    state.games = await fetchLastGames(username);
    progress.textContent = `Загружено партий: ${state.games.length}.`;
    renderGames();
  } catch (error) {
    console.error(error);
    progress.textContent = `Не удалось загрузить партии: ${error.message}`;
    state.games = [];
    renderGames();
  }
}

function render() {
  app.innerHTML = `<header><h1>Game Analyzer Lite</h1><p>Последние 10 партий Chess.com с разбором Stockfish прямо в браузере.</p></header><main><aside><form id="username-form"><label>Chess.com username<input id="username" value="${DEFAULT_USERNAME}" required></label><button>Загрузить партии</button></form><div id="progress"></div><div id="games"></div></aside><section><div id="report"><div class="empty">Выберите партию слева.</div></div></section></main>`;
  document.querySelector('#username-form').onsubmit = event => {
    event.preventDefault();
    loadGames(document.querySelector('#username').value.trim());
  };
  loadGames(DEFAULT_USERNAME);
}

document.addEventListener('keydown', event => {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault();
    navigateReplay(event.key === 'ArrowLeft' ? -1 : 1);
  }
});
render();
