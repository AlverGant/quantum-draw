/**
 * Geração de jogos das Loterias Caixa — porte de ../../quantum/lottery.py.
 *
 * Regras conferidas contra a API pública da Caixa e a documentação oficial em
 * agosto de 2026. `picks` é quanto o apostador marca, não quanto a Caixa
 * sorteia: a Timemania é o caso que mais confunde, aposta-se 10 dezenas e são
 * sorteadas 7.
 *
 * Isto não melhora a chance de ninguém — o site diz isso na cara. O que muda é
 * a prova: como o compromisso antecede o pulso e o round do drand, dá para
 * demonstrar que os números saíram antes do sorteio da Caixa.
 */

import { Drbg, sha256, utf8 } from './protocol.ts';

export interface LotterySpec {
  lo: number;
  hi: number;
  min: number;
  max: number;
  default: number;
  columns?: number;
  extra?: 'mes' | 'trevos';
  extra_lo?: number;
  extra_hi?: number;
  extra_min?: number;
  extra_max?: number;
  extra_default?: number;
}

export const LOTTERIES: Record<string, LotterySpec> = {
  megasena: { lo: 1, hi: 60, min: 6, max: 20, default: 6 },
  lotofacil: { lo: 1, hi: 25, min: 15, max: 20, default: 15 },
  quina: { lo: 1, hi: 80, min: 5, max: 15, default: 5 },
  lotomania: { lo: 0, hi: 99, min: 50, max: 50, default: 50 },
  duplasena: { lo: 1, hi: 50, min: 6, max: 15, default: 6 },
  timemania: { lo: 1, hi: 80, min: 10, max: 10, default: 10 },
  diadesorte: { lo: 1, hi: 31, min: 7, max: 15, default: 7, extra: 'mes' },
  maismilionaria: {
    lo: 1, hi: 50, min: 6, max: 12, default: 6,
    extra: 'trevos', extra_lo: 1, extra_hi: 6,
    extra_min: 2, extra_max: 6, extra_default: 2,
  },
  // Sete colunas independentes; em cada uma marca-se de 1 a 3 algarismos.
  supersete: { lo: 0, hi: 9, min: 1, max: 3, default: 1, columns: 7 },
};

export const MESES = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];

export const MAX_GAMES = 100;

export interface Game {
  numbers?: number[];
  columns?: number[][];
  trevos?: number[];
  mes?: string;
}

/**
 * `count` inteiros distintos em [lo, hi], em ordem crescente.
 * Fisher-Yates parcial sobre o intervalo: todo subconjunto é equiprovável e os
 * índices vêm do DRBG com amostragem por rejeição — sem viés em etapa alguma.
 */
export async function pickDistinct(
  rng: Drbg, count: number, lo: number, hi: number,
): Promise<number[]> {
  const total = hi - lo + 1;
  if (count < 1 || count > total) {
    throw new Error(`não dá para tirar ${count} de ${total} números`);
  }
  const pool = Array.from({ length: total }, (_, i) => lo + i);
  for (let i = 0; i < count; i++) {
    const j = i + (await rng.below(total - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count).sort((a, b) => a - b);
}

export interface LotteryParams {
  spec: LotterySpec;
  picks: number;
  extraPicks: number;
}

export function validate(
  lotteryId: string, games: number, picks?: number | null, extraPicks?: number | null,
): LotteryParams {
  const spec = LOTTERIES[lotteryId];
  if (!spec) throw new Error(`loteria desconhecida: ${lotteryId}`);

  if (!Number.isInteger(games) || games < 1 || games > MAX_GAMES) {
    throw new Error(`quantidade de jogos fora do intervalo 1..${MAX_GAMES}`);
  }

  const p = picks === null || picks === undefined ? spec.default : Math.trunc(Number(picks));
  if (!Number.isFinite(p) || p < spec.min || p > spec.max) {
    throw new Error(`${lotteryId} aceita de ${spec.min} a ${spec.max} números, recebi ${p}`);
  }

  let e = 0;
  if (spec.extra === 'trevos') {
    e = extraPicks === null || extraPicks === undefined
      ? spec.extra_default! : Math.trunc(Number(extraPicks));
    if (!Number.isFinite(e) || e < spec.extra_min! || e > spec.extra_max!) {
      throw new Error(`trevos devem ser de ${spec.extra_min} a ${spec.extra_max}, recebi ${e}`);
    }
  }

  return { spec, picks: p, extraPicks: e };
}

export async function generate(
  lotteryId: string, games: number, picks: number | null | undefined,
  extraPicks: number | null | undefined, seed: Uint8Array,
): Promise<Game[]> {
  const { spec, picks: p, extraPicks: e } = validate(lotteryId, games, picks, extraPicks);
  const rng = new Drbg(seed);
  const out: Game[] = [];

  for (let g = 0; g < games; g++) {
    const game: Game = {};
    if (spec.columns) {
      const columns: number[][] = [];
      for (let c = 0; c < spec.columns; c++) {
        columns.push(await pickDistinct(rng, p, spec.lo, spec.hi));
      }
      game.columns = columns;
    } else {
      game.numbers = await pickDistinct(rng, p, spec.lo, spec.hi);
    }

    if (spec.extra === 'mes') game.mes = MESES[await rng.below(12)];
    else if (spec.extra === 'trevos') {
      game.trevos = await pickDistinct(rng, e, spec.extra_lo!, spec.extra_hi!);
    }

    out.push(game);
  }

  return out;
}

/** Compromisso da geração — separador de domínio próprio, nunca colide com o de lista. */
export async function lotteryCommitHash(input: {
  title: string;
  lotteryId: string;
  games: number;
  picks: number;
  extraPicks: number;
  clientNonce: string;
  poolId: string;
  pulseIndex: number;
  drandRound: number;
}): Promise<Uint8Array> {
  const body =
    [
      'qdraw/v1/lottery-commit',
      input.title.normalize('NFC'),
      input.lotteryId,
      String(Math.trunc(input.games)),
      String(Math.trunc(input.picks)),
      String(Math.trunc(input.extraPicks)),
      input.clientNonce,
      input.poolId,
      String(Math.trunc(input.pulseIndex)),
      String(Math.trunc(input.drandRound)),
    ].join('\n') + '\n';
  return sha256(utf8(body));
}
