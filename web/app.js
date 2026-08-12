/**
 * sorteio-quantico — aplicação do cliente.
 *
 * SPA minúscula sem framework: três rotas (/, /s/<slug>, /verificar), i18n em
 * oito idiomas e o verificador. Sem dependências externas — o site inteiro é
 * HTML, CSS e três módulos ES.
 */

import { LOCALES, STRINGS, ERROR_KEYS, DEFAULT_LOCALE, detectLocale } from './i18n.js';
import { verifyDraw, parseSlug, STEP_KEYS } from './verify.js';

// ------------------------------------------------------------------ i18n

let lang = detectLocale();

function t(key, vars) {
  const table = STRINGS[lang] ?? STRINGS[DEFAULT_LOCALE];
  let s = table[key] ?? STRINGS[DEFAULT_LOCALE][key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, v);
  return s;
}

function applyI18n() {
  const meta = LOCALES[lang];
  document.documentElement.lang = lang;
  document.documentElement.dir = meta.dir;
  document.title = t('meta.title');
  document.getElementById('meta-desc')?.setAttribute('content', t('meta.desc'));

  for (const el of document.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of document.querySelectorAll('[data-i18n-ph]')) {
    el.placeholder = t(el.dataset.i18nPh);
  }
  document.getElementById('lang-current').textContent = meta.native;
  for (const b of document.querySelectorAll('#lang-list button')) {
    b.setAttribute('aria-current', String(b.dataset.lang === lang));
  }
  updateCount();
}

function setLang(next) {
  if (!STRINGS[next]) return;
  lang = next;
  localStorage.setItem('qdraw.lang', next);
  applyI18n();
  render(); // a rota atual pode ter conteúdo gerado por JS
}

function buildLangMenu() {
  const list = document.getElementById('lang-list');
  list.innerHTML = '';
  for (const [code, meta] of Object.entries(LOCALES)) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.lang = code;
    b.textContent = `${meta.native} · ${meta.name}`;
    b.addEventListener('click', () => {
      setLang(code);
      document.getElementById('lang').classList.remove('open');
    });
    li.appendChild(b);
    list.appendChild(li);
  }

  const wrap = document.getElementById('lang');
  const btn = document.getElementById('lang-btn');
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = wrap.classList.toggle('open');
    btn.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', () => {
    wrap.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
  });
}

// ---------------------------------------------------------------- helpers

const fmtNum = (n) => new Intl.NumberFormat(LOCALES[lang].intl).format(n ?? 0);

const fmtDate = (ts) =>
  new Intl.DateTimeFormat(LOCALES[lang].intl, { dateStyle: 'medium', timeStyle: 'short' })
    .format(new Date(ts * 1000));

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

async function api(path, options) {
  const res = await fetch(path, options);
  let body = null;
  try { body = await res.json(); } catch { /* resposta sem corpo */ }
  if (!res.ok) {
    const key = ERROR_KEYS[body?.error];
    const err = new Error(key ? t(key) : body?.message || t('err.generic'));
    err.code = body?.error;
    err.status = res.status;
    throw err;
  }
  return body;
}

function hashRow(labelKey, value, copyable = true) {
  if (value === null || value === undefined || value === '') return '';
  return `<div class="hash-row">
    <span class="lbl">${esc(t(labelKey))}</span>
    <code>${esc(value)}</code>
    ${copyable ? `<button class="copy" type="button" data-copy="${esc(value)}">${esc(t('common.copy'))}</button>` : '<span></span>'}
  </div>`;
}

// Delegação: todo botão .copy da página, inclusive os criados depois.
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-copy]');
  if (!btn) return;
  try {
    await navigator.clipboard.writeText(btn.dataset.copy);
    const old = btn.textContent;
    btn.textContent = t('common.copied');
    setTimeout(() => { btn.textContent = old; }, 1400);
  } catch { /* clipboard negado; o texto continua selecionável */ }
});

// -------------------------------------------------------------- contadores

