/**
 * Teste de Bell: o QASM gerado é simulado aqui dentro e S tem que bater 2√2.
 *
 * Isto não é zelo excessivo. O circuito passa por duas decomposições feitas na
 * mão — CX a partir de cz, e Ry(−θ) a partir de sx/rz — e **as duas falham em
 * silêncio**: um sinal trocado no ângulo produz um circuito perfeitamente
 * válido, que roda, custa QPU e devolve S ≈ 2. Como S ≈ 2 é exatamente o
 * resultado que um crítico do projeto esperaria ver, o erro seria lido como
 * descoberta em vez de bug. O simulador abaixo fecha essa porta: se a álgebra
 * estiver certa, S = 2√2 exatamente; se não estiver, o teste quebra antes do
 * deploy.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CHSH_SETTINGS,
  CLASSICAL_BOUND,
  TSIRELSON_BOUND,
  buildChshQasm,
  chshPubs,
  chshScore,
  correlation,
} from '../src/chsh.ts';

// ------------------------------------------- simulador de estado (2 qubits)

/** Aceita os literais que o gerador emite: 0, pi, pi/2, -pi/4, 1.5708... */
function angle(expr) {
  const m = expr.trim().match(/^(-?)(pi|\d+(?:\.\d+)?)(?:\/(\d+))?$/);
  assert.ok(m, `ângulo não reconhecido: ${expr}`);
  const num = m[2] === 'pi' ? Math.PI : Number(m[2]);
  return ((m[1] === '-' ? -1 : 1) * num) / (m[3] ? Number(m[3]) : 1);
}

const SX = [
  [0.5, 0.5, 0.5, -0.5],
  [0.5, -0.5, 0.5, 0.5],
]; // linhas [reA, imA, reB, imB] de [[1+i, 1-i], [1-i, 1+i]]/2
const X = [
  [0, 0, 1, 0],
  [1, 0, 0, 0],
];

function rz(theta) {
  const c = Math.cos(theta / 2);
  const s = Math.sin(theta / 2);
  return [
    [c, -s, 0, 0],
    [0, 0, c, s],
  ];
}

/** Aplica a matriz 2x2 no qubit `k` (bit k do índice da base). */
function apply1(st, k, m) {
  const bit = 1 << k;
  for (let i = 0; i < 4; i++) {
    if (i & bit) continue;
    const j = i | bit;
    const [ar, ai, br, bi] = m[0];
    const [cr, ci, dr, di] = m[1];
    const [xr, xi, yr, yi] = [st.re[i], st.im[i], st.re[j], st.im[j]];
    st.re[i] = ar * xr - ai * xi + br * yr - bi * yi;
    st.im[i] = ar * xi + ai * xr + br * yi + bi * yr;
    st.re[j] = cr * xr - ci * xi + dr * yr - di * yi;
    st.im[j] = cr * xi + ci * xr + dr * yi + di * yr;
  }
}

/**
 * Roda o QASM3 gerado e devolve a distribuição exata sobre os dois bits
 * medidos. Sem amostragem: o que se quer aferir é a álgebra do circuito, e
 * ruído de Monte Carlo só atrapalharia.
 */
function simulate(qasm) {
  const st = { re: new Float64Array(4), im: new Float64Array(4) };
  st.re[0] = 1; // |00>
  const slots = new Map();
  const slot = (phys) => {
    if (!slots.has(phys)) {
      assert.ok(slots.size < 2, 'o simulador só faz dois qubits');
      slots.set(phys, slots.size);
    }
    return slots.get(phys);
  };

  let measured = 0;
  for (const line of qasm.split('\n').map((l) => l.trim()).filter(Boolean)) {
    if (line.startsWith('OPENQASM') || line.startsWith('include') || line.startsWith('bit[')) {
      continue;
    }
    let m;
    if ((m = line.match(/^rz\(([^)]+)\)\s+\$(\d+);$/))) {
      apply1(st, slot(Number(m[2])), rz(angle(m[1])));
    } else if ((m = line.match(/^sx\s+\$(\d+);$/))) {
      apply1(st, slot(Number(m[1])), SX);
    } else if ((m = line.match(/^x\s+\$(\d+);$/))) {
      apply1(st, slot(Number(m[1])), X);
    } else if ((m = line.match(/^cz\s+\$(\d+),\s*\$(\d+);$/))) {
      const bits = (1 << slot(Number(m[1]))) | (1 << slot(Number(m[2])));
      for (let i = 0; i < 4; i++) {
        if ((i & bits) === bits) {
          st.re[i] = -st.re[i];
          st.im[i] = -st.im[i];
        }
      }
    } else if ((m = line.match(/^\w+\[\d+\]\s*=\s*measure\s+\$(\d+);$/))) {
      slot(Number(m[1]));
      measured++;
    } else {
      assert.fail(`linha não reconhecida pelo simulador: ${line}`);
    }
  }

  assert.equal(measured, 2, 'o circuito precisa medir os dois qubits');
  return Array.from({ length: 4 }, (_, i) => st.re[i] ** 2 + st.im[i] ** 2);
}

