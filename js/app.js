
// Reconocimiento de especies: fotos del anejo fotográfico del manual (ids 1001-1028).
// Las preguntas de teoría usan ids 1-500, así que los dos bancos nunca se mezclan.
const SP_KEY = 'Especies';
const EXTRA_NAMES = {
  b: ['Tórtola turca','Becacina (agachadiza)','Mirlo','Estornino negro','Cuervo','Graja','Rabilargo','Guión de codornices','Pinzón vulgar','Lúgano','Verdecillo'],
  m: ['Lobo','Cabra doméstica']
};
const TEMAS = [...new Set(QUESTIONS.map(q => q.tema))];
const TEMA_SHORT = TEMAS.map(t => t.split(':')[1].trim());

// ---------- persistence ----------
// Each answer record: { correctCount, wrongCount, lastCorrect, updatedAt }
// "lastCorrect" (not cumulative counts) decides whether a question is
// currently "failed" — that's what lets a question drop out of the
// repaso list the moment you get it right, even if you'd failed it
// before. "updatedAt" is what makes merging two devices safe: whichever
// record is newer always wins, per question — never a blind union.
const STORE_KEY = 'cazadorMadridProgress_v2';
const LEGACY_STORE_KEY = 'cazadorMadridProgress_v1';

function normalizeAnswers(raw) {
  const answers = (raw && raw.answers) || {};
  const legacyWrong = (raw && raw.wrong) || {};
  const out = {};
  Object.keys(answers).forEach(id => {
    const a = answers[id] || {};
    out[id] = {
      correctCount: a.correctCount || 0,
      wrongCount: a.wrongCount || 0,
      lastCorrect: typeof a.lastCorrect === 'boolean' ? a.lastCorrect : !legacyWrong[id],
      updatedAt: typeof a.updatedAt === 'number' ? a.updatedAt : 0
    };
    // keep the round stamp: without it, review answers get counted as round answers
    if (typeof a.roundAt === 'number') out[id].roundAt = a.roundAt;
  });
  return out;
}

function normalizeCycles(raw) {
  const cycles = (raw && raw.temaCycles) || {};
  const out = {};
  Object.keys(cycles).forEach(k => { out[k] = cycles[k] || 0; });
  return out;
}

function normalizeExplanations(raw) {
  const ex = (raw && raw.explanations) || {};
  const out = {};
  Object.keys(ex).forEach(k => {
    if (typeof ex[k] === 'string' && ex[k].trim()) out[k] = ex[k];
  });
  return out;
}

function loadProgress() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        answers: normalizeAnswers(parsed),
        temaCycles: normalizeCycles(parsed),
        explanations: normalizeExplanations(parsed)
      };
    }
    const legacyRaw = localStorage.getItem(LEGACY_STORE_KEY);
    if (legacyRaw) {
      const parsed = JSON.parse(legacyRaw);
      return { answers: normalizeAnswers(parsed), temaCycles: {}, explanations: {} };
    }
    return { answers: {}, temaCycles: {}, explanations: {} };
  } catch(e) { return { answers: {}, temaCycles: {}, explanations: {} }; }
}

let progress = loadProgress();

// When was this question last answered *as part of a tema round*?
// Review / exam answers don't count. Older records (no roundAt yet) fall
// back to updatedAt so existing progress behaves as before until reset.
function roundStamp(a) {
  if (!a) return 0;
  return typeof a.roundAt === 'number' ? a.roundAt : (a.updatedAt || 0);
}

// Rules:
//  - tema round: counts for the round. A miss goes to "falladas"; a hit
//    never removes a question from "falladas".
//  - exam: never counts for any round. Same falladas rule as tema.
//  - review: never counts for a round. A hit removes it from "falladas",
//    a miss keeps it there.
function recordAnswer(qid, correct, countsForRound, isReview) {
  const prev = progress.answers[qid] || { correctCount: 0, wrongCount: 0 };
  const now = Date.now();
  const wasPending = prev.lastCorrect === false;
  progress.answers[qid] = {
    correctCount: prev.correctCount + (correct ? 1 : 0),
    wrongCount: prev.wrongCount + (correct ? 0 : 1),
    lastCorrect: isReview ? correct : (correct ? !wasPending : false),
    updatedAt: now,
    roundAt: countsForRound ? now : roundStamp(prev)
  };
  saveProgress();
}

function saveProgress() {
  saveLocalOnly();
  persistCloud();
}

function saveLocalOnly() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(progress)); } catch(e) {}
}

// ---------- cross-device sync (Claude account) ----------
let dbDoc = null;
let dbReady = false;
let syncStatus = 'local'; // 'local' | 'synced' | 'unavailable' | 'error'
const APP_VERSION = 9;
let lastSyncError = null;
let dbApi = null;
let cloudUserId = null;
const dirtyExp = new Set();
function expChunkOf(qid) { return Math.floor((Number(qid) - 1) / 50); }
let saveChain = Promise.resolve();

