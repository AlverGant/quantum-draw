/**
 * Protocolo qdraw-v1 — porte fiel de ../../quantum/protocol.py e pool.py.
 *
 * Toda função aqui precisa produzir exatamente os mesmos bytes que a versão
 * Python. O arquivo ../test/vectors.json é gerado pelo Python e verificado
 * por ../test/protocol.test.mjs contra este módulo; se algo divergir, o teste
 * quebra antes do deploy.
 *
 * Este mesmo arquivo é reaproveitado pelo verificador do browser
 * (../../web/verify.js), para que o visitante rode literalmente o mesmo
 * código que o servidor rodou.
 */

const LEAF_TAG = new Uint8Array([0x00]);
const NODE_TAG = new Uint8Array([0x01]);

const enc = new TextEncoder();

export const PULSE_BYTES = 32;
export const PROTOCOL = 'qdraw-v1';

// ------------------------------------------------------------------ bytes

export function utf8(s: string): Uint8Array {
  return enc.encode(s);
}

export function u32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, false);
  return b;
}

export function toHex(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

export function fromHex(h: string): Uint8Array {
  const clean = h.trim().toLowerCase();
  if (clean.length % 2 !== 0 || /[^0-9a-f]/.test(clean)) {
    throw new Error(`hex inválido: ${h.slice(0, 32)}`);
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}

export function concat(...chunks: Uint8Array[]): Uint8Array {
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

export async function sha256(...chunks: Uint8Array[]): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', concat(...chunks));
  return new Uint8Array(digest);
}

/** Comparação em tempo constante — usada nos tokens de admin e de gestão. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ----------------------------------------------------------------- merkle

export async function merkleLeaf(index: number, pulse: Uint8Array): Promise<Uint8Array> {
  if (pulse.length !== PULSE_BYTES) {
    throw new Error(`pulso deve ter ${PULSE_BYTES} bytes, tem ${pulse.length}`);
  }
  return sha256(LEAF_TAG, u32(index), pulse);
}

async function levels(leaves: Uint8Array[]): Promise<Uint8Array[][]> {
  if (leaves.length === 0) throw new Error('árvore vazia');
  const all: Uint8Array[][] = [leaves];
  let cur = leaves;
  while (cur.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < cur.length; i += 2) {
      // Nó ímpar sobe promovido, sem duplicação (duplicar cria ambiguidade
      // entre árvores distintas — o bug clássico do Merkle do Bitcoin).
      next.push(i + 1 < cur.length ? await sha256(NODE_TAG, cur[i], cur[i + 1]) : cur[i]);
    }
    all.push(next);
    cur = next;
  }
  return all;
}

export async function merkleRoot(pulses: Uint8Array[]): Promise<Uint8Array> {
  const leaves = await Promise.all(pulses.map((p, i) => merkleLeaf(i, p)));
  const ls = await levels(leaves);
  return ls[ls.length - 1][0];
}

export interface ProofStep {
  hash: string;
  left: boolean;
}

export async function merkleProof(pulses: Uint8Array[], index: number): Promise<ProofStep[]> {
  if (index < 0 || index >= pulses.length) {
    throw new Error(`índice ${index} fora do pool de ${pulses.length} pulsos`);
  }
  const leaves = await Promise.all(pulses.map((p, i) => merkleLeaf(i, p)));
  const ls = await levels(leaves);
  const proof: ProofStep[] = [];
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

export async function verifyProof(
  index: number,
  pulse: Uint8Array,
  proof: ProofStep[],
  root: Uint8Array,
): Promise<boolean> {
  let h = await merkleLeaf(index, pulse);
  for (const step of proof) {
    const sib = fromHex(step.hash);
    h = step.left ? await sha256(NODE_TAG, sib, h) : await sha256(NODE_TAG, h, sib);
  }
  return toHex(h) === toHex(root);
}

// ------------------------------------------------------------ compromisso

// Espelha _WS em quantum/protocol.py. Não troque por \s: os conjuntos de
// espaço em branco de JS e Python diferem (﻿ só no JS, \x1c-\x1f e \x85
// só no Python), e a divergência faria o mesmo nome hashear diferente aqui e
// no verificador.
const WS = /[\t\n\v\f\r \u001c\u001d\u001e\u001f\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+/g;

export function normalizeParticipants(raw: string[]): string[] {
  const out: string[] = [];
  for (const item of raw) {
    const s = String(item).normalize('NFC').replace(WS, ' ').trim();
    if (s) out.push(s);
  }
  return out;
}

export async function participantsHash(participants: string[]): Promise<Uint8Array> {
  if (participants.length === 0) throw new Error('lista de participantes vazia');
  return sha256(utf8('qdraw/v1/participants\n'), utf8(participants.join('\n') + '\n'));
}

export interface CommitInput {
  title: string;
  participants: string[];
  winnersCount: number;
  clientNonce: string;
  poolId: string;
  pulseIndex: number;
  drandRound: number;
}

export async function commitHash(input: CommitInput): Promise<Uint8Array> {
  const ph = await participantsHash(input.participants);
  const body =
    [
      'qdraw/v1/commit',
      input.title.normalize('NFC'),
      String(Math.trunc(input.winnersCount)),
      String(input.participants.length),
      toHex(ph),
      input.clientNonce,
      input.poolId,
      String(Math.trunc(input.pulseIndex)),
      String(Math.trunc(input.drandRound)),
    ].join('\n') + '\n';
  return sha256(utf8(body));
}

// ---------------------------------------------------------------- semente

/** No quicknet a aleatoriedade do round é SHA-256 da assinatura BLS. */
export async function drandRandomness(signatureHex: string): Promise<Uint8Array> {
  return sha256(fromHex(signatureHex));
}

export async function deriveSeed(
  commit: Uint8Array,
  pulse: Uint8Array,
  randomness: Uint8Array,
): Promise<Uint8Array> {
  return sha256(utf8('qdraw/v1/seed'), commit, pulse, randomness);
}

// ------------------------------------------------------------------- DRBG

/**
 * Counter mode sobre SHA-256: bloco(i) = H("qdraw/v1/drbg" || seed || i).
 * Simples de propósito — qualquer pessoa consegue reimplementar em 20 linhas
 * na linguagem que preferir para conferir o sorteio.
 */
export class Drbg {
  private counter = 0;
  // Anotado sem parâmetro de tipo de propósito: inferido de `new Uint8Array(0)`
  // o campo viraria Uint8Array<ArrayBuffer>, incompatível com o
  // Uint8Array<ArrayBufferLike> que o crypto.subtle devolve.
  private buf: Uint8Array = new Uint8Array(0);
  private pos = 0;
  private readonly seed: Uint8Array;

  // Campo explícito em vez de parameter property: o type-stripping do Node
  // (usado pelos testes) só apaga tipos, não gera as atribuições implícitas.
  constructor(seed: Uint8Array) {
    this.seed = seed;
  }

  private async refill(): Promise<void> {
    this.buf = await sha256(utf8('qdraw/v1/drbg'), this.seed, u32(this.counter));
    this.counter += 1;
    this.pos = 0;
  }

  async nextU32(): Promise<number> {
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
  async below(n: number): Promise<number> {
    if (n <= 0) throw new Error('n deve ser positivo');
    if (n === 1) return 0;
    const limit = Math.floor(0x100000000 / n) * n;
    for (;;) {
      const x = await this.nextU32();
      if (x < limit) return x % n;
    }
  }
}

export async function shuffle(items: string[], seed: Uint8Array): Promise<string[]> {
  const arr = items.slice();
  const rng = new Drbg(seed);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = await rng.below(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export interface DrawResult {
  seed: string;
  order: string[];
  winners: string[];
}

export async function runDraw(
  participants: string[],
  winnersCount: number,
  commit: Uint8Array,
  pulse: Uint8Array,
  randomness: Uint8Array,
): Promise<DrawResult> {
  const seed = await deriveSeed(commit, pulse, randomness);
  const order = await shuffle(participants, seed);
  return { seed: toHex(seed), order, winners: order.slice(0, winnersCount) };
}