/** <M(α)⊗M(β)> exata: média de (−1)^paridade sobre a distribuição. */
function exactCorrelation(probs) {
  return probs.reduce((acc, p, i) => acc + ((i ^ (i >> 1)) & 1 ? -p : p), 0);
}

const PAIR = [58, 59];

// ---------------------------------------------------------------- circuito

test('o circuito monta o estado de Bell', () => {
  // Base ZZ (α=β=0): |Φ+> tem que dar meio a meio entre 00 e 11, e zero nos
  // cruzados. Se a decomposição de CX a partir de cz estiver errada, é aqui
  // que aparece.
  const zz = buildChshQasm(PAIR, { label: 'zz', alice: { expr: '0', value: 0 }, bob: { expr: '0', value: 0 }, sign: 1 });
  const p = simulate(zz);
  assert.ok(Math.abs(p[0] - 0.5) < 1e-12, `p(00)=${p[0]}`);
  assert.ok(Math.abs(p[3] - 0.5) < 1e-12, `p(11)=${p[3]}`);
  assert.ok(p[1] < 1e-12 && p[2] < 1e-12, 'estado de Bell não deveria ter peso em 01/10');
});

test('cada par de bases dá a correlação cos(α−β)', () => {
  // Valida a decomposição de Ry(−θ) uma base por vez: com S agregado, dois
  // sinais trocados poderiam se cancelar e o total ainda fechar.
  for (const setting of CHSH_SETTINGS) {
    const e = exactCorrelation(simulate(buildChshQasm(PAIR, setting)));
    const ideal = Math.cos(setting.alice.value - setting.bob.value);
    assert.ok(Math.abs(e - ideal) < 1e-12, `${setting.label}: E=${e}, esperado ${ideal}`);
  }
});

test('S ideal bate o limite de Tsirelson', () => {
  const s = CHSH_SETTINGS.reduce(
    (acc, setting) => acc + setting.sign * exactCorrelation(simulate(buildChshQasm(PAIR, setting))),
    0,
  );
  assert.ok(Math.abs(s - TSIRELSON_BOUND) < 1e-12, `S=${s}, esperado ${TSIRELSON_BOUND}`);
  assert.ok(s > CLASSICAL_BOUND);
});