function mergeAnswerSets(local, remote) {
  const merged = {};
  const ids = new Set(Object.keys(local).concat(Object.keys(remote)));
  ids.forEach(id => {
    const l = local[id], r = remote[id];
    if (l && r) {
      const bestRound = Math.max(roundStamp(l), roundStamp(r));
      if (l.updatedAt === r.updatedAt) {
        // Neither side has real timing info (both pre-date this fix, or
        // were merged at the same instant) — fall back to "more total
        // attempts seen" as the best guess of which is further along.
        const lTotal = l.correctCount + l.wrongCount;
        const rTotal = r.correctCount + r.wrongCount;
        merged[id] = Object.assign({}, lTotal >= rTotal ? l : r, { roundAt: bestRound });
      } else {
        merged[id] = Object.assign({}, l.updatedAt > r.updatedAt ? l : r, { roundAt: bestRound });
      }
    } else {
      merged[id] = l || r;
    }
  });
  return merged;
}

function mergeCycles(local, remote) {
  const merged = Object.assign({}, local);
  Object.keys(remote).forEach(k => {
    merged[k] = Math.max(merged[k] || 0, remote[k] || 0);
  });
  return merged;
}

// Explanation text for a given question is the same regardless of which
// device asked for it, so merging is just "keep whichever copy exists"
// (local wins on conflict, but conflicts here are harmless).
function mergeExplanations(local, remote) {
  return Object.assign({}, remote, local);
}

function mergeRemoteData(data) {
  progress = {
    answers: mergeAnswerSets(progress.answers, normalizeAnswers(data)),
    temaCycles: mergeCycles(progress.temaCycles, normalizeCycles(data)),
    explanations: mergeExplanations(progress.explanations, normalizeExplanations(data))
  };
}

// ---------- Supabase (cuenta + sincronización) ----------
let supa = null;
let currentUser = null;
let guestMode = false;
try { guestMode = localStorage.getItem('cazadorGuest') === '1'; } catch (e) {}

function supaConfigured() {
  return typeof SUPABASE_URL === 'string' && SUPABASE_URL.indexOf('TU-PROYECTO') === -1 &&
         typeof SUPABASE_ANON_KEY === 'string' && SUPABASE_ANON_KEY.indexOf('TU-CLAVE') === -1 &&
         window.supabase && window.supabase.createClient;
}

// Trae lo que hayan guardado otros dispositivos y lo mezcla sin escribir nada.
async function pullCloud() {
  if (!dbReady || !supa || !currentUser) return;
  try {
    const { data, error } = await supa.from('progress').select('data').eq('user_id', currentUser.id).maybeSingle();
    if (error) throw error;
    if (!data) return;
    const before = JSON.stringify(progress.temaCycles) + Object.keys(progress.answers).length;
    mergeRemoteData(data.data || {});
    saveLocalOnly();
    const after = JSON.stringify(progress.temaCycles) + Object.keys(progress.answers).length;
    if (before !== after && state.view === 'home') render();
  } catch (e) {}
}

document.addEventListener('visibilitychange', () => { if (!document.hidden) pullCloud(); });
window.addEventListener('focus', () => { pullCloud(); });

async function syncNow() {
  if (!dbReady) return;
  await persistCloud();
  await pullCloud();
  if (state.view === 'home') render();
}

async function initCloud() {
  if (!supaConfigured()) { syncStatus = 'unavailable'; render(); return; }
  try {
    supa = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    const { data } = await supa.auth.getSession();
    await onSession(data && data.session);
    supa.auth.onAuthStateChange((_ev, session) => { onSession(session); });
  } catch (e) {
    syncStatus = 'unavailable';
    render();
  }
}

let lastSessionUser = undefined;
async function onSession(session) {
  const user = session && session.user ? session.user : null;
  const uid = user ? user.id : null;
  if (uid === lastSessionUser) return;
  lastSessionUser = uid;
  currentUser = user;
  if (!user) {
    dbReady = false;
    syncStatus = 'login';
    render();
    return;
  }
  try {
    const { data, error } = await supa.from('progress').select('data').eq('user_id', user.id).maybeSingle();
    if (error) throw error;
    if (data) { mergeRemoteData(data.data || {}); saveLocalOnly(); }
    dbReady = true;
    syncStatus = 'synced';
    await persistCloud();
  } catch (e) {
    syncStatus = 'error';
    lastSyncError = (e && (e.code || e.message)) || 'error';
  }
  render();
}

function persistCloud() {
  if (!dbReady || !supa || !currentUser) return Promise.resolve();
  // Leer, mezclar y escribir: nunca machacar la copia de la nube con un
  // estado local antiguo (así un reinicio hecho en otro dispositivo no se deshace).
  saveChain = saveChain.then(async () => {
    try {
      try {
        const { data } = await supa.from('progress').select('data').eq('user_id', currentUser.id).maybeSingle();
        if (data) { mergeRemoteData(data.data || {}); saveLocalOnly(); }
      } catch (e) {}
      const { error } = await supa.from('progress').upsert({
        user_id: currentUser.id,
        data: {
          answers: JSON.parse(JSON.stringify(progress.answers)),
          temaCycles: JSON.parse(JSON.stringify(progress.temaCycles))
        },
        updated_at: new Date().toISOString()
      });
      if (error) throw error;
      syncStatus = 'synced';
      lastSyncError = null;
    } catch (e) {
      syncStatus = 'error';
      lastSyncError = (e && (e.code || e.message)) || 'error';
    }
    if (state.view === 'home') render();
  });
  return saveChain;
}

