/**
 * Construção do pool de entropia dentro do Worker.
 *
 * Porte fiel de ../../quantum/pool.py: von Neumann, condicionamento SHA-256 e
 * montagem do pool. Os vetores em ../test/vectors.json (seção `pool_build`)
 * são gerados pelo Python e conferidos contra este módulo — se as duas
 * implementações divergirem num único byte, o teste quebra.
 *
 * Por que existe: o harvest agora roda no cron do Cloudflare, sem máquina
 * externa nem Qiskit. O circuito que precisamos (H em todos os qubits) vira
 * QASM3 trivial, e todo o pós-processamento é hash — nada disso precisa do SDK.
 */

import { merkleRoot, sha256, toHex, u32, utf8 } from './protocol.ts';

export const PULSE_BYTES = 32;

/**
 * Debiasing de von Neumann sobre um fluxo de bits empacotado (MSB primeiro).
 * 01 -> 0, 10 -> 1, descarta 00 e 11. Rendimento esperado ~25%.
 *
 * Trabalha direto sobre bytes em vez de um array de bits: 3,4 milhões de
 * elementos num Array de números custaria dezenas de MB e o dobro do tempo.
 */
export function vonNeumann(raw: Uint8Array, nBits: number): { bits: Uint8Array; count: number } {
  const out = new Uint8Array(Math.ceil(nBits / 2 / 8) + 1);
  let n = 0;
  for (let i = 0; i + 1 < nBits; i += 2) {
    const a = (raw[i >> 3] >> (7 - (i & 7))) & 1;
    const b = (raw[(i + 1) >> 3] >> (7 - ((i + 1) & 7))) & 1;
    if (a !== b) {
      if (a) out[n >> 3] |= 0x80 >> (n & 7);
      n++;
    }
  }
  // Espelha bits_to_bytes do Python: o resto que não fecha um byte é descartado.
  return { bits: out.subarray(0, Math.floor(n / 8)), count: n };
}

/**
 * Condicionamento SHA-256 com compressão 2:1 — consome 64 bytes por bloco e
 * emite 32. Mesmo com correlação residual entre qubits vizinhos, comprimir
 * num hash criptográfico entrega saída indistinguível de uniforme.
 */
export async function condition(data: Uint8Array, outLen: number): Promise<Uint8Array> {
  const blocks = Math.ceil(outLen / 32);
  const need = blocks * 64;
  if (data.length < need) {
    throw new Error(`entropia insuficiente: preciso de ${need} bytes pós-von-Neumann, recebi ${data.length}`);
  }
  const out = new Uint8Array(blocks * 32);
  for (let b = 0; b < blocks; b++) {
    const chunk = data.subarray(b * 64, (b + 1) * 64);
    out.set(await sha256(utf8('qdraw/v1/cond'), u32(b), chunk), b * 32);
  }
  return out.subarray(0, outLen);
}

/** Bits crus necessários para `pulseCount` pulsos, com 15% de folga. */
export function rawBitsNeeded(pulseCount: number): number {
  return Math.trunc(pulseCount * 64 * 8 * 4 * 1.15);
}

export interface BuiltPool {
  poolId: string;
  genesisTime: number;
  period: number;
  pulses: Uint8Array[];
  merkleRoot: string;
  source: Record<string, unknown>;
}

export async function buildPool(
  raw: Uint8Array,
  nBits: number,
  pulseCount: number,
  period: number,
  source: Record<string, unknown>,
  genesisTime?: number,
): Promise<BuiltPool> {
  const vn = vonNeumann(raw, nBits);
  const conditioned = await condition(vn.bits, pulseCount * PULSE_BYTES);

  const pulses: Uint8Array[] = [];
  for (let i = 0; i < pulseCount; i++) {
    pulses.push(conditioned.subarray(i * PULSE_BYTES, (i + 1) * PULSE_BYTES));
  }

  if (genesisTime === undefined) {
    // Primeiro pulso só revelável no próximo múltiplo do período, com uma
    // folga de um período inteiro para a publicação acontecer.
    const now = Math.floor(Date.now() / 1000);
    genesisTime = (Math.floor(now / period) + 2) * period;
  }

  let ones = 0;
  for (let i = 0; i < nBits; i++) ones += (raw[i >> 3] >> (7 - (i & 7))) & 1;

  const root = await merkleRoot(pulses);
  const poolId = toHex(await sha256(utf8('qdraw/v1/pool-id'), root, u32(genesisTime))).slice(0, 16);

  return {
    poolId,
    genesisTime,
    period,
    pulses,
    merkleRoot: toHex(root),
    source: {
      ...source,
      raw_bits: nBits,
      von_neumann_bits: vn.count,
      von_neumann_yield: Math.round((vn.count / Math.max(nBits, 1)) * 10000) / 10000,
      ones_ratio_raw: Math.round((ones / Math.max(nBits, 1)) * 1e6) / 1e6,
    },
  };
}
