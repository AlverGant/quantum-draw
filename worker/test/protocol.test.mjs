/**
 * Paridade entre linguagens: confere o protocol.ts contra os vetores gerados
 * pelo Python (quantum/selftest.py --emit).
 *
 *   npm test
 *
 * Se algum destes falhar, o verificador independente do browser vai discordar
 * do servidor e toda a premissa do projeto cai — então isto roda antes de
 * qualquer deploy.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import * as P from '../src/protocol.ts';

const here = dirname(fileURLToPath(import.meta.url));
const V = JSON.parse(readFileSync(join(here, 'vectors.json'), 'utf8'));

test('sha256 bate com o Python', async () => {
  assert.equal(P.toHex(await P.sha256(new Uint8Array(0))), V.sha256_empty);
});

test('hex round-trip', () => {
  const bytes = new Uint8Array([0, 1, 15, 16, 254, 255]);
  assert.equal(P.toHex(bytes), '00010f10feff');
  assert.deepEqual(P.fromHex('00010F10FEFF'), bytes);
  assert.throws(() => P.fromHex('xyz'), /hex inválido/);
  assert.throws(() => P.fromHex('abc'), /hex inválido/);
});

test('u32 é big-endian', () => {
  assert.deepEqual(P.u32(1), new Uint8Array([0, 0, 0, 1]));
  assert.deepEqual(P.u32(0x01020304), new Uint8Array([1, 2, 3, 4]));
});

test('raiz de Merkle bate com o Python (árvore ímpar)', async () => {
  const pulses = V.merkle.pulses.map(P.fromHex);
  assert.equal(P.toHex(await P.merkleRoot(pulses)), V.merkle.root);
});

test('prova de Merkle bate com o Python', async () => {
  const pulses = V.merkle.pulses.map(P.fromHex);
  const proof = await P.merkleProof(pulses, V.merkle.index);
  assert.deepEqual(proof, V.merkle.proof);
});

test('prova de Merkle valida e rejeita adulteração', async () => {
  const pulses = V.merkle.pulses.map(P.fromHex);
  const root = P.fromHex(V.merkle.root);
  const idx = V.merkle.index;
  const proof = await P.merkleProof(pulses, idx);

  assert.equal(await P.verifyProof(idx, pulses[idx], proof, root), true);
  // Pulso trocado.
  assert.equal(await P.verifyProof(idx, new Uint8Array(32), proof, root), false);
  // Mesmo pulso, posição diferente: o índice entra na folha justamente para isto.
  assert.equal(await P.verifyProof(idx + 1, pulses[idx], proof, root), false);
  // Um passo da prova corrompido.
  const tampered = proof.map((s, i) => (i === 0 ? { ...s, hash: 'ff'.repeat(32) } : s));
  assert.equal(await P.verifyProof(idx, pulses[idx], tampered, root), false);
});

test('provas de Merkle fecham em todos os tamanhos de árvore', async () => {
  for (const n of [1, 2, 3, 5, 8, 9, 17]) {
    const pulses = [];
    for (let i = 0; i < n; i++) {
      pulses.push(await P.sha256(P.utf8('qdraw/test/pulse'), P.u32(i)));
    }
    const root = await P.merkleRoot(pulses);
    for (let i = 0; i < n; i++) {
      const proof = await P.merkleProof(pulses, i);
      assert.equal(await P.verifyProof(i, pulses[i], proof, root), true, `n=${n} i=${i}`);
    }
  }
});

test('normalização bate com o Python', () => {
  assert.deepEqual(P.normalizeParticipants(V.normalization.input), V.normalization.output);
});

test('normalização colapsa espaços exóticos igual ao Python', () => {
  //   (NBSP), 　 (ideográfico) e ﻿ (BOM) precisam sumir dos dois lados.
  assert.deepEqual(P.normalizeParticipants(['a 　b', '﻿', ' c ']), ['a b', 'c']);
  // NFC: é composto e é decomposto têm que virar a mesma string.
  const composed = P.normalizeParticipants(['José']);
  const decomposed = P.normalizeParticipants(['José']);
  assert.deepEqual(composed, decomposed);
});

test('hash dos participantes bate com o Python', async () => {
  assert.equal(P.toHex(await P.participantsHash(V.participants)), V.participants_hash);
});

test('compromisso bate com o Python', async () => {
  const c = V.commit;
  const hash = await P.commitHash({
    title: c.title,
    participants: V.participants,
    winnersCount: c.winners_count,
    clientNonce: c.client_nonce,
    poolId: c.pool_id,
    pulseIndex: c.pulse_index,
    drandRound: c.drand_round,
  });
  assert.equal(P.toHex(hash), c.hash);
});

test('compromisso muda se qualquer campo mudar', async () => {
  const c = V.commit;
  const base = {
    title: c.title,
    participants: V.participants,
    winnersCount: c.winners_count,
    clientNonce: c.client_nonce,
    poolId: c.pool_id,
    pulseIndex: c.pulse_index,
    drandRound: c.drand_round,
  };
  const mutations = [
    { title: 'outro' },
    { winnersCount: c.winners_count + 1 },
    { clientNonce: 'ff'.repeat(16) },
    { poolId: 'outro-pool' },
    { pulseIndex: c.pulse_index + 1 },
    { drandRound: c.drand_round + 1 },
    { participants: [...V.participants, 'Intruso'] },
  ];
  for (const m of mutations) {
    const hash = P.toHex(await P.commitHash({ ...base, ...m }));
    assert.notEqual(hash, c.hash, `commit ignorou ${Object.keys(m)[0]}`);
  }
});

test('aleatoriedade do drand é SHA-256 da assinatura', async () => {
  assert.equal(P.toHex(await P.drandRandomness(V.drand.signature)), V.drand.randomness);
});

test('DRBG produz as mesmas palavras que o Python', async () => {
  const drbg = new P.Drbg(P.fromHex(V.drbg.seed));
  for (const expected of V.drbg.first_u32) {
    assert.equal(await drbg.nextU32(), expected);
  }
});

test('DRBG.below concorda com o Python', async () => {
  const drbg = new P.Drbg(P.fromHex(V.drbg.seed));
  assert.equal(await drbg.below(60), V.drbg.below_60);
});

test('DRBG.below(1) é sempre 0 e não consome entropia', async () => {
  const drbg = new P.Drbg(P.fromHex(V.drbg.seed));
  assert.equal(await drbg.below(1), 0);
  assert.equal(await drbg.nextU32(), V.drbg.first_u32[0]);
});

test('sorteio completo bate com o Python', async () => {
  const result = await P.runDraw(
    V.participants,
    V.commit.winners_count,
    P.fromHex(V.commit.hash),
    P.fromHex(V.draw.pulse),
    P.fromHex(V.drand.randomness),
  );
  assert.equal(result.seed, V.draw.seed);
  assert.deepEqual(result.order, V.draw.order);
  assert.deepEqual(result.winners, V.draw.winners);
});

test('embaralhamento é permutação e é determinístico', async () => {
  const items = Array.from({ length: 150 }, (_, i) => `p${i}`);
  const seed = await P.sha256(P.utf8('permutacao'));
  const a = await P.shuffle(items, seed);
  const b = await P.shuffle(items, seed);
  assert.deepEqual(a, b);
  assert.deepEqual([...a].sort(), [...items].sort());
  assert.notDeepEqual(a, items);
});

test('mudar um único bit da semente muda os vencedores', async () => {
  const pulse = P.fromHex(V.draw.pulse);
  const flipped = new Uint8Array(pulse);
  flipped[0] ^= 0x01;
  const original = await P.runDraw(
    V.participants, 3, P.fromHex(V.commit.hash), pulse, P.fromHex(V.drand.randomness));
  const altered = await P.runDraw(
    V.participants, 3, P.fromHex(V.commit.hash), flipped, P.fromHex(V.drand.randomness));
  assert.notDeepEqual(altered.order, original.order);
});

test('timingSafeEqual', () => {
  assert.equal(P.timingSafeEqual('abc', 'abc'), true);
  assert.equal(P.timingSafeEqual('abc', 'abd'), false);
  assert.equal(P.timingSafeEqual('abc', 'abcd'), false);
  assert.equal(P.timingSafeEqual('', ''), true);
});