async function signInWith(provider) {
  if (!supa) return;
  try {
    await supa.auth.signInWithOAuth({
      provider,
      options: { redirectTo: window.location.origin + window.location.pathname }
    });
  } catch (e) { alert('No se ha podido iniciar sesión: ' + ((e && e.message) || 'error')); }
}
async function signOut() {
  try { await supa.auth.signOut(); } catch (e) {}
  lastSessionUser = undefined;
  currentUser = null; dbReady = false; syncStatus = 'login';
  render();
}
function continueAsGuest() {
  guestMode = true;
  try { localStorage.setItem('cazadorGuest', '1'); } catch (e) {}
  render();
}
function backToLogin() {
  guestMode = false;
  try { localStorage.removeItem('cazadorGuest'); } catch (e) {}
  render();
}

function loginHtml() {
  return `
    <div class="login-wrap">
      <div class="login-card">
        <h1>Manual del cazador</h1>
        <p class="login-sub">Comunidad de Madrid · preparación del examen</p>
        <p>Inicia sesión para guardar tu progreso y verlo igual en el móvil y en el ordenador.</p>
        <button class="login-btn google" onclick="signInWith('google')">Continuar con Google</button>
        <button class="login-btn facebook" onclick="signInWith('facebook')">Continuar con Facebook</button>
        ${LOGIN_APPLE ? '<button class="login-btn apple" onclick="signInWith(\'apple\')">Continuar con Apple</button>' : ''}
        <button class="login-guest" onclick="continueAsGuest()">Probar sin cuenta (solo en este navegador)</button>
        <p class="login-note">Si es la primera vez, se crea tu cuenta automáticamente.</p>
      </div>
    </div>`;
}

// Importar el progreso exportado desde la versión anterior (archivo .json).
function importProgressFile(input) {
  const f = input.files && input.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    try {
      const data = JSON.parse(r.result);
      mergeRemoteData(data);
      saveProgress();
      alert('Progreso importado.');
      render();
    } catch (e) { alert('El archivo no es válido.'); }
  };
  r.readAsText(f);
  input.value = '';
}

function statsOverall() {
  const answeredIds = Object.keys(progress.answers).filter(id => Number(id) <= 500);
  const seen = answeredIds.length;
  let correct = 0, total = 0;
  answeredIds.forEach(id => {
    const a = progress.answers[id];
    correct += a.correctCount;
    total += a.correctCount + a.wrongCount;
  });
  const accuracy = total ? Math.round((correct/total)*100) : 0;
  return { seen, accuracy };
}

// A question counts as "resolved" for a tema's current round once it has
// been answered (right or wrong) *after* that tema's last reset — that's
// what lets you close the app mid-round and pick up exactly where you left
// off, with right/wrong answers never served again until you reset.
function temaResetAt(temaShort) {
  return (progress.temaCycles && progress.temaCycles[temaShort]) || 0;
}

function temaQuestionIds(temaIdx) {
  return QUESTIONS.filter(q => q.tema === TEMAS[temaIdx]).map(q => q.num);
}

function temaRemainingIds(temaIdx) {
  const resetAt = temaResetAt(TEMA_SHORT[temaIdx]);
  return temaQuestionIds(temaIdx).filter(id => {
    const a = progress.answers[id];
    // roundStamp 0 = only ever answered in exam/review, never inside a round
    return !a || roundStamp(a) === 0 || roundStamp(a) < resetAt;
  });
}

function temaRoundStats(temaIdx) {
  const total = temaQuestionIds(temaIdx).length;
  const remaining = temaRemainingIds(temaIdx).length;
  return { total, done: total - remaining, remaining };
}

function wrongIds() {
  return Object.keys(progress.answers).filter(id => Number(id) <= 500 && progress.answers[id].lastCorrect === false);
}

// ---------- species (reconocimiento de especies) ----------
function spIds() { return SPECIES.map(x => x.id); }
function wrongSpeciesIds() {
  return Object.keys(progress.answers).filter(id => Number(id) > 1000 && progress.answers[id].lastCorrect === false).map(Number);
}
function spRemainingIds() {
  const resetAt = temaResetAt(SP_KEY);
  return spIds().filter(id => {
    const a = progress.answers[id];
    return !a || roundStamp(a) === 0 || roundStamp(a) < resetAt;
  });
}
function spRoundStats() {
  const total = SPECIES.length;
  const remaining = spRemainingIds().length;
  return { total, done: total - remaining, remaining };
}

