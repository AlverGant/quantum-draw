/**
 * Paridade da geração de jogos: o TypeScript tem que produzir exatamente os
 * mesmos números que quantum/lottery.py.
 *
 * Aqui a paridade é visível para o usuário de um jeito que nos outros módulos
 * não é: se divergir, o verificador do browser mostra jogos diferentes dos que
 * o site publicou, e a prova vira lixo na cara de quem apostou.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import * as P from '../src/protocol.ts';
import * as L from '../src/lottery.ts';

const here = dirname(fileURLToPath(import.meta.url));
const V = JSON.parse(readFileSync(join(here, 'vectors.json'), 'utf8')).lottery;

test('o catálogo de loterias bate com o Python', () => {
  assert.deepEqual(Object.keys(L.LOTTERIES).sort(), Object.keys(V.catalog).sort());
  for (const [id, spec] of Object.entries(V.catalog)) {
    assert.deepEqual(L.LOTTERIES[id], spec, `divergência em ${id}`);
  }
});

test('os meses batem com o Python', () => {
  assert.deepEqual(L.MESES, V.meses);
});

test('todas as modalidades geram os mesmos jogos que o Python', async () => {
  const seed = P.fromHex(V.seed);
  for (const [id, c] of Object.entries(V.cases)) {
    const got = await L.generate(id, c.games, c.picks, c.extra_picks, seed);
    assert.deepEqual(got, c.result, `divergência em ${id}`);
  }
});

test('compromisso de loteria bate com o Python', async () => {
  const h = await L.lotteryCommitHash({
    title: 'Bolão do trabalho',
    lotteryId: 'megasena',
    games: 5,
    picks: 6,
    extraPicks: 0,
    clientNonce: '00112233445566778899aabbccddeeff',
    poolId: 'deadbeefcafe0001',
    pulseIndex: 3,
    drandRound: 31237368,
  });
  assert.equal(P.toHex(h), V.commit);
});

test('compromisso de loteria não colide com o de lista', async () => {
  // Separadores de domínio diferentes: mesmo com entradas "equivalentes", os
  // dois compromissos têm que divergir.
  const lot = await L.lotteryCommitHash({
    title: 'x', lotteryId: 'megasena', games: 1, picks: 6, extraPicks: 0,
    clientNonce: 'aa', poolId: 'p', pulseIndex: 1, drandRound: 2,
  });
  const list = await P.commitHash({
    title: 'x', participants: ['megasena'], winnersCount: 1,
    clientNonce: 'aa', poolId: 'p', pulseIndex: 1, drandRound: 2,
  });
  assert.notEqual(P.toHex(lot), P.toHex(list));
});

test('compromisso de loteria muda com cada campo', async () => {
  const base = {
    title: 'Bolão', lotteryId: 'megasena', games: 5, picks: 6, extraPicks: 0,
    clientNonce: 'aa', poolId: 'p1', pulseIndex: 3, drandRound: 10,
  };
  const h0 = P.toHex(await L.lotteryCommitHash(base));
  const mutations = [
    { title: 'Outro' }, { lotteryId: 'quina' }, { games: 6 }, { picks: 7 },
    { extraPicks: 1 }, { clientNonce: 'ab' }, { poolId: 'p2' },
    { pulseIndex: 4 }, { drandRound: 11 },
  ];
  for (const m of mutations) {
    const h = P.toHex(await L.lotteryCommitHash({ ...base, ...m }));
    assert.notEqual(h, h0, `commit ignorou ${Object.keys(m)[0]}`);
  }
});

test('regras oficiais são respeitadas em todas as modalidades', async () => {
  const seed = await P.sha256(P.utf8('regras-ts'));
  for (const [id, spec] of Object.entries(L.LOTTERIES)) {
    for (const picks of new Set([spec.min, spec.max, spec.default])) {
      const games = await L.generate(id, 3, picks, spec.extra_default, seed);
      assert.equal(games.length, 3);
      for (const g of games) {
        if (g.columns) {
          assert.equal(g.columns.length, spec.columns);
          for (const col of g.columns) {
            assert.equal(col.length, picks);
            assert.equal(new Set(col).size, picks, `${id}: algarismo repetido`);
            assert.ok(col.every((d) => d >= spec.lo && d <= spec.hi));
          }
        } else {
          assert.equal(g.numbers.length, picks, `${id}: quantidade errada`);
          assert.equal(new Set(g.numbers).size, picks, `${id}: número repetido`);
          assert.deepEqual(g.numbers, [...g.numbers].sort((a, b) => a - b), `${id}: fora de ordem`);
          assert.ok(g.numbers.every((n) => n >= spec.lo && n <= spec.hi), `${id}: fora do intervalo`);
        }
        if (spec.extra === 'mes') assert.ok(L.MESES.includes(g.mes));
        if (spec.extra === 'trevos') {
          assert.equal(g.trevos.length, spec.extra_default);
          assert.ok(g.trevos.every((t) => t >= 1 && t <= 6));
        }
      }
    }
  }
});

test('entradas inválidas são recusadas', async () => {
  const seed = await P.sha256(P.utf8('invalido'));
  const bad = [
    ['megasena', 1, 5], ['megasena', 1, 21], ['lotofacil', 1, 14],
    ['quina', 1, 16], ['inexistente', 1, 6], ['megasena', 0, 6],
    ['megasena', 101, 6], ['lotomania', 1, 49],
  ];
  for (const [id, games, picks] of bad) {
    await assert.rejects(
      () => L.generate(id, games, picks, null, seed),
      `deveria recusar ${id} games=${games} picks=${picks}`,
    );
  }
  await assert.rejects(() => L.generate('maismilionaria', 1, 6, 7, seed), /trevos/);
});

test('pickDistinct nunca repete e cobre o intervalo inteiro', async () => {
  const seed = await P.sha256(P.utf8('cobertura'));
  const rng = new P.Drbg(seed);
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const picked = await L.pickDistinct(rng, 6, 1, 60);
    assert.equal(new Set(picked).size, 6);
    picked.forEach((n) => seen.add(n));
  }
  assert.equal(seen.size, 60, 'nem todas as 60 dezenas apareceram em 200 jogos');
});

test('jogos são determinísticos e distintos entre si', async () => {
  const seed = await P.sha256(P.utf8('determinismo-ts'));
  const a = await L.generate('megasena', 5, 6, null, seed);
  const b = await L.generate('megasena', 5, 6, null, seed);
  assert.deepEqual(a, b);
  const keys = new Set(a.map((g) => g.numbers.join('-')));
  assert.equal(keys.size, 5, 'jogos repetidos na mesma geração');
});
