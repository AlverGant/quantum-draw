/**
 * Paridade do harvest: confere que a construção do pool em TypeScript produz
 * exatamente os mesmos bytes que quantum/pool.py.
 *
 * Isto importa mais aqui do que em qualquer outro teste: o pool é gerado uma
 * vez e sela 24 horas de sorteios sob uma raiz de Merkle. Um erro de um bit no
 * von Neumann ou no condicionamento só apareceria quando alguém tentasse
 * verificar um sorteio — e aí já seria tarde.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import * as P from '../src/protocol.ts';
import * as H from '../src/harvest.ts';
import { buildQasm3, samplesToBits } from '../src/ibm.ts';

const here = dirname(fileURLToPath(import.meta.url));
const V = JSON.parse(readFileSync(join(here, 'vectors.json'), 'utf8')).pool_build;

/** Mesmo fluxo determinístico que o selftest.py usa no lugar da QPU. */
async function deterministicBits(nBits) {
  const bytes = new Uint8Array(Math.ceil(nBits / 8));
  let counter = 0;
  for (let off = 0; off < bytes.length; off += 32) {
    const block = await P.sha256(P.utf8('qdraw/test/rawbits'), P.u32(counter++));
    bytes.set(block.subarray(0, Math.min(32, bytes.length - off)), off);
  }
  return bytes;
}

test('o fluxo de bits determinístico bate com o Python', async () => {
  const raw = await deterministicBits(V.raw_bits);
  assert.equal(P.toHex(raw.subarray(0, 32)), V.raw_prefix_hex);
});

test('von Neumann bate com o Python', async () => {
  const raw = await deterministicBits(V.raw_bits);
  const vn = H.vonNeumann(raw, V.raw_bits);
  assert.equal(vn.count, V.von_neumann_bits);
  assert.equal(P.toHex(vn.bits), V.von_neumann_hex);
});

test('von Neumann remove viés de primeira ordem', () => {
  // Moeda viciada em 90% de 1s: 64 mil bits com P(1)=0.9.
  const nBits = 64_000;
  const raw = new Uint8Array(nBits / 8);
  let seed = 12345;
  for (let i = 0; i < nBits; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    if (seed % 100 < 90) raw[i >> 3] |= 0x80 >> (i & 7);
  }
  const vn = H.vonNeumann(raw, nBits);
  let ones = 0;
  for (let i = 0; i < vn.count && i < vn.bits.length * 8; i++) {
    ones += (vn.bits[i >> 3] >> (7 - (i & 7))) & 1;
  }
  const ratio = ones / Math.min(vn.count, vn.bits.length * 8);
  assert.ok(ratio > 0.44 && ratio < 0.56, `viés não removido: ${ratio}`);
});

test('condicionamento bate com o Python', async () => {
  const raw = await deterministicBits(V.raw_bits);
  const vn = H.vonNeumann(raw, V.raw_bits);
  const cond = await H.condition(vn.bits, V.pulse_count * 32);
  assert.equal(P.toHex(cond), V.conditioned_hex);
});

test('condicionamento recusa entropia insuficiente', async () => {
  await assert.rejects(() => H.condition(new Uint8Array(10), 32), /entropia insuficiente/);
});

test('rawBitsNeeded bate com o Python', () => {
  assert.equal(H.rawBitsNeeded(12), V.raw_bits);
});

test('pool completo bate com o Python (pulsos, raiz e id)', async () => {
  const raw = await deterministicBits(V.raw_bits);
  const pool = await H.buildPool(raw, V.raw_bits, V.pulse_count, V.period,
    { provider: 'test' }, V.genesis_time);

  assert.equal(pool.pulses.length, V.pulse_count);
  assert.deepEqual(pool.pulses.map(P.toHex), V.pulses);
  assert.equal(pool.merkleRoot, V.merkle_root);
  assert.equal(pool.poolId, V.pool_id);
});

test('QASM3 gerado tem a forma que a IBM aceitou', () => {
  const qasm = buildQasm3(3);
  assert.match(qasm, /^OPENQASM 3\.0;/);
  assert.ok(qasm.includes('bit[3] meas;'));
  // H decomposto nas portas nativas do Heron (cz, id, rz, sx, x).
  assert.ok(qasm.includes('rz(pi/2) $0;\nsx $0;\nrz(pi/2) $0;'));
  assert.ok(qasm.includes('meas[2] = measure $2;'));
  assert.equal((qasm.match(/measure/g) ?? []).length, 3);
  assert.equal((qasm.match(/\bsx\b/g) ?? []).length, 3);
});

test('samplesToBits desempacota o hex da IBM', () => {
  // 8 qubits: 0xa5 = 10100101
  const { raw, nBits } = samplesToBits(['0xa5'], 8);
  assert.equal(nBits, 8);
  assert.equal(raw[0], 0xa5);
});

test('samplesToBits preenche zeros à esquerda', () => {
  // Se a API omitir zeros, "0x5" em 8 qubits é 00000101 — sem o padding, o
  // fluxo inteiro sairia deslocado a partir daqui.
  const a = samplesToBits(['0x05'], 8);
  const b = samplesToBits(['0x5'], 8);
  assert.deepEqual(Array.from(b.raw), Array.from(a.raw));
  assert.equal(a.raw[0], 0x05);
});

test('samplesToBits concatena várias amostras', () => {
  const { raw, nBits } = samplesToBits(['0xff', '0x00', '0xff'], 8);
  assert.equal(nBits, 24);
  assert.deepEqual(Array.from(raw.subarray(0, 3)), [0xff, 0x00, 0xff]);
});

test('samplesToBits lida com largura que não é múltiplo de 4', () => {
  // 6 qubits ocupam 2 dígitos hex (8 bits); os 2 do topo são descarte.
  const { raw, nBits } = samplesToBits(['0x3f', '0x00'], 6);
  assert.equal(nBits, 12);
  // 111111 000000 -> 11111100 0000....
  assert.equal(raw[0], 0b11111100);
});

test('samplesToBits rejeita hex inválido', () => {
  assert.throws(() => samplesToBits(['0xzz'], 8), /hex inválida/);
});

test('nenhuma parameter property no código-fonte', () => {
  // O type-stripping do Node (que roda estes testes) só apaga tipos; uma
  // parameter property como `constructor(private x: T)` exigiria geração de
  // código e quebra a suíte inteira com ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX.
  // Já aconteceu duas vezes — em Drbg e em IbmClient — daí este guarda.
  const dir = join(here, '..', 'src');
  const offenders = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    // Tira comentários antes de varrer: os próprios avisos sobre esta armadilha
    // contêm o padrão que estamos procurando.
    const src = readFileSync(join(dir, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    for (const m of src.matchAll(/constructor\s*\(([^)]*)\)/gs)) {
      if (/\b(private|public|protected|readonly)\b/.test(m[1])) offenders.push(`${file}: ${m[0]}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('156 qubits produzem 39 dígitos hex, como a IBM devolveu', () => {
  const sample = '0x48f7d1a27e88ef9442fc1f84dd431129962589d';
  assert.equal(sample.slice(2).length, 39);
  const { nBits } = samplesToBits([sample], 156);
  assert.equal(nBits, 156);
});