// Varias fotos por especie: se elige una al azar, evitando repetir la última
// que salió de esa especie (se recuerda en este navegador).
function pickSpeciesImg(sp) {
  const n = sp.imgs.length;
  if (n === 1) return sp.imgs[0];
  let last = -1, store = {};
  try { store = JSON.parse(localStorage.getItem('cazadorSpLastImg') || '{}') || {}; } catch (e) {}
  if (typeof store[sp.id] === 'number') last = store[sp.id];
  let k;
  do { k = Math.floor(Math.random() * n); } while (k === last);
  store[sp.id] = k;
  try { localStorage.setItem('cazadorSpLastImg', JSON.stringify(store)); } catch (e) {}
  return sp.imgs[k];
}

function makeSpeciesQuestion(id) {
  const sp = SPECIES.find(x => x.id === id);
  const taken = new Set([sp.name]);
  const distractors = [];
  shuffle(sp.confuse).forEach(n => {
    if (distractors.length < 2 && !taken.has(n)) { distractors.push(n); taken.add(n); }
  });
  if (distractors.length < 2) {
    const pool = SPECIES.filter(x => x.kind === sp.kind).map(x => x.name).concat(EXTRA_NAMES[sp.kind]);
    shuffle(pool).forEach(n => {
      if (distractors.length < 2 && !taken.has(n)) { distractors.push(n); taken.add(n); }
    });
  }
  const names = shuffle([sp.name].concat(distractors));
  const letters = ['a','b','c'];
  return {
    num: id,
    isSpecies: true,
    species: sp,
    img: pickSpeciesImg(sp),
    statement: '¿Qué especie es la de la imagen?',
    options: names.map((n, i) => ({ letter: letters[i], text: n })),
    correct: letters[names.indexOf(sp.name)]
  };
}

function startSpeciesStudy() {
  const remaining = spRemainingIds();
  if (remaining.length === 0) { resetSpecies(); return; }
  const { total, done } = spRoundStats();
  buildQueue(shuffle(remaining), 'tema:' + SP_KEY, { isSpeciesRound: true, roundTotal: total, doneBefore: done });
  go('quiz');
}

function resetSpecies() {
  progress.temaCycles = progress.temaCycles || {};
  progress.temaCycles[SP_KEY] = Date.now();
  saveProgress();
  const ids = shuffle(spIds());
  buildQueue(ids, 'tema:' + SP_KEY, { isSpeciesRound: true, roundTotal: ids.length, doneBefore: 0 });
  go('quiz');
}

function askResetSpecies() {
  if (pendingResetIdx === 'sp') {
    clearTimeout(pendingResetTimer);
    pendingResetIdx = null;
    progress.temaCycles = progress.temaCycles || {};
    progress.temaCycles[SP_KEY] = Date.now();
    saveProgress();
    renderHome();
    return;
  }
  pendingResetIdx = 'sp';
  clearTimeout(pendingResetTimer);
  pendingResetTimer = setTimeout(() => { pendingResetIdx = null; if (state.view === 'home') renderHome(); }, 3500);
  renderHome();
}

function startSpeciesReview() {
  const ids = shuffle(wrongSpeciesIds());
  if (!ids.length) return;
  buildQueue(ids, 'review-sp');
  go('quiz');
}

function showSpeciesExplanation(q, selectedLetter, correct) {
  const box = document.getElementById('explanationBox');
  if (!box) return;
  const sp = q.species;
  const groupLabel = sp.group === 'caza mayor' ? 'caza mayor' : sp.group === 'silvestrismo' ? 'silvestrismo' : 'caza menor';
  let text = 'Es ' + sp.name.toLowerCase() + ' (' + sp.latin + '), especie de ' + groupLabel + '. ';
  if (!correct) {
    const chosen = q.options.find(o => o.letter === selectedLetter);
    if (chosen) text += 'Has marcado «' + chosen.text + '». ';
  }
  text += sp.tip;
  box.className = 'explanation-box';
  box.innerHTML = '<span class="label">Explicación</span>' + escapeHtml(text);
  box.style.display = 'block';
}

function wrongCount() {
  return wrongIds().length;
}

// ---------- routing ----------
let state = { view: 'home' };

function go(view, params) {
  state = Object.assign({ view }, params || {});
  render();
  window.scrollTo(0,0);
}

// ---------- shuffle helper ----------
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i+1));
    [a[i],a[j]] = [a[j],a[i]];
  }
  return a;
}

// ---------- render ----------
const app = document.getElementById('app');

function render() {
  if (supaConfigured() && !guestMode && !currentUser) {
    const root = document.getElementById('app');
    if (syncStatus === 'login') { root.innerHTML = loginHtml(); return; }
    if (syncStatus === 'local') { root.innerHTML = '<div class="login-wrap"><div class="login-card"><p>Cargando…</p></div></div>'; return; }
  }
  if (state.view === 'home') return renderHome();
  if (state.view === 'quiz') return renderQuiz();
  if (state.view === 'results') return renderResults();
}

