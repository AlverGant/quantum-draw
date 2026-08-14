/**
 * Teste de Bell (CHSH) anexado ao harvest.
 *
 * **Por que existe.** A entropia sozinha não diz nada sobre a origem dos bits:
 * uma QPU que na verdade devolvesse a saída de um PRNG entregaria amostras
 * igualmente bem distribuídas, e nenhum teste estatístico sobre o pool
 * distinguiria os dois casos. A violação da desigualdade CHSH, sim — S > 2 é
 * impossível para qualquer par de bits que tenha sido tabelado antes da
 * medição. O valor de S é evidência sobre o *mecanismo*, não sobre a
 * distribuição.
 *
 * **O que isto não é.** Os dois qubits ficam a micrômetros um do outro no mesmo
 * chip, são medidos pela mesma eletrônica e as bases são escolhidas por nós na
 * submissão. Não há separação tipo-espaço nem escolha aleatória de base, então
 * as brechas de localidade e de livre-arbítrio continuam abertas: isto é uma
 * **testemunha de emaranhamento**, e é assim que precisa ser descrito no site.
 * Certificação de verdade exige separação espacial ou o protocolo de amostragem
 * de circuitos aleatórios com verificação por XEB — nenhum dos dois ao alcance
 * daqui. O que a testemunha fecha é a hipótese mais barata contra o projeto:
 * a de que o "hardware quântico" é um gerador clássico com outro nome.
 *
 * **A física, em quatro linhas.**
 *
 *   |Φ+> = CX(a→b) · H(a) |00>,  cada lado medindo M(θ) = cos(θ)Z + sen(θ)X
 *   E(α,β) = <Φ+| M(α) ⊗ M(β) |Φ+> = cos(α − β)
 *   S = E(a,b) + E(a,b') + E(a',b) − E(a',b'),  com a=0, a'=π/2, b=π/4, b'=−π/4
 *     → 2√2 ≈ 2,828 no caso ideal; ≤ 2 para qualquer modelo de variáveis locais.
 *
 * Tudo nas portas nativas do Heron (cz, id, rz, sx, x), como no resto do
 * harvest — ver o cabeçalho de ibm.ts. A diferença é que aqui há emaranhamento,
 * então o par precisa ser vizinho no mapa de acoplamento (quem escolhe é
 * `IbmClient.bestPair`). O que continua dispensado é roteamento: dois qubits
 * adjacentes não têm o que rotear.
 */

export interface ChshAngle {
  /** Como o ângulo é escrito no QASM — literal exato, para o circuito ser auditável. */
  expr: string;
  value: number;
}

export interface ChshSetting {
  label: string;
  alice: ChshAngle;
  bob: ChshAngle;
  /** Como o termo entra na soma S. */
  sign: 1 | -1;
}

const ANGLE_A: ChshAngle = { expr: '0', value: 0 };
const ANGLE_A2: ChshAngle = { expr: 'pi/2', value: Math.PI / 2 };
const ANGLE_B: ChshAngle = { expr: 'pi/4', value: Math.PI / 4 };
const ANGLE_B2: ChshAngle = { expr: '-pi/4', value: -Math.PI / 4 };

/**
 * As quatro combinações de base. A ordem é contratual: é nela que os PUBs são
 * submetidos e é nela que os resultados voltam, então mexer aqui sem mexer no
 * que ficou gravado em `harvest_state.chsh_json` embaralha os termos de S.
 */
export const CHSH_SETTINGS: readonly ChshSetting[] = [
  { label: "ab", alice: ANGLE_A, bob: ANGLE_B, sign: 1 },
  { label: "ab'", alice: ANGLE_A, bob: ANGLE_B2, sign: 1 },
  { label: "a'b", alice: ANGLE_A2, bob: ANGLE_B, sign: 1 },
  { label: "a'b'", alice: ANGLE_A2, bob: ANGLE_B2, sign: -1 },
];

/** Limite de qualquer teoria de variáveis ocultas locais. */
export const CLASSICAL_BOUND = 2;
/** Máximo que a mecânica quântica permite (2√2). */
export const TSIRELSON_BOUND = 2 * Math.SQRT2;

/** H nas portas nativas — mesma decomposição usada pelo circuito de entropia. */
function hadamard(q: number): string[] {
  return [`rz(pi/2) $${q};`, `sx $${q};`, `rz(pi/2) $${q};`];
}

/**
 * Rotação que leva M(θ) = cos(θ)Z + sen(θ)X para o eixo computacional, ou seja
 * Ry(−θ): medir Z depois dela é o mesmo que medir M(θ).
 *
 * Sai de uma identidade só, que vale a pena registrar porque não é óbvia e é
 * onde um erro passaria despercebido (o circuito continuaria rodando, só que
 * medindo a base errada, e S cairia para perto de 2 sem nenhum sintoma):
 *
 *     SX · Rz(β) · SX = Ry(−β) · X        (a menos de fase global)
 *
 * Com β = θ e aplicando um X antes para cancelar o que sobra:
 *
 *     Ry(−θ) = SX · Rz(θ) · SX · X
 *
 * Em ordem de circuito (o que é aplicado primeiro fica à direita no produto):
 * x, sx, rz(θ), sx. O teste em test/chsh.test.mjs simula o QASM gerado e
 * confere que S bate 2√2, o que só acontece se esta conta estiver certa.
 *
 * Para θ = 0 não emitimos nada: medir Z já é a base pedida, e três portas a
 * menos são três portas a menos de ruído justo onde a correlação importa.
 */
