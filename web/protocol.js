/* GERADO por: npm run build:protocol — a fonte e worker/src/browser.ts. Nao editar. */

// src/protocol.ts
var LEAF_TAG = new Uint8Array([0]);
var NODE_TAG = new Uint8Array([1]);
var enc = new TextEncoder();
var PULSE_BYTES = 32;
var PROTOCOL = "qdraw-v1";
function utf8(s) {
  return enc.encode(s);
}
function u32(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, false);
  return b;
}
function toHex(b) {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
function fromHex(h) {
  const clean = h.trim().toLowerCase();
  if (clean.length % 2 !== 0 || /[^0-9a-f]/.test(clean)) {
    throw new Error(`hex inv\xE1lido: ${h.slice(0, 32)}`);
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}
function concat(...chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}
async function sha256(...chunks) {
  const digest = await crypto.subtle.digest("SHA-256", concat(...chunks));
  return new Uint8Array(digest);
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function merkleLeaf(index, pulse) {
  if (pulse.length !== PULSE_BYTES) {
    throw new Error(`pulso deve ter ${PULSE_BYTES} bytes, tem ${pulse.length}`);
  }
  return sha256(LEAF_TAG, u32(index), pulse);
}
async function levels(leaves) {
  if (leaves.length === 0) throw new Error("\xE1rvore vazia");
  const all = [leaves];
  let cur = leaves;
  while (cur.length > 1) {
    const next = [];
    for (let i = 0; i < cur.length; i += 2) {
      next.push(i + 1 < cur.length ? await sha256(NODE_TAG, cur[i], cur[i + 1]) : cur[i]);
    }
    all.push(next);
    cur = next;
  }
  return all;
}
async function merkleRoot(pulses) {
  const leaves = await Promise.all(pulses.map((p, i) => merkleLeaf(i, p)));
  const ls = await levels(leaves);
  return ls[ls.length - 1][0];
}
async function merkleProof(pulses, index) {
  if (index < 0 || index >= pulses.length) {
    throw new Error(`\xEDndice ${index} fora do pool de ${pulses.length} pulsos`);
  }
  const leaves = await Promise.all(pulses.map((p, i) => merkleLeaf(i, p)));
  const ls = await levels(leaves);
  const proof = [];
  let idx = index;
  for (const level of ls.slice(0, -1)) {
    const sibling = idx ^ 1;
    if (sibling < level.length) {
      proof.push({ hash: toHex(level[sibling]), left: sibling < idx });
    }
    idx = Math.floor(idx / 2);
  }
  return proof;
}
async function verifyProof(index, pulse, proof, root) {
  let h = await merkleLeaf(index, pulse);
  for (const step of proof) {
    const sib = fromHex(step.hash);
    h = step.left ? await sha256(NODE_TAG, sib, h) : await sha256(NODE_TAG, h, sib);
  }
  return toHex(h) === toHex(root);
}
var WS = /[\t\n\v\f\r \u001c\u001d\u001e\u001f\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+/g;
function normalizeParticipants(raw) {
  const out = [];
  for (const item of raw) {
    const s = String(item).normalize("NFC").replace(WS, " ").trim();
    if (s) out.push(s);
  }
  return out;
}
async function participantsHash(participants) {
  if (participants.length === 0) throw new Error("lista de participantes vazia");
  return sha256(utf8("qdraw/v1/participants\n"), utf8(participants.join("\n") + "\n"));
}
async function commitHash(input) {
  const ph = await participantsHash(input.participants);
  const body = [
    "qdraw/v1/commit",
    input.title.normalize("NFC"),
    String(Math.trunc(input.winnersCount)),
    String(input.participants.length),
    toHex(ph),
    input.clientNonce,
    input.poolId,
    String(Math.trunc(input.pulseIndex)),
    String(Math.trunc(input.drandRound))
  ].join("\n") + "\n";
  return sha256(utf8(body));
}
async function drandRandomness(signatureHex) {
  return sha256(fromHex(signatureHex));
}
async function deriveSeed(commit, pulse, randomness) {
  return sha256(utf8("qdraw/v1/seed"), commit, pulse, randomness);
}
var Drbg = class {
  counter = 0;
  // Anotado sem parâmetro de tipo de propósito: inferido de `new Uint8Array(0)`
  // o campo viraria Uint8Array<ArrayBuffer>, incompatível com o
  // Uint8Array<ArrayBufferLike> que o crypto.subtle devolve.
  buf = new Uint8Array(0);
  pos = 0;
  seed;
  // Campo explícito em vez de parameter property: o type-stripping do Node
  // (usado pelos testes) só apaga tipos, não gera as atribuições implícitas.
  constructor(seed) {
    this.seed = seed;
  }
  async refill() {
    this.buf = await sha256(utf8("qdraw/v1/drbg"), this.seed, u32(this.counter));
    this.counter += 1;
    this.pos = 0;
  }
  async nextU32() {
    if (this.pos + 4 > this.buf.length) await this.refill();
    const view = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 4);
    this.pos += 4;
    return view.getUint32(0, false);
  }
  /**
   * Uniforme em [0, n) por amostragem com rejeição. O `% n` direto enviesaria
   * para os índices baixos sempre que n não divide 2^32 — pequeno, mas
   * inaceitável num sorteio que se apresenta como verificável.
   */
  async below(n) {
    if (n <= 0) throw new Error("n deve ser positivo");
    if (n === 1) return 0;
    const limit = Math.floor(4294967296 / n) * n;
    for (; ; ) {
      const x = await this.nextU32();
      if (x < limit) return x % n;
    }
  }
};
async function shuffle(items, seed) {
  const arr = items.slice();
  const rng = new Drbg(seed);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = await rng.below(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
async function runDraw(participants, winnersCount, commit, pulse, randomness) {
  const seed = await deriveSeed(commit, pulse, randomness);
  const order = await shuffle(participants, seed);
  return { seed: toHex(seed), order, winners: order.slice(0, winnersCount) };
}

// src/lottery.ts
var LOTTERIES = {
  megasena: { lo: 1, hi: 60, min: 6, max: 20, default: 6 },
  lotofacil: { lo: 1, hi: 25, min: 15, max: 20, default: 15 },
  quina: { lo: 1, hi: 80, min: 5, max: 15, default: 5 },
  lotomania: { lo: 0, hi: 99, min: 50, max: 50, default: 50 },
  duplasena: { lo: 1, hi: 50, min: 6, max: 15, default: 6 },
  timemania: { lo: 1, hi: 80, min: 10, max: 10, default: 10 },
  diadesorte: { lo: 1, hi: 31, min: 7, max: 15, default: 7, extra: "mes" },
  maismilionaria: {
    lo: 1,
    hi: 50,
    min: 6,
    max: 12,
    default: 6,
    extra: "trevos",
    extra_lo: 1,
    extra_hi: 6,
    extra_min: 2,
    extra_max: 6,
    extra_default: 2
  },
  // Sete colunas independentes; em cada uma marca-se de 1 a 3 algarismos.
  supersete: { lo: 0, hi: 9, min: 1, max: 3, default: 1, columns: 7 }
};
var MESES = [
  "Janeiro",
  "Fevereiro",
  "Mar\xE7o",
  "Abril",
  "Maio",
  "Junho",
  "Julho",
  "Agosto",
  "Setembro",
  "Outubro",
  "Novembro",
  "Dezembro"
];
var MAX_GAMES = 100;
async function pickDistinct(rng, count, lo, hi) {
  const total = hi - lo + 1;
  if (count < 1 || count > total) {
    throw new Error(`n\xE3o d\xE1 para tirar ${count} de ${total} n\xFAmeros`);
  }
  const pool = Array.from({ length: total }, (_, i) => lo + i);
  for (let i = 0; i < count; i++) {
    const j = i + await rng.below(total - i);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count).sort((a, b) => a - b);
}
function validate(lotteryId, games, picks, extraPicks) {
  const spec = LOTTERIES[lotteryId];
  if (!spec) throw new Error(`loteria desconhecida: ${lotteryId}`);
  if (!Number.isInteger(games) || games < 1 || games > MAX_GAMES) {
    throw new Error(`quantidade de jogos fora do intervalo 1..${MAX_GAMES}`);
  }
  const p = picks === null || picks === void 0 ? spec.default : Math.trunc(Number(picks));
  if (!Number.isFinite(p) || p < spec.min || p > spec.max) {
    throw new Error(`${lotteryId} aceita de ${spec.min} a ${spec.max} n\xFAmeros, recebi ${p}`);
  }
  let e = 0;
  if (spec.extra === "trevos") {
    e = extraPicks === null || extraPicks === void 0 ? spec.extra_default : Math.trunc(Number(extraPicks));
    if (!Number.isFinite(e) || e < spec.extra_min || e > spec.extra_max) {
      throw new Error(`trevos devem ser de ${spec.extra_min} a ${spec.extra_max}, recebi ${e}`);
    }
  }
  return { spec, picks: p, extraPicks: e };
}
async function generate(lotteryId, games, picks, extraPicks, seed) {
  const { spec, picks: p, extraPicks: e } = validate(lotteryId, games, picks, extraPicks);
  const rng = new Drbg(seed);
  const out = [];
  for (let g = 0; g < games; g++) {
    const game = {};
    if (spec.columns) {
      const columns = [];
      for (let c = 0; c < spec.columns; c++) {
        columns.push(await pickDistinct(rng, p, spec.lo, spec.hi));
      }
      game.columns = columns;
    } else {
      game.numbers = await pickDistinct(rng, p, spec.lo, spec.hi);
    }
    if (spec.extra === "mes") game.mes = MESES[await rng.below(12)];
    else if (spec.extra === "trevos") {
      game.trevos = await pickDistinct(rng, e, spec.extra_lo, spec.extra_hi);
    }
    out.push(game);
  }
  return out;
}
async function lotteryCommitHash(input) {
  const body = [
    "qdraw/v1/lottery-commit",
    input.title.normalize("NFC"),
    input.lotteryId,
    String(Math.trunc(input.games)),
    String(Math.trunc(input.picks)),
    String(Math.trunc(input.extraPicks)),
    input.clientNonce,
    input.poolId,
    String(Math.trunc(input.pulseIndex)),
    String(Math.trunc(input.drandRound))
  ].join("\n") + "\n";
  return sha256(utf8(body));
}
export {
  Drbg,
  LOTTERIES,
  MAX_GAMES,
  MESES,
  PROTOCOL,
  PULSE_BYTES,
  commitHash,
  concat,
  deriveSeed,
  drandRandomness,
  fromHex,
  generate as generateLottery,
  lotteryCommitHash,
  merkleLeaf,
  merkleProof,
  merkleRoot,
  normalizeParticipants,
  participantsHash,
  pickDistinct,
  runDraw,
  sha256,
  shuffle,
  timingSafeEqual,
  toHex,
  u32,
  utf8,
  validate as validateLottery,
  verifyProof
};