function ringSvg(pct, size, stroke, colorVar) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const off = c * (1 - pct/100);
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <circle cx="${size/2}" cy="${size/2}" r="${r}" fill="none" stroke="var(--cream-2)" stroke-width="${stroke}"/>
    <circle cx="${size/2}" cy="${size/2}" r="${r}" fill="none" stroke="var(--${colorVar})" stroke-width="${stroke}"
      stroke-dasharray="${c}" stroke-dashoffset="${off}" stroke-linecap="round"
      transform="rotate(-90 ${size/2} ${size/2})"/>
  </svg>`;
}

function renderHome() {
  const { seen, accuracy } = statsOverall();
  const wc = wrongCount();
  const pct = Math.round((seen/500)*100);

  let temaHtml = '';
  TEMAS.forEach((tema, i) => {
    const { total, done, remaining } = temaRoundStats(i);
    const temaPct = total ? Math.round((done/total)*100) : 0;
    const complete = remaining === 0;
    temaHtml += `
      <div class="tema-card" onclick="startTemaStudy(${i})">
        <div class="tema-num">${complete ? '✓' : (i+1)}</div>
        <div class="tema-info">
          <div class="name">${TEMA_SHORT[i]}</div>
          <div class="meta">${complete
            ? 'Ronda completada'
            : done + '/' + total + ' hechas en esta ronda'}</div>
        </div>
        ${complete
          ? `<button class="retry-pill" onclick="event.stopPropagation(); resetTema(${i})">↻ Repetir</button>`
          : `<div class="mini-bar">${ringSvg(temaPct, 44, 5, 'gold')}</div>`}
        ${(done > 0 && !complete)
          ? `<button class="retry-pill" style="margin-left:8px" onclick="event.stopPropagation(); askResetTema(${i})">${pendingResetIdx === i ? '¿Seguro? Toca otra vez' : '↻ Reiniciar'}</button>`
          : ''}
      </div>`;
  });

  const spStats = spRoundStats();
  const spComplete = spStats.remaining === 0;
  const spPct = spStats.total ? Math.round((spStats.done/spStats.total)*100) : 0;
  const swc = wrongSpeciesIds().length;
  const speciesCardHtml = `
      <div class="tema-card" onclick="startSpeciesStudy()">
        <div class="tema-num">${spComplete ? '✓' : '📷'}</div>
        <div class="tema-info">
          <div class="name">Reconocimiento de especies</div>
          <div class="meta">${spComplete ? 'Ronda completada' : spStats.done + '/' + spStats.total + ' hechas en esta ronda'}</div>
        </div>
        ${spComplete
          ? `<button class="retry-pill" onclick="event.stopPropagation(); resetSpecies()">↻ Repetir</button>`
          : `<div class="mini-bar">${ringSvg(spPct, 44, 5, 'gold')}</div>`}
        ${(spStats.done > 0 && !spComplete)
          ? `<button class="retry-pill" style="margin-left:8px" onclick="event.stopPropagation(); askResetSpecies()">${pendingResetIdx === 'sp' ? '¿Seguro? Toca otra vez' : '↻ Reiniciar'}</button>`
          : ''}
      </div>`;

  app.innerHTML = `
    <div class="topbar">
      <div class="brand">
        <div class="kicker">Federación Madrileña de Caza · Cuaderno de preguntas</div>
        <h1>Manual del cazador</h1>
      </div>
      <div class="streak-chip">🦌 ${accuracy}%</div>
    </div>

    <div class="card hero">
      <div class="hero-row">
        <div>
          <div class="big-stat">${seen}<span> / 500</span></div>
          <div class="stat-label">preguntas practicadas</div>
        </div>
        ${ringSvg(pct, 66, 7, 'forest')}
      </div>
      <div class="bar"><div style="width:${pct}%"></div></div>
    </div>

    <div class="action-row">
      <button class="btn primary" onclick="startExam()">
        <span>
          <div class="t">Simulacro de examen</div>
          <div class="sub">30 preguntas: 20 de teoría + 10 de especies · apto con 15 y 8 aciertos</div>
        </span>
        <span>→</span>
      </button>
      <button class="btn secondary" style="grid-column:1/-1" onclick="startReview()" ${wc===0 ? 'disabled' : ''}>
        <span>Repasar falladas · teoría</span>
        <span class="count">${wc===0 ? 'Sin preguntas falladas todavía' : wc + ' pregunta' + (wc===1?'':'s') + ' pendientes de repaso'}</span>
      </button>
    </div>

    <div class="section-label">Temario (5 temas)</div>
    <div class="tema-list">${temaHtml}</div>

    <div class="section-label">Reconocimiento de especies (${SPECIES.length} fotos)</div>
    <div class="tema-list">${speciesCardHtml}</div>
    <div class="action-row" style="margin-top:9px">
      <button class="btn secondary" style="grid-column:1/-1" onclick="startSpeciesReview()" ${swc===0 ? 'disabled' : ''}>
        <span>Repasar falladas · especies</span>
        <span class="count">${swc===0 ? 'Sin especies falladas todavía' : swc + ' especie' + (swc===1?'':'s') + ' pendientes de repaso'}</span>
      </button>
    </div>

    <div class="footnote">
      Preguntas extraídas del <em>Manual para el examen del cazador</em> (Federación Madrileña de Caza, ed. 2018), con la respuesta correcta marcada en el propio documento. Según la Comunidad de Madrid, el examen tiene 30 preguntas (20 de teoría y 10 de reconocimiento de imágenes de especies) y para obtener la calificación de «apto» hace falta responder correctamente al menos 15 de la parte teórica y 8 de la parte práctica (reconocimiento de especies), un 76&nbsp;% del total. Las fotos de especies son las del anejo fotográfico del manual; en el examen real aparecen las mismas especies pero en movimiento.
      <br><br>${syncLabel()}
    </div>
  `;
}

function syncLabel() {
  const btn = `<button class="retry-pill" style="margin-top:8px" onclick="syncNow()">↻ Sincronizar ahora</button>`;
  const imp = `<div style="margin-top:8px"><label class="retry-pill" style="cursor:pointer">Importar progreso (.json)<input type="file" accept="application/json,.json" style="display:none" onchange="importProgressFile(this)"></label></div>`;
  const ver = `<div style="margin-top:8px;opacity:.6">Versión ${APP_VERSION}</div>`;
  if (syncStatus === 'synced') return '☁️ Progreso sincronizado con tu cuenta (' + escapeHtml((currentUser && currentUser.email) || 'sesión iniciada') + '): se ve igual en el móvil y en el ordenador.<br>' + btn + ' <button class="retry-pill" style="margin-top:8px" onclick="signOut()">Cerrar sesión</button>' + imp + ver;
  if (syncStatus === 'error') return '⚠️ No se ha podido sincronizar con la nube (' + escapeHtml(String(lastSyncError || 'error')) + '). Tu progreso sigue guardado en este dispositivo.<br>' + btn + imp + ver;
  if (syncStatus === 'login') return '📱 Progreso guardado solo en este dispositivo y navegador.<br><button class="retry-pill" style="margin-top:8px" onclick="backToLogin()">Iniciar sesión</button>' + imp + ver;
  if (syncStatus === 'unavailable') return '📱 Progreso guardado solo en este dispositivo y navegador (la sincronización con cuenta aún no está configurada).' + imp + ver;
  return '⏳ Comprobando tu sesión…' + ver;
}

// ---------- AI explanations (Claude's "sample" capability) ----------
let sampleStatus = 'unavailable'; // las explicaciones vienen de data/explanations.js
let explanationToken = 0;

function showExplanationLoading() {
  const box = document.getElementById('explanationBox');
  if (!box) return;
  box.className = 'explanation-box loading';
  box.innerHTML = '<span class="label">Explicación</span>Generando explicación…';
  box.style.display = 'block';
}
function showExplanationText(text) {
  const box = document.getElementById('explanationBox');
  if (!box) return;
  box.className = 'explanation-box';
  box.innerHTML = '<span class="label">Explicación</span>' + escapeHtml(text).replace(/\n+/g, '<br>');
  box.style.display = 'block';
}
function showExplanationError() {
  const box = document.getElementById('explanationBox');
  if (!box) return;
  box.className = 'explanation-box';
  box.innerHTML = '<span class="label">Explicación</span>No se ha podido generar ahora mismo.';
  box.style.display = 'block';
}

async function renderExplanation(q, selectedLetter, correct) {
  const cached = (progress.explanations && progress.explanations[q.num]) ||
                 (typeof EXPLANATIONS !== 'undefined' && EXPLANATIONS[q.num]);
  if (cached) showExplanationText(cached);
}

// ---------- quiz engine ----------
let quizState = null; // { ids: [], idx, correctSoFar, mode, selected, answered, temaIdx, roundTotal, doneBefore }

function buildQueue(ids, mode, extra) {
  quizState = Object.assign(
    { ids, idx: 0, correctSoFar: 0, mode, selected: null, answered: false, results: [] },
    extra || {}
  );
}

function startExam() {
  // Como el examen real: 20 de teoría (de las 500) + 10 de reconocimiento de especies.
  const theory = shuffle(QUESTIONS.map(q=>q.num)).slice(0, 20);
  const species = shuffle(spIds()).slice(0, 10);
  buildQueue(theory.concat(species), 'exam');
  go('quiz');
}

function startReview() {
  const ids = shuffle(wrongIds().map(Number));
  if (!ids.length) return;
  buildQueue(ids, 'review');
  go('quiz');
}

function startTemaStudy(i) {
  const remaining = temaRemainingIds(i);
  if (remaining.length === 0) { resetTema(i); return; }
  const { total, done } = temaRoundStats(i);
  buildQueue(shuffle(remaining), 'tema:' + TEMA_SHORT[i], { temaIdx: i, roundTotal: total, doneBefore: done });
  go('quiz');
}

let pendingResetIdx = null;
let pendingResetTimer = null;
function askResetTema(i) {
  if (pendingResetIdx === i) {
    clearTimeout(pendingResetTimer);
    pendingResetIdx = null;
    progress.temaCycles = progress.temaCycles || {};
    progress.temaCycles[TEMA_SHORT[i]] = Date.now();
    saveProgress();
    renderHome();
    return;
  }
  pendingResetIdx = i;
  clearTimeout(pendingResetTimer);
  pendingResetTimer = setTimeout(() => { pendingResetIdx = null; if (state.view === 'home') renderHome(); }, 3500);
  renderHome();
}

function resetTema(i) {
  progress.temaCycles = progress.temaCycles || {};
  progress.temaCycles[TEMA_SHORT[i]] = Date.now();
  saveProgress();
  const ids = shuffle(temaQuestionIds(i));
  buildQueue(ids, 'tema:' + TEMA_SHORT[i], { temaIdx: i, roundTotal: ids.length, doneBefore: 0 });
  go('quiz');
}

function currentQuestion() {
  const id = quizState.ids[quizState.idx];
  if (id > 1000) {
    quizState.spq = quizState.spq || {};
    if (!quizState.spq[id]) quizState.spq[id] = makeSpeciesQuestion(id);
    return quizState.spq[id];
  }
  return QUESTIONS.find(q => q.num === id);
}

function renderQuiz() {
  explanationToken++; // invalidate any in-flight explanation request from the previous question
  const q = currentQuestion();
  const sessionTotal = quizState.ids.length;
  const isTema = typeof quizState.roundTotal === 'number';
  // In tema mode the header shows progress across the whole 255-question
  // round (picking up from where a previous session left off), not just
  // this resumed batch — that's the number the person actually cares about.
  const displayTotal = isTema ? quizState.roundTotal : sessionTotal;
  const displayNum = isTema ? (quizState.doneBefore + quizState.idx + 1) : (quizState.idx + 1);
  const examPart = q.isSpecies ? 'Parte práctica · especies' : 'Parte teórica';
  const modeLabel = quizState.mode === 'exam' ? 'Simulacro de examen · ' + examPart
    : quizState.mode === 'review' ? 'Repaso de falladas · teoría'
    : quizState.mode === 'review-sp' ? 'Repaso de falladas · especies'
    : quizState.mode === 'tema:' + SP_KEY ? 'Reconocimiento de especies'
    : quizState.mode;
  const pct = Math.round((displayNum/displayTotal)*100);

  let optionsHtml = '';
  q.options.forEach(o => {
    optionsHtml += `<button class="option" data-letter="${o.letter}" onclick="selectOption('${o.letter}')">
      <span class="letter">${o.letter}</span><span>${escapeHtml(o.text)}</span>
    </button>`;
  });

  app.innerHTML = `
    <div class="quiz-header">
      <button class="back-btn" onclick="exitQuiz()">← Salir</button>
      <div class="quiz-progress-text">${displayNum} / ${displayTotal}</div>
    </div>
    <div class="quiz-bar"><div style="width:${pct}%"></div></div>
    <div class="tema-tag">${modeLabel}</div>
    ${q.isSpecies ? `<img class="species-img" src="${q.img}" alt="Especie a identificar" draggable="false">` : ''}
    <div class="question-text">${escapeHtml(q.statement)}</div>
    <div class="options">${optionsHtml}</div>
    <div class="feedback-banner" id="feedback"></div>
    <div class="explanation-box" id="explanationBox"></div>
    <div class="quiz-footer">
      <button class="next-btn" id="nextBtn" onclick="nextQuestion()">
        ${quizState.idx+1 === sessionTotal ? 'Ver resultados' : 'Siguiente'} →
      </button>
    </div>
  `;
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function selectOption(letter) {
  if (quizState.answered) return;
  const q = currentQuestion();
  quizState.answered = true;
  quizState.selected = letter;
  const correct = letter === q.correct;
  if (correct) quizState.correctSoFar++;
  quizState.results.push({ q, selected: letter, correct });
  recordAnswer(q.num, correct, typeof quizState.roundTotal === 'number', quizState.mode === 'review' || quizState.mode === 'review-sp');

  document.querySelectorAll('.option').forEach(btn => {
    btn.setAttribute('disabled', 'true');
    const l = btn.getAttribute('data-letter');
    if (l === q.correct) btn.classList.add('correct');
    else if (l === letter) btn.classList.add('wrong');
    else btn.classList.add('dim');
  });

  const fb = document.getElementById('feedback');
  fb.classList.add('show', correct ? 'good' : 'bad');
  fb.textContent = correct ? 'Correcto.' : 'Incorrecto — la respuesta correcta es la ' + q.correct + '.';

  document.getElementById('nextBtn').classList.add('show');
  if (q.isSpecies) showSpeciesExplanation(q, letter, correct);
  else renderExplanation(q, letter, correct);
}

function nextQuestion() {
  if (quizState.idx + 1 >= quizState.ids.length) {
    go('results');
    return;
  }
  quizState.idx++;
  quizState.answered = false;
  quizState.selected = null;
  renderQuiz();
}

function exitQuiz() {
  if (quizState.results.length > 0) { go('results'); }
  else { go('home'); }
}

function renderResults() {
  const total = quizState.results.length;
  const correct = quizState.correctSoFar;
  const pct = total ? Math.round((correct/total)*100) : 0;
  const isExam = quizState.mode === 'exam';
  const isTema = typeof quizState.temaIdx === 'number';
  const isSpRound = !!quizState.isSpeciesRound;
  const theoryRes = quizState.results.filter(r => !r.q.isSpecies);
  const speciesRes = quizState.results.filter(r => r.q.isSpecies);
  const theoryOk = theoryRes.filter(r => r.correct).length;
  const speciesOk = speciesRes.filter(r => r.correct).length;
  const examComplete = isExam && total >= 30;
  const passed = theoryOk >= 15 && speciesOk >= 8;
  const failed = quizState.results.filter(r => !r.correct);

  let roundNote = '';
  let retryLabel = 'Repetir';
  if (isTema) {
    const { total: roundTotal, done, remaining } = temaRoundStats(quizState.temaIdx);
    if (remaining === 0) {
      roundNote = `<div class="footnote" style="text-align:center;margin-top:10px;">¡Ronda de ${roundTotal} preguntas completada! Lo que falló se queda en «Repasar falladas».</div>`;
      retryLabel = 'Repetir tema';
    } else {
      roundNote = `<div class="footnote" style="text-align:center;margin-top:10px;">Llevas ${done}/${roundTotal} de esta ronda. El resto se queda guardado para cuando vuelvas.</div>`;
      retryLabel = 'Continuar';
    }
  }
  if (isSpRound) {
    const { total: roundTotal, done, remaining } = spRoundStats();
    if (remaining === 0) {
      roundNote = `<div class="footnote" style="text-align:center;margin-top:10px;">¡Ronda de ${roundTotal} especies completada! Lo que falló se queda en «Repasar falladas · especies».</div>`;
      retryLabel = 'Repetir ronda';
    } else {
      roundNote = `<div class="footnote" style="text-align:center;margin-top:10px;">Llevas ${done}/${roundTotal} de esta ronda. El resto se queda guardado para cuando vuelvas.</div>`;
      retryLabel = 'Continuar';
    }
  }
  const examBreakdown = isExam ? `
      <div class="part-row ${theoryOk >= 15 ? 'ok' : 'ko'}"><span>Teoría (mínimo 15 de 20)</span><b>${theoryOk}/${theoryRes.length}</b></div>
      <div class="part-row ${speciesOk >= 8 ? 'ok' : 'ko'}"><span>Especies (mínimo 8 de 10)</span><b>${speciesOk}/${speciesRes.length}</b></div>
      <div class="part-row ${correct >= 23 ? 'ok' : 'ko'}"><span>Total (76 % = 23 de 30)</span><b>${correct}/${total} · ${pct} %</b></div>` : '';

  let reviewHtml = '';
  if (failed.length) {
    failed.forEach(r => {
      const correctOpt = r.q.options.find(o=>o.letter===r.q.correct);
      const wrongOpt = r.q.options.find(o=>o.letter===r.selected);
      reviewHtml += `
        <div class="review-item">
          ${r.q.isSpecies ? `<img class="species-thumb" src="${r.q.img}" alt="">` : ''}
          <div class="q">${escapeHtml(r.q.statement)}</div>
          <div class="a-wrong">${r.selected}. ${escapeHtml(wrongOpt.text)}</div>
          <div class="a-correct">${r.q.correct}. ${escapeHtml(correctOpt.text)}</div>
        </div>`;
    });
  }

  app.innerHTML = `
    <div class="topbar">
      <button class="back-btn" onclick="go('home')">← Inicio</button>
    </div>
    <div class="card result-hero">
      <div class="score">${correct}/${total}</div>
      <div class="score-label">respuestas correctas (${pct}%)</div>
      ${isExam ? `<div class="verdict ${examComplete ? (passed?'pass':'fail') : 'fail'}">${!examComplete ? 'Examen incompleto' : passed ? 'APTO' : 'NO APTO'}</div>` : ''}
      ${examBreakdown}
    </div>
    ${roundNote}
    ${failed.length ? `
      <div class="section-label">Para repasar (${failed.length})</div>
      <div class="review-list">${reviewHtml}</div>
    ` : `<div class="footnote" style="text-align:center;margin-top:10px;">Ninguna fallada. ¡Buen manejo del temario!</div>`}
    <div class="action-row" style="margin-top:24px;">
      <button class="btn secondary" onclick="go('home')"><span>Volver al inicio</span></button>
      <button class="btn secondary" onclick="retrySame()"><span>${retryLabel}</span></button>
    </div>
  `;
}

function retrySame() {
  const mode = quizState.mode;
  if (mode === 'exam') startExam();
  else if (mode === 'review') startReview();
  else if (mode === 'review-sp') startSpeciesReview();
  else if (quizState.isSpeciesRound) startSpeciesStudy();
  else if (typeof quizState.temaIdx === 'number') startTemaStudy(quizState.temaIdx);
  else go('home');
}

render();
initCloud();