function basisChange(q: number, angle: ChshAngle): string[] {
  if (angle.value === 0) return [];
  return [`x $${q};`, `sx $${q};`, `rz(${angle.expr}) $${q};`, `sx $${q};`];
}

/** Circuito de um par de bases, em OpenQASM 3 com qubits físicos. */
export function buildChshQasm(pair: readonly [number, number], setting: ChshSetting): string {
  const [qa, qb] = pair;
  if (qa === qb) throw new Error('par CHSH precisa de dois qubits distintos');
  return [
    'OPENQASM 3.0;',
    'include "stdgates.inc";',
    'bit[2] chsh;',
    // |Φ+>: H no primeiro e CX(qa→qb). Como CX não é nativa, entra pela
    // identidade CX(c,t) = H(t) · CZ(c,t) · H(t).
    ...hadamard(qa),
    ...hadamard(qb),
    `cz $${qa}, $${qb};`,
    ...hadamard(qb),
    ...basisChange(qa, setting.alice),
    ...basisChange(qb, setting.bob),
    `chsh[0] = measure $${qa};`,
    `chsh[1] = measure $${qb};`,
  ].join('\n');
}

/** Os quatro PUBs do teste, na ordem de CHSH_SETTINGS. */
export function chshPubs(
  pair: readonly [number, number],
  shots: number,
): Array<{ qasm: string; shots: number }> {
  return CHSH_SETTINGS.map((setting) => ({ qasm: buildChshQasm(pair, setting), shots }));
}

/**
 * Correlação <M(α)⊗M(β)> a partir das amostras hex de um par de bases.
 *
 * É a média de (−1)^(paridade dos dois bits): 00 e 11 valem +1, 01 e 10 valem
 * −1. Repare que **a ordem dos bits não importa** — a paridade é simétrica —
 * então esta conta não depende de a IBM devolver chsh[0] no bit alto ou no
 * baixo, que é exatamente o tipo de convenção que muda sem aviso.
 */
export function correlation(samples: string[]): { shots: number; e: number } {
  let plus = 0;
  let minus = 0;
  for (const sample of samples) {
    const h = sample.startsWith('0x') || sample.startsWith('0X') ? sample.slice(2) : sample;
    const v = parseInt(h, 16);
    if (Number.isNaN(v)) throw new Error(`amostra CHSH inválida: ${sample.slice(0, 24)}`);
    if ((v ^ (v >> 1)) & 1) minus++;
    else plus++;
  }
  const shots = plus + minus;
  if (shots === 0) throw new Error('par de bases sem amostras');
  return { shots, e: (plus - minus) / shots };
}

export interface ChshReport {
  s: number;
  /** Incerteza estatística de S, propagada dos quatro termos. */
  sigma: number;
  /** Quantos desvios-padrão S está acima do teto clássico. */
  sigmas_above_classical: number;
  violates: boolean;
  classical_bound: number;
  tsirelson_bound: number;
  qubits: [number, number];
  settings: Array<{
    label: string;
    alice: string;
    bob: string;
    sign: number;
    shots: number;
    e: number;
    ideal: number;
  }>;
}

/**
 * Monta o laudo do teste a partir das amostras de cada par de bases.
 *
 * `samplesPerSetting` tem que estar na ordem de CHSH_SETTINGS — é a ordem em
 * que os PUBs foram submetidos.
 *
 * A incerteza de cada termo é a de uma média de ±1: σ_E = √((1 − E²)/N). Como
 * os quatro pares de bases são circuitos independentes, σ_S é a raiz da soma
 * dos quadrados; os sinais de S não entram porque somem no quadrado. Com 2048
 * shots por base isso dá σ_S ≈ 0,044, e uma violação típica de hardware
 * (S ≈ 2,5) fica a mais de 10σ do teto clássico.
 */
export function chshScore(
  pair: readonly [number, number],
  samplesPerSetting: string[][],
): ChshReport {
  if (samplesPerSetting.length !== CHSH_SETTINGS.length) {
    throw new Error(
      `CHSH esperava ${CHSH_SETTINGS.length} pares de bases, recebeu ${samplesPerSetting.length}`,
    );
  }

  let s = 0;
  let variance = 0;
  const settings = CHSH_SETTINGS.map((setting, i) => {
    const { shots, e } = correlation(samplesPerSetting[i]);
    s += setting.sign * e;
    variance += (1 - e * e) / shots;
    return {
      label: setting.label,
      alice: setting.alice.expr,
      bob: setting.bob.expr,
      sign: setting.sign,
      shots,
      e: Math.round(e * 1e6) / 1e6,
      ideal: Math.round(Math.cos(setting.alice.value - setting.bob.value) * 1e6) / 1e6,
    };
  });

  const sigma = Math.sqrt(variance);
  return {
    s: Math.round(s * 1e6) / 1e6,
    sigma: Math.round(sigma * 1e6) / 1e6,
    sigmas_above_classical: Math.round(((s - CLASSICAL_BOUND) / sigma) * 100) / 100,
    violates: s > CLASSICAL_BOUND,
    classical_bound: CLASSICAL_BOUND,
    tsirelson_bound: Math.round(TSIRELSON_BOUND * 1e6) / 1e6,
    qubits: [pair[0], pair[1]],
    settings,
  };
}