test('o QASM só usa portas nativas do Heron', () => {
  // A premissa do projeto inteiro é submeter circuito ISA sem transpilador. Uma
  // porta não nativa aqui faria a IBM recusar o job — junto com a entropia.
  const nativas = new Set(['rz', 'sx', 'x', 'cz', 'id']);
  for (const setting of CHSH_SETTINGS) {
    for (const line of buildChshQasm(PAIR, setting).split('\n')) {
      if (/^(OPENQASM|include|bit\[)/.test(line) || line.includes('measure')) continue;
      const gate = line.match(/^([a-z]+)/)?.[1];
      assert.ok(nativas.has(gate), `porta não nativa no circuito: ${line}`);
    }
  }
});

test('o circuito usa os qubits físicos pedidos', () => {
  const qasm = buildChshQasm([12, 13], CHSH_SETTINGS[3]);
  assert.ok(qasm.includes('cz $12, $13;'));
  assert.ok(qasm.includes('chsh[0] = measure $12;'));
  assert.ok(qasm.includes('chsh[1] = measure $13;'));
});

test('base a=0 não gasta portas com rotação identidade', () => {
  const comZ = buildChshQasm(PAIR, CHSH_SETTINGS[0]); // alice em 0
  const comRot = buildChshQasm(PAIR, CHSH_SETTINGS[2]); // alice em pi/2
  assert.ok(comZ.length < comRot.length, 'θ=0 deveria pular a mudança de base');
});

test('par degenerado é recusado', () => {
  assert.throws(() => buildChshQasm([7, 7], CHSH_SETTINGS[0]), /distintos/);
});

test('chshPubs devolve os quatro pares de bases com os shots pedidos', () => {
  const pubs = chshPubs(PAIR, 2048);
  assert.equal(pubs.length, 4);
  assert.ok(pubs.every((p) => p.shots === 2048));
  assert.equal(new Set(pubs.map((p) => p.qasm)).size, 4, 'os quatro circuitos têm que diferir');
});

// ------------------------------------------------------------- estatística

/** Amostras hex de um par de bases com correlação `e` (o resto é anticorrelado). */
function fakeSamples(e, shots) {
  const plus = Math.round((shots * (1 + e)) / 2);
  return Array.from({ length: shots }, (_, i) => (i < plus ? '0x3' : '0x1'));
}

test('correlation lê a paridade das amostras', () => {
  assert.equal(correlation(['0x0', '0x3']).e, 1); // 00 e 11: correlacionados
  assert.equal(correlation(['0x1', '0x2']).e, -1); // 01 e 10: anticorrelados
  assert.equal(correlation(['0x0', '0x1']).e, 0);
  assert.equal(correlation(['0x0', '0x1']).shots, 2);
});

test('correlation não depende da ordem dos bits', () => {
  // A paridade é simétrica, então tanto faz se chsh[0] volta no bit alto ou no
  // baixo — convenção que a API pode trocar sem avisar.
  assert.equal(correlation(['0x1']).e, correlation(['0x2']).e);
});

test('correlation rejeita hex inválido e amostra vazia', () => {
  assert.throws(() => correlation(['0xzz']), /inválida/);
  assert.throws(() => correlation([]), /sem amostras/);
});

test('chshScore reproduz o S ideal e marca a violação', () => {
  const shots = 100_000;
  const r = chshScore(
    PAIR,
    CHSH_SETTINGS.map((s) => fakeSamples(Math.cos(s.alice.value - s.bob.value), shots)),
  );
  assert.ok(Math.abs(r.s - TSIRELSON_BOUND) < 1e-3, `S=${r.s}`);
  assert.equal(r.violates, true);
  assert.ok(r.sigmas_above_classical > 100);
  assert.deepEqual(r.qubits, PAIR);
  assert.equal(r.settings.length, 4);
});

test('chshScore não vê violação em correlação clássica', () => {
  // Quatro termos em +0,5: S = 0,5+0,5+0,5−0,5 = 1. Dentro do limite local.
  const r = chshScore(PAIR, CHSH_SETTINGS.map(() => fakeSamples(0.5, 10_000)));
  assert.equal(r.violates, false);
  assert.ok(r.s < CLASSICAL_BOUND);
  assert.ok(r.sigmas_above_classical < 0);
});

test('chshScore recusa número errado de pares de bases', () => {
  assert.throws(() => chshScore(PAIR, [fakeSamples(1, 10)]), /esperava 4 pares/);
});

test('a incerteza de S cai com a raiz dos shots', () => {
  const at = (shots) =>
    chshScore(PAIR, CHSH_SETTINGS.map((s) => fakeSamples(Math.cos(s.alice.value - s.bob.value), shots))).sigma;
  const s2048 = at(2048);
  // σ_S ≈ 0,044 com 2048 shots por base — o número que justifica o padrão.
  assert.ok(s2048 > 0.03 && s2048 < 0.06, `σ inesperado: ${s2048}`);
  assert.ok(Math.abs(at(8192) - s2048 / 2) < 0.005, 'σ deveria cair pela metade com 4x shots');
});