function countUp(el, target) {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce || target === 0) { el.textContent = fmtNum(target); return; }
  const start = performance.now();
  const dur = 900;
  const tick = (now) => {
    const p = Math.min(1, (now - start) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = fmtNum(Math.round(target * eased));
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

let visitCounted = false;

async function loadStats() {
  try {
    // A primeira carga registra a visita; trocas de rota só releem.
    const stats = visitCounted
      ? await api('/api/stats')
      : await api('/api/visit', { method: 'POST' });
    visitCounted = true;
    for (const el of document.querySelectorAll('[data-stat]')) {
      countUp(el, stats[el.dataset.stat] ?? 0);
    }
  } catch {
    for (const el of document.querySelectorAll('[data-stat]')) el.textContent = '—';
  }
}

async function loadPoolNote() {
  const box = document.getElementById('pool-note');
  if (!box) return;
  try {
    const pool = await api('/api/pool');
    const src = pool.source ?? {};
    if (src.quantum === false || src.provider === 'local_csprng') {
      box.innerHTML = `<div class="alert alert-error"><span class="badge warn">⚠</span> ${esc(t('common.devPool'))}</div>`;
    } else {
      const who = src.provider === 'ibm_quantum'
        ? `IBM Quantum · ${esc(src.backend ?? '?')}`
        : src.provider === 'anu_qrng' ? 'ANU QRNG' : esc(src.provider ?? '?');
      box.innerHTML = `<div class="alert alert-info"><span class="badge q">●</span> ${who} · ${esc(t('proof.root'))} <code style="font-size:.74rem">${esc(pool.merkle_root.slice(0, 24))}…</code></div>`;
    }
  } catch {
    box.innerHTML = '';
  }
}

async function loadRecent() {
  const grid = document.getElementById('recent-grid');
  if (!grid) return;
  try {
    const { draws } = await api('/api/draws');
    if (!draws.length) {
      grid.innerHTML = `<p style="color:var(--text-faint)">${esc(t('recent.empty'))}</p>`;
      return;
    }
    if (draws.some((d) => d.kind === 'lottery')) await loadLotteries();
    grid.innerHTML = draws.map((d) => {
      const isLot = d.kind === 'lottery';
      const meta = isLot
        ? `${esc(LOTTERY_NAMES[d.lottery.lottery] ?? d.lottery.lottery)} · ${fmtNum(d.lottery.games)} ${esc(t('lot.gamesN'))}`
        : `${fmtNum(d.participant_count)} ${esc(t('draw.entries'))}`;
      const body = isLot
        ? esc(gamesAsText(d.games, lotteries?.[d.lottery.lottery]).replace(/^1\.\s*/, ''))
        : esc(d.winners.join(', ')) + (d.winners_count > d.winners.length ? '…' : '');
      return `
      <a class="recent-card" href="/s/${esc(d.slug)}" data-nav>
        <h4>${esc(drawTitle(d))}</h4>
        <div class="meta">${meta} · ${esc(fmtDate(d.drawn_at))}</div>
        <div class="w">${body}</div>
      </a>`;
    }).join('');
  } catch {
    grid.innerHTML = '';
  }
}

// ----------------------------------------------------------------- loterias

// Nomes de marca da Caixa: não se traduzem em idioma nenhum.
const LOTTERY_NAMES = {
  megasena: 'Mega-Sena', lotofacil: 'Lotofácil', quina: 'Quina',
  lotomania: 'Lotomania', duplasena: 'Dupla Sena', timemania: 'Timemania',
  diadesorte: 'Dia de Sorte', maismilionaria: '+Milionária', supersete: 'Super Sete',
};

let lotteries = null;
let mode = 'list';

/** Busca o catálogo uma única vez. Também usado pela página de resultado,
 *  que precisa dos limites para formatar as bolinhas. */
async function loadLotteries() {
  if (!lotteries) {
    try {
      lotteries = (await api('/api/lotteries')).lotteries;
    } catch {
      return;
    }
  }
  const sel = document.getElementById('f-lottery');
  if (!sel || sel.options.length) return;
  sel.innerHTML = Object.keys(lotteries)
    .map((id) => `<option value="${esc(id)}">${esc(LOTTERY_NAMES[id] ?? id)}</option>`)
    .join('');
  sel.addEventListener('change', () => applyLotterySpec());
  applyLotterySpec();
}

function currentSpec() {
  const sel = document.getElementById('f-lottery');
  return sel && lotteries ? lotteries[sel.value] : null;
}

/**
 * Troca de modalidade: aplica limites e **sempre volta à aposta mínima**.
 *
 * Antes o valor anterior era mantido quando cabia no novo intervalo, e isso
 * produzia surpresas caras: sair da Lotofácil (15 números) para a Quina
 * deixava 15 marcados, uma aposta válida mas 3.003 vezes mais cara que a
 * mínima de 5. Modalidades são jogos diferentes; carregar a quantidade de uma
 * para a outra não significa nada.
 */
function applyLotterySpec() {
  const spec = currentSpec();
  if (!spec) return;

  const picks = document.getElementById('f-picks');
  picks.min = spec.min;
  picks.max = spec.max;
  picks.value = spec.default;
  picks.disabled = spec.min === spec.max;

  const extraWrap = document.getElementById('f-extra-wrap');
  extraWrap.classList.toggle('hide', spec.extra !== 'trevos');
  if (spec.extra === 'trevos') {
    const extra = document.getElementById('f-extra');
    extra.min = spec.extra_min;
    extra.max = spec.extra_max;
    extra.value = spec.extra_default;
  }
  refreshRuleHint();
}

/** Só o texto da regra. Não mexe no valor — senão é impossível digitar. */
function refreshRuleHint() {
  const spec = currentSpec();
  const hint = document.getElementById('f-lot-rule');
  if (!spec || !hint) return;
  const picks = document.getElementById('f-picks');
  if (spec.columns) {
    hint.textContent = t('lot.columns', { c: spec.columns, n: picks.value || spec.default });
  } else if (spec.min === spec.max) {
    hint.textContent = t('lot.fixed', { n: spec.min, lo: spec.lo, hi: spec.hi });
  } else {
    hint.textContent = t('lot.range', { min: spec.min, max: spec.max, lo: spec.lo, hi: spec.hi });
  }
}

/**
 * Ajusta ao intervalo só quando o campo perde o foco.
 *
 * Corrigir a cada tecla impedia digitar valores de dois algarismos: na
 * Lotofácil, o "1" de "16" já ficava abaixo do mínimo e era substituído por
 * 15 antes de o "6" chegar.
 */
function clampPicks() {
  const spec = currentSpec();
  const picks = document.getElementById('f-picks');
  if (!spec || !picks) return;
  const n = Number(picks.value);
  if (!Number.isFinite(n) || picks.value === '') picks.value = spec.default;
  else if (n < spec.min) picks.value = spec.min;
  else if (n > spec.max) picks.value = spec.max;
  refreshRuleHint();
}

/**
 * Devolve o botão ao estado normal.
 *
 * Depois de criar um sorteio a página navega para /s/<slug> e o botão fica
 * para trás, desabilitado e escrito "Comprometendo…". Quem voltasse para a
 * home — pelo botão do navegador ou pelo menu "Criar" — encontrava o
 * formulário inteiro travado, sem nenhuma pista do motivo.
 */
function resetSubmit() {
  const submit = document.getElementById('f-submit');
  if (!submit) return;
  submit.disabled = false;
  submit.innerHTML = `<span>${esc(t(mode === 'lottery' ? 'lot.submit' : 'form.submit'))}</span>`;
}

function setMode(next) {
  mode = next;
  for (const b of document.querySelectorAll('.modes .mode')) {
    b.classList.toggle('on', b.dataset.mode === next);
  }
  for (const pane of document.querySelectorAll('[data-pane]')) {
    pane.classList.toggle('hide', pane.dataset.pane !== next);
  }
  const submit = document.querySelector('#f-submit span');
  if (submit) submit.textContent = t(next === 'lottery' ? 'lot.submit' : 'form.submit');
  if (next === 'lottery') loadLotteries();
}

/** Bolinhas de um jogo, do jeito que se vê num volante. */
function gameHtml(game, spec, index) {
  const pad = (n) => String(n).padStart(String(spec?.hi ?? 60).length, '0');

  // `--i` escalona a animação de medição, uma dezena de cada vez. O teto de 16
  // existe por causa da Lotomania: 50 bolinhas a 55 ms viravam quase três
  // segundos de espera para ler o próprio jogo.
  let seq = 0;
  const ball = (txt, cls = 'ball') =>
    `<span class="${cls}" style="--i:${Math.min(seq++, 16)}">${txt}</span>`;

  let body;
  if (game.columns) {
    body = `<div class="cols">${game.columns
      .map((col) => `<span class="col">${col.map((d) => ball(d)).join('')}</span>`)
      .join('')}</div>`;
  } else {
    body = `<div class="balls">${game.numbers.map((n) => ball(pad(n))).join('')}</div>`;
  }
  const extras = [];
  if (game.trevos) {
    extras.push(`<span class="tag">${esc(t('lot.clovers'))}</span><div class="balls">${
      game.trevos.map((n) => ball(n, 'ball clover')).join('')}</div>`);
  }
  if (game.mes) {
    extras.push(`<span class="tag">${esc(t('lot.month'))}: ${esc(game.mes)}</span>`);
  }
  return `<div class="game"><span class="idx">${index + 1}</span>${body}${extras.join('')}</div>`;
}

/** Texto puro dos jogos, para colar no volante ou mandar no grupo. */
function gamesAsText(games, spec) {
  const pad = (n) => String(n).padStart(String(spec?.hi ?? 60).length, '0');
  return games.map((g, i) => {
    let line;
    if (g.columns) line = g.columns.map((c) => c.join('')).join(' | ');
    else line = g.numbers.map(pad).join(' ');
    if (g.trevos) line += `  ${t('lot.clovers')}: ${g.trevos.join(' ')}`;
    if (g.mes) line += `  ${t('lot.month')}: ${g.mes}`;
    return `${i + 1}. ${line}`;
  }).join('\n');
}


/** Titulo de exibicao: o campo e opcional, entao cai no nome da modalidade
 *  ou num rotulo generico quando vem vazio. */
function drawTitle(draw) {
  if (draw.title) return draw.title;
  if (draw.kind === 'lottery') {
    return LOTTERY_NAMES[draw.lottery.lottery] ?? draw.lottery.lottery;
  }
  return t('draw.untitled');
}

// -------------------------------------------------------------- formulário

function updateCount() {
  const ta = document.getElementById('f-list');
  const out = document.getElementById('f-count');
  if (!ta || !out) return;
  const n = ta.value.split('\n').map((s) => s.trim()).filter(Boolean).length;
  out.textContent = n ? t('form.count', { n: fmtNum(n) }) : '';
  const w = document.getElementById('f-winners');
  if (w && n) w.max = String(n);
}

function initForm() {
  const form = document.getElementById('draw-form');
  const list = document.getElementById('f-list');
  const errBox = document.getElementById('form-error');
  const submit = document.getElementById('f-submit');
  if (!form) return;

  list.addEventListener('input', updateCount);
  const picksInput = document.getElementById('f-picks');
  picksInput?.addEventListener('input', refreshRuleHint);
  picksInput?.addEventListener('change', clampPicks);
  picksInput?.addEventListener('blur', clampPicks);
  for (const b of document.querySelectorAll('.modes .mode')) {
    b.addEventListener('click', () => setMode(b.dataset.mode));
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errBox.classList.add('hide');

    const common = {
      title: document.getElementById('f-title').value.trim(),
      is_public: document.getElementById('f-public').checked,
      locale: lang,
    };
    const payload = mode === 'lottery'
      ? {
          ...common,
          kind: 'lottery',
          lottery: document.getElementById('f-lottery').value,
          games: Number(document.getElementById('f-games').value),
          picks: Number(document.getElementById('f-picks').value),
          extra_picks: Number(document.getElementById('f-extra').value) || null,
        }
      : {
          ...common,
          participants: list.value.split('\n'),
          winners_count: Number(document.getElementById('f-winners').value),
        };

    submit.disabled = true;
    submit.innerHTML = `<span class="spinner"></span><span>${esc(t('form.submitting'))}</span>`;
    try {
      const draw = await api('/api/draws', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      navigate(`/s/${draw.slug}`);
    } catch (err) {
      errBox.textContent = err.message;
      errBox.classList.remove('hide');
      submit.disabled = false;
      submit.innerHTML = `<span>${esc(t(mode === 'lottery' ? 'lot.submit' : 'form.submit'))}</span>`;
    }
  });
}

// ------------------------------------------------------------ página do sorteio

let drawTimer = null;

function stopDrawTimer() {
  if (drawTimer) { clearInterval(drawTimer); drawTimer = null; }
}

async function renderDraw(slug) {
  const box = document.getElementById('draw-body');
  box.innerHTML = `<div class="card center loading-card">
      <span class="spinner spinner-lg"></span>
      <span style="color:var(--text-dim)">${esc(t('common.loading'))}</span>
    </div>`;
  stopDrawTimer();

  let draw;
  try {
    draw = await api(`/api/draws/${slug}`);
    // Os limites da modalidade definem o preenchimento das dezenas.
    if (draw.kind === 'lottery') await loadLotteries();
  } catch (err) {
    box.innerHTML = `<div class="card center">
      <p>${esc(err.message)}</p>
      <a class="btn btn-ghost" href="/" data-nav>${esc(t('common.back'))}</a></div>`;
    return;
  }

  // Sem este try, qualquer erro na renderização deixa o visitante olhando
  // "Carregando…" para sempre, sem nenhuma pista do que houve. Já aconteceu.
  try {
    if (draw.status === 'drawn') paintResult(box, draw);
    else paintCountdown(box, draw, slug);
  } catch (err) {
    console.error('falha ao renderizar sorteio', err);
    box.innerHTML = `<div class="card center">
      <p>${esc(t('err.generic'))}</p>
      <p class="mono" style="color:var(--text-faint);font-size:.78rem">${esc(err.message)}</p>
      <a class="btn btn-ghost" href="/" data-nav>${esc(t('common.back'))}</a>
    </div>`;
  }
}

function paintCountdown(box, draw, slug) {
  const isLottery = draw.kind === 'lottery';
  const c = draw.commitment;
  const total = Math.max(1, c.reveal_time - draw.created_at);

  box.innerHTML = `
    <div class="card">
      <div class="center" style="margin-bottom:6px">
        <span class="badge q">●</span>
      </div>
      <h2 class="center" style="font-size:1.5rem">${esc(drawTitle(draw))}</h2>
      <p class="center" style="color:var(--text-dim);font-size:.9rem">
        ${isLottery
          ? `${draw.title ? esc(LOTTERY_NAMES[draw.lottery.lottery] ?? draw.lottery.lottery) + ' · ' : ''}${fmtNum(draw.lottery.games)} ${esc(t('lot.gamesN'))}`
          : `${fmtNum(draw.participant_count)} ${esc(t('draw.entries'))} · ${fmtNum(draw.winners_count)} ${esc(t('draw.winnersN'))}`}
      </p>

      <div class="countdown">
        <div class="ring">
          <svg width="168" height="168" viewBox="0 0 168 168">
            <circle class="track" cx="84" cy="84" r="76"></circle>
            <circle class="prog"  cx="84" cy="84" r="76" id="ring-prog"
                    stroke-dasharray="477.5" stroke-dashoffset="0"></circle>
          </svg>
          <div class="orbits" aria-hidden="true"><i></i><i></i><i></i></div>
          <div class="t"><span id="cd-num">—</span><small>${esc(t('draw.sec'))}</small></div>
        </div>
        <h3 style="font-size:1.05rem">${esc(t(isLottery ? 'draw.lockedLot' : 'draw.locked'))}</h3>
        <p style="color:var(--text-dim);font-size:.9rem;max-width:440px;margin:0 auto">
          ${esc(t('draw.lockedSub'))}
        </p>
      </div>

      <div style="margin-top:26px">
        ${hashRow('proof.commit', c.commit_hash)}
        ${hashRow(isLottery ? 'proof.config' : 'proof.plist', c.participants_hash)}
        ${hashRow('proof.root', c.merkle_root)}
        ${hashRow('proof.idx', String(c.pulse_index))}
        ${hashRow('proof.round', String(c.drand_round))}
      </div>
    </div>`;

  const num = document.getElementById('cd-num');
  const ring = document.getElementById('ring-prog');
  const C = 477.5;

  const tick = async () => {
    const left = Math.max(0, c.reveal_time - Math.floor(Date.now() / 1000));
    num.textContent = String(left);
    ring.style.strokeDashoffset = String(C * (1 - left / total));

    if (left > 0) return;
    stopDrawTimer();
    box.querySelector('.countdown').innerHTML =
      `<div class="collapse${isLottery ? ' wide' : ''}" id="collapse">
         <div class="ghosts" id="ghosts" aria-hidden="true"></div>
         <div class="lbl">${esc(t('draw.drawing'))}</div>
       </div>`;
    try {
      const done = await api(`/api/draws/${slug}/reveal`, { method: 'POST' });
      await collapseThen(collapsePool(done), measuredValue(done), () => paintResult(box, done));
    } catch (err) {
      // 425 significa que o relógio do cliente adiantou; tenta de novo em 3s.
      if (err.status === 425) { setTimeout(() => renderDraw(slug), 3000); return; }
      box.innerHTML = `<div class="card center"><p>${esc(err.message)}</p></div>`;
    }
  };

  tick();
  drawTimer = setInterval(tick, 1000);
}

/** Uma linha plausível da modalidade — candidato que nunca foi sorteado, só
 *  serve de amplitude fantasma enquanto a medição não aconteceu. */
function randomLine(spec) {
  const width = String(spec.hi).length;
  const pad = (n) => String(n).padStart(width, '0');
  const pick = (k, lo, hi) => {
    const set = new Set();
    while (set.size < Math.min(k, hi - lo + 1)) set.add(lo + Math.floor(Math.random() * (hi - lo + 1)));
    return [...set].sort((a, b) => a - b);
  };
  if (spec.columns) {
    return Array.from({ length: spec.columns }, () => pick(1, spec.lo, spec.hi).join('')).join(' | ');
  }
  return pick(spec.default, spec.lo, spec.hi).map(pad).join(' ');
}

/** Os candidatos que aparecem em superposição antes do colapso. */
function collapsePool(draw) {
  if (draw.kind !== 'lottery') return draw.participants ?? [];
  const spec = lotteries?.[draw.lottery.lottery];
  if (!spec) return [];
  return Array.from({ length: 36 }, () => randomLine(spec));
}

/** O valor que a medição realmente produziu — a camada sobrevivente assume
 *  este texto no fim, para o colapso terminar no resultado de verdade e não
 *  num candidato aleatório que o repaint troca no quadro seguinte. */
function measuredValue(draw) {
  if (draw.kind !== 'lottery') return draw.result?.winners?.[0] ?? '';
  const spec = lotteries?.[draw.lottery.lottery];
  const games = draw.result?.games ?? [];
  if (!games.length) return '';
  return gamesAsText([games[0]], spec).replace(/^1\.\s*/, '');
}

const COLLAPSE_MS = 1900;
const GHOSTS = 7;

/**
 * Colapso da superposição.
 *
 * As camadas coexistem girando e trocando de valor; conforme a decoerência
 * avança a nuvem encolhe, as amplitudes se apagam uma a uma e a última fica
 * nítida no valor medido. `done()` é chamado no fim — nunca depois de um
 * caminho que possa não executar, senão o resultado nunca apareceria.
 */
function collapseThen(pool, measured, done) {
  const host = document.getElementById('ghosts');
  if (!host || !pool.length || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    done();
    return Promise.resolve();
  }

  const rand = () => pool[Math.floor(Math.random() * pool.length)];
  const layers = Array.from({ length: GHOSTS }, (_, i) => {
    const el = document.createElement('span');
    el.textContent = rand();
    host.appendChild(el);
    return { el, ang: (i / GHOSTS) * Math.PI * 2, next: 0 };
  });

  return new Promise((resolve) => {
    const start = performance.now();
    let landed = false;

    // requestAnimationFrame não roda com a aba em segundo plano. Sem esta
    // rede, quem trocasse de aba no instante do sorteio voltaria para uma
    // nuvem de nomes congelada e nunca veria o resultado. O timer continua
    // (afunilado, mas continua) e força o desfecho.
    const finish = () => {
      if (landed) return;
      landed = true;
      clearTimeout(guard);
      done();
      resolve();
    };
    const guard = setTimeout(finish, COLLAPSE_MS + 600);

    const step = (now) => {
      if (landed) return;
      const p = Math.min(1, (now - start) / COLLAPSE_MS);
      const e = p * p;                       // decoerência acelera no fim
      const spread = (1 - e) * 38;
      const alive = Math.max(1, Math.round(GHOSTS - (GHOSTS - 1) * e));
      const settled = p > 0.84;              // o resultado já assumiu a tela

      for (let i = 0; i < layers.length; i++) {
        const L = layers[i];
        if (i >= alive) { L.el.style.display = 'none'; continue; }
        const a = L.ang + (now - start) / 1000 * (1.5 + i * 0.22);
        L.el.style.transform =
          `translate(${Math.cos(a) * spread}px, ${Math.sin(a) * spread * 0.44}px)`;
        L.el.style.opacity = String(i === 0 ? 0.5 + 0.5 * e : (1 - e) * 0.45);
        L.el.style.filter = `blur(${(1 - e) * (i === 0 ? 2 : 3.6)}px)`;
        if (i === 0 && settled) {
          if (L.el.textContent !== measured && measured) L.el.textContent = measured;
        } else if (now >= L.next) {
          L.el.textContent = rand();
          L.next = now + 45 + e * e * 380 + i * 14;
        }
      }

      if (p >= 1) { finish(); return; }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

function paintResult(box, draw) {
  const c = draw.commitment;
  const r = draw.result;
  const p = draw.proof ?? {};
  const isLottery = draw.kind === 'lottery';
  const spec = isLottery && lotteries ? lotteries[draw.lottery.lottery] : null;

  const resultBlock = isLottery
    ? `
      <h3 style="margin-top:26px;font-size:1.05rem">
        ${esc(t('lot.gamesH'))}
        <span class="badge" style="margin-inline-start:8px">${esc(LOTTERY_NAMES[draw.lottery.lottery] ?? draw.lottery.lottery)}</span>
      </h3>
      <div class="games">${r.games.map((g, i) => gameHtml(g, spec, i)).join('')}</div>
      ${draw.lottery.lottery === 'timemania'
        ? `<p class="field-hint">${esc(t('lot.team'))}</p>` : ''}
      <button class="btn btn-ghost btn-sm" type="button"
              data-copy="${esc(gamesAsText(r.games, spec))}">${esc(t('lot.copyAll'))}</button>`
    : `
      <h3 style="margin-top:26px;font-size:1.05rem">${esc(t('draw.winnersH'))}</h3>
      <div class="podium">
        ${r.winners.map((w, i) => `
          <div class="winner" style="--d:${i * 90}ms;animation-delay:var(--d)">
            <span class="pos">${i + 1}</span><span class="nm">${esc(w)}</span>
          </div>`).join('')}
      </div>

      <details class="order">
        <summary>${esc(t('draw.orderH'))}</summary>
        <ol>${r.order.map((n) => `<li>${esc(n)}</li>`).join('')}</ol>
      </details>`;

  box.innerHTML = `
    <div class="card">
      <h2 class="center" style="font-size:1.5rem">${esc(drawTitle(draw))}</h2>
      <p class="center" style="color:var(--text-dim);font-size:.9rem">
        ${fmtNum(draw.participant_count)} ${esc(t(isLottery ? 'lot.gamesN' : 'draw.entries'))} · ${esc(fmtDate(r.drawn_at))}
      </p>

      ${resultBlock}

      <h3 style="margin-top:26px;font-size:1.05rem">${esc(t('draw.proofH'))}</h3>
      <div>
        ${hashRow('proof.commit', c.commit_hash)}
        ${hashRow(isLottery ? 'proof.config' : 'proof.plist', c.participants_hash)}
        ${hashRow('proof.root', c.merkle_root)}
        ${hashRow('proof.pulse', p.pulse_value)}
        ${hashRow('proof.idx', String(c.pulse_index))}
        ${hashRow('proof.round', String(c.drand_round))}
        ${hashRow('proof.sig', p.drand_signature)}
        ${hashRow('proof.seed', p.seed)}
      </div>

      <div class="cta-row" style="margin-top:26px;justify-content:flex-start">
        <a class="btn btn-primary" href="/verificar?s=${esc(draw.slug)}" data-nav>${esc(t('draw.verify'))}</a>
        <a class="btn btn-ghost" href="/api/draws/${esc(draw.slug)}/proof" target="_blank" rel="noopener">${esc(t('draw.download'))}</a>
        <button class="btn btn-ghost" type="button" data-copy="${esc(location.origin)}/s/${esc(draw.slug)}">${esc(t('draw.share'))}</button>
      </div>
    </div>`;
}

// ------------------------------------------------------------ verificador

function initVerify() {
  const run = document.getElementById('v-run');
  const input = document.getElementById('v-input');
  if (!run) return;

  run.addEventListener('click', async () => {
    const slug = parseSlug(input.value);
    const stepsBox = document.getElementById('v-steps');
    const verdict = document.getElementById('v-verdict');
    verdict.innerHTML = '';

    if (!slug) {
      verdict.innerHTML = `<div class="alert alert-error">${esc(t('err.notfound'))}</div>`;
      return;
    }

    stepsBox.innerHTML = STEP_KEYS.map((k, i) => `
      <div class="vstep" id="vs-${i}">
        <span class="mark">${i + 1}</span>
        <span class="txt">${esc(t(k))}<small></small></span>
      </div>`).join('');

    run.disabled = true;
    run.innerHTML = `<span class="spinner"></span><span>${esc(t('verify.running'))}</span>`;

    const onStep = (i, status, detail) => {
      const el = document.getElementById(`vs-${i}`);
      if (!el) return;
      el.classList.remove('busy', 'ok', 'bad');
      el.classList.add(status);
      const mark = el.querySelector('.mark');
      if (status === 'ok') mark.textContent = '✓';
      else if (status === 'bad') mark.textContent = '✕';
      else mark.textContent = '◜';
      // detail e uma string (hash cru) ou {key, vars} para traduzir.
      const text = detail && typeof detail === 'object' ? t(detail.key, detail.vars) : detail;
      if (text) el.querySelector('small').textContent = text;
    };

    let result;
    try {
      // Os rotulos so podem ser ajustados depois de saber o tipo, que vem
      // junto com a prova baixada no passo 1.
      const onKind = (kind) => {
        if (kind !== 'lottery') return;
        for (const [i, key] of [[1, 'verify.s2lot'], [5, 'verify.s6lot']]) {
          const txt = document.querySelector(`#vs-${i} .txt`);
          if (txt?.firstChild) txt.firstChild.textContent = t(key);
        }
      };
      result = await verifyDraw(slug, onStep, '', onKind);
    } catch (err) {
      result = { ok: false, detail: err.message };
    }

    verdict.innerHTML = result.ok
      ? `<div class="verdict pass"><h3>✓ ${esc(t('verify.pass'))}</h3><p>${esc(t('verify.passSub'))}</p></div>`
      : `<div class="verdict fail"><h3>✕ ${esc(t('verify.fail'))}</h3><p>${esc(t('verify.failSub'))}</p></div>`;

    run.disabled = false;
    run.innerHTML = `<span>${esc(t('verify.run'))}</span>`;
  });
}

// ------------------------------------------------------------------ rotas

function navigate(path) {
  history.pushState({}, '', path);
  render();
}

document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-nav]');
  if (!a) return;
  const url = new URL(a.href, location.origin);
  if (url.origin !== location.origin) return;
  // Âncoras da própria home continuam com o comportamento nativo de rolagem.
  if (url.pathname === location.pathname && url.hash) return;
  e.preventDefault();
  navigate(url.pathname + url.search + url.hash);
});

window.addEventListener('popstate', render);

/**
 * Páginas de sorteio saem do índice de busca. São conteúdo de usuário —
 * milhares de URLs com o mesmo layout e nomes de terceiros — e indexá-las
 * diluiria o domínio e jogaria listas de participantes na busca. O robots.txt
 * já bloqueia /s/, mas a meta cobre o caso de a URL ser descoberta por link.
 */
function setRobots(noindex) {
  let tag = document.querySelector('meta[name="robots"]');
  if (!noindex) { tag?.remove(); return; }
  if (!tag) {
    tag = document.createElement('meta');
    tag.name = 'robots';
    document.head.appendChild(tag);
  }
  tag.content = 'noindex, follow';
}

function render() {
  const path = location.pathname;
  const home = document.getElementById('view-home');
  const draw = document.getElementById('view-draw');
  const verify = document.getElementById('view-verify');
  for (const v of [home, draw, verify]) v.classList.add('hide');
  stopDrawTimer();

  const drawMatch = path.match(/^\/s\/([0-9a-z]{4,32})$/i);
  setRobots(Boolean(drawMatch));

  if (drawMatch) {
    draw.classList.remove('hide');
    renderDraw(drawMatch[1].toLowerCase());
    return;
  }

  // Só /verificar: é o caminho que existe como arquivo no servidor. Um alias
  // que só funcionasse na navegação interna daria 404 se alguém colasse a URL.
  if (path === '/verificar') {
    verify.classList.remove('hide');
    const s = new URLSearchParams(location.search).get('s');
    if (s) {
      document.getElementById('v-input').value = s;
      document.getElementById('v-run').click();
    }
    return;
  }

  home.classList.remove('hide');
  resetSubmit();
  loadStats();
  loadPoolNote();
  loadRecent();
  if (location.hash) {
    document.querySelector(location.hash)?.scrollIntoView({ behavior: 'smooth' });
  }
}

// --------------------------------------------------------- fundo animado

/**
 * O experimento de dupla fenda rodando no fundo da página.
 *
 * Uma onda plana chega à barreira, as duas fendas viram fontes secundárias de
 * Huygens e cada ponto que acende no anteparo é uma detecção individual. O
 * ponto não cai em lugar uniforme: a posição é sorteada **pela própria
 * intensidade de interferência**, então as franjas se acumulam sozinhas a
 * partir de impactos que, um a um, parecem aleatórios.
 *
 * É a figura exata de onde vem a entropia do site — vale mais desenhá-la certa
 * do que desenhar ondas bonitas em posição arbitrária.
 */
function initField() {
  const canvas = document.getElementById('field');
  const ctx = canvas.getContext('2d', { alpha: true });
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const BINS = 200;     // resolução do acúmulo no anteparo
  const FRINGES = 9;    // franjas visíveis na largura da tela
  const BAND = 62;      // altura máxima do histograma, em px
  const LIFE = 1.6;     // duração do brilho de cada detecção, em s

  let w = 0, h = 0, raf = 0, lastW = -1;
  let yBar = 0, yScr = 0, sx1 = 0, sx2 = 0, lambda = 1, slitW = 1;
  const hist = new Float32Array(BINS);
  const shots = [];

  /**
   * Geometria do experimento para uma viewport w x h.
   *
   * Os dois parâmetros ópticos são **derivados**, não escolhidos no olho:
   *
   *   espaçamento de franja = λL/d  →  quero w/FRINGES  →  λ = (w/FRINGES)·d/L
   *   1ª anulação da envoltória em sinθ = λ/a  →  quero na borda da tela  →
   *   a = λ / sinθ_borda,  com  sinθ_borda = (w/2)/hypot(w/2, L)
   *
   * O seno tem de ser o exato. Usando a aproximação paraxial (x/L) a fenda sai
   * quase metade do que devia: numa tela larga a borda está a 40° do eixo, e a
   * envoltória ainda valia 39% do pico lá — o padrão ficava tão claro nas
   * bordas quanto no centro, o oposto da figura.
   *
   * Quantas franjas cabem sob a envoltória é consequência, não escolha: dá
   * 2·L·FRINGES/(2·hypot(w/2,L)), que tende a FRINGES só no campo distante.
   * Numa viewport típica dá ~5 franjas bem marcadas, com as bordas apagadas.
   *
   * Função pura de propósito: dá para conferir o padrão fora do navegador.
   */
  function slitGeometry(vw, vh) {
    const top = vh * 0.15;
    const L = vh * 0.50;
    const gap = Math.min(vw * 0.045, 58);   // meia separação entre as fendas
    const lam = (vw / FRINGES) * (gap * 2) / L;
    const sinEdge = (vw / 2) / Math.hypot(vw / 2, L);
    return {
      yBar: top, yScr: top + L,
      sx1: vw / 2 - gap, sx2: vw / 2 + gap,
      lambda: lam, slitW: lam / sinEdge,
    };
  }

  /**
   * Intensidade no ponto x do anteparo: interferência das duas fendas dentro
   * da envoltória de difração de uma fenda só. O comprimento de onda é
   * escolhido em `resize` para dar FRINGES franjas na largura disponível — é
   * um enquadramento, não um valor físico.
   */
  function intensity(x) {
    const L = yScr - yBar;
    const delta = Math.hypot(x - sx2, L) - Math.hypot(x - sx1, L);
    const interf = Math.cos(Math.PI * delta / lambda) ** 2;
    const cx = (sx1 + sx2) / 2;
    const sinTheta = (x - cx) / Math.hypot(x - cx, L);
    const b = Math.PI * slitW * sinTheta / lambda;
    const env = Math.abs(b) < 1e-6 ? 1 : (Math.sin(b) / b) ** 2;
    return interf * env;
  }

  /**
   * Amostragem por rejeição: x sai distribuído como |ψ|².
   *
   * A taxa de aceitação é a intensidade média, ~18%, então 16 tentativas
   * falhavam em 7% dos casos — e o desfecho antigo (cair no uniforme) jogava
   * justamente esses 7% nas franjas escuras, borrando o padrão. Com 64 o
   * escape cai para ~3e-5, e mesmo ele vai para o máximo central em vez de
   * espalhar luz onde deveria haver zero.
   */
  function sampleImpact() {
    for (let i = 0; i < 64; i++) {
      const x = Math.random() * w;
      if (Math.random() < intensity(x)) return x;
    }
    return (sx1 + sx2) / 2;
  }

  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    // O CSS já estica o canvas (position:fixed; inset:0); aqui só lemos o
    // tamanho resultante e ajustamos o buffer para a densidade da tela.
    w = canvas.clientWidth || innerWidth;
    h = canvas.clientHeight || innerHeight;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ({ yBar, yScr, sx1, sx2, lambda, slitW } = slitGeometry(w, h));

    // Os bins são fatias da largura: só uma mudança de largura os invalida.
    // Zerar em toda mudança de altura apagaria o padrão a cada vez que a
    // barra de endereço do celular aparece ou some.
    if (w !== lastW) { hist.fill(0); lastW = w; }
    // Sem animação não há acúmulo para assistir; o quadro único já mostra o
    // padrão fechado em vez de um anteparo vazio.
    if (reduce) {
      for (let b = 0; b < BINS; b++) hist[b] = intensity((b + 0.5) * w / BINS) * 100;
    }
  }

  function frame(now) {
    ctx.clearRect(0, 0, w, h);
    const t = now / 1000;
    ctx.lineWidth = 1;

    // --- onda plana descendo até a barreira
    for (let i = 0; i < 7; i++) {
      const y = (t * 26 + i * yBar / 7) % yBar;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.strokeStyle = `rgba(112,132,255,${0.11 * (y / yBar)})`;
      ctx.stroke();
    }

    // --- barreira com as duas fendas
    //     Segmento centrado, não régua de ponta a ponta: atravessando a tela
    //     inteira a linha lia como borda do cabeçalho, não como aparato.
    const half = slitW / 2;
    const bar0 = w / 2 - w * 0.28, bar1 = w / 2 + w * 0.28;
    ctx.strokeStyle = 'rgba(160,170,220,.22)';
    ctx.lineWidth = 1.6;
    for (const [x0, x1] of [[bar0, sx1 - half], [sx1 + half, sx2 - half], [sx2 + half, bar1]]) {
      ctx.beginPath();
      ctx.moveTo(x0, yBar);
      ctx.lineTo(x1, yBar);
      ctx.stroke();
    }
    ctx.lineWidth = 1;

    // --- fontes secundárias, recortadas ao semiplano de saída: a onda só
    //     existe depois da barreira, e o recorte é o que faz a figura ler
    //     como difração em vez de dois alvos concêntricos soltos na tela.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, yBar, w, h - yBar);
    ctx.clip();
    for (const sx of [sx1, sx2]) {
      for (let i = 0; i < 13; i++) {
        const phase = (t * 0.34 + i / 13) % 1;
        ctx.beginPath();
        ctx.arc(sx, yBar, phase * Math.max(w, h) * 0.62, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(112,132,255,${(1 - phase) * 0.16})`;
        ctx.stroke();
      }
    }
    ctx.restore();

    // --- anteparo e franjas acumuladas
    ctx.beginPath();
    ctx.moveTo(w / 2 - w * 0.34, yScr);
    ctx.lineTo(w / 2 + w * 0.34, yScr);
    ctx.strokeStyle = 'rgba(53,230,212,.16)';
    ctx.stroke();

    let peak = 1;
    for (let b = 0; b < BINS; b++) if (hist[b] > peak) peak = hist[b];
    const bw = w / BINS;
    for (let b = 0; b < BINS; b++) {
      const v = hist[b] / peak;
      if (v < 0.02) continue;
      ctx.fillStyle = `rgba(139,108,246,${0.06 + v * 0.30})`;
      ctx.fillRect(b * bw, yScr - v * BAND, bw + 0.7, v * BAND);
    }

    // --- detecções individuais
    if (!reduce) {
      if (Math.random() < 0.5 && shots.length < 48) {
        const x = sampleImpact();
        hist[Math.min(BINS - 1, Math.floor(x / w * BINS))] += 1;
        shots.push({ x, born: t });
      }
      // Decaimento lento: o histograma chega a um regime estacionário em vez
      // de saturar numa faixa chapada depois de alguns minutos abertos.
      for (let b = 0; b < BINS; b++) hist[b] *= 0.9993;
    }

    for (let i = shots.length - 1; i >= 0; i--) {
      const s = shots[i];
      const age = t - s.born;
      if (age > LIFE) { shots.splice(i, 1); continue; }
      const a = 1 - age / LIFE;
      ctx.beginPath();
      ctx.arc(s.x, yScr, 1.7, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(53,230,212,${a * 0.9})`;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(s.x, yScr, 1.7 + (1 - a) * 14, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(53,230,212,${a * 0.22})`;
      ctx.stroke();
    }

    // Quem pediu menos movimento recebe um quadro só. Antes o reagendamento
    // era incondicional: `frame(0)` desenhava o estático e já marcava o
    // próximo, e a animação rodava inteira mesmo com a preferência ligada.
    if (!reduce) raf = requestAnimationFrame(frame);
  }

  addEventListener('resize', () => {
    resize();
    if (reduce) frame(0);
  }, { passive: true });

  resize();
  if (reduce) frame(0);
  else raf = requestAnimationFrame(frame);

  // Poupa bateria quando a aba está em segundo plano.
  document.addEventListener('visibilitychange', () => {
    if (reduce) return;
    if (document.hidden) cancelAnimationFrame(raf);
    else raf = requestAnimationFrame(frame);
  });
}

// ------------------------------------------------------------------ boot

buildLangMenu();
applyI18n();
initForm();
initVerify();
initField();
render();

// As páginas de conteúdo (/pt/mega-sena) mandam o visitante para cá já
// pedindo uma modalidade. Sem isto o link cairia no modo lista e a pessoa
// teria de reencontrar o jogo sozinha.
const wantedLottery = new URLSearchParams(location.search).get('lottery');
if (wantedLottery) {
  setMode('lottery');
  loadLotteries().then(() => {
    const sel = document.getElementById('f-lottery');
    if (sel && lotteries?.[wantedLottery]) {
      sel.value = wantedLottery;
      applyLotterySpec();
    }
  });
}
