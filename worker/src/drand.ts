/**
 * Cliente do drand — a "League of Entropy".
 *
 * Usamos a chain `quicknet`: esquema bls-unchained-g1-rfc9380, um round a
 * cada 3 segundos. Sendo *unchained*, a aleatoriedade do round N não depende
 * da assinatura do round N-1, então dá para verificar um round isolado sem
 * baixar a cadeia inteira — exatamente o que um verificador no browser
 * precisa.
 *
 * O papel do drand aqui é fechar o único buraco que o pulso quântico sozinho
 * deixaria: nós, operadores, conhecemos o pool inteiro no momento em que ele
 * é gerado. Se a semente dependesse só do pulso, daríamos para escolher qual
 * pulso usar depois de ver os participantes. O round do drand ainda não
 * existe quando o sorteio é criado, e ninguém — nem nós — consegue prevê-lo.
 */

export const QUICKNET = {
  chainHash: '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971',
  genesisTime: 1692803367,
  period: 3,
  scheme: 'bls-unchained-g1-rfc9380',
} as const;

/** Round que está sendo assinado no instante `unixSeconds`. */
export function roundAt(unixSeconds: number): number {
  const elapsed = unixSeconds - QUICKNET.genesisTime;
  if (elapsed < 0) return 1;
  return Math.floor(elapsed / QUICKNET.period) + 1;
}

/** Instante em que o round `round` passa a existir. */
export function timeOfRound(round: number): number {
  return QUICKNET.genesisTime + (round - 1) * QUICKNET.period;
}

export interface DrandBeacon {
  round: number;
  signature: string;
}

const ENDPOINTS = [
  (r: number) => `https://api.drand.sh/v2/chains/${QUICKNET.chainHash}/rounds/${r}`,
  (r: number) => `https://drand.cloudflare.com/${QUICKNET.chainHash}/public/${r}`,
  (r: number) => `https://api.drand.secureweb3.com:6875/${QUICKNET.chainHash}/public/${r}`,
];

/**
 * Busca um round específico, tentando os espelhos em ordem.
 *
 * Nenhum operador de espelho consegue forjar uma resposta sem quebrar BLS,
 * mas todos podem ficar fora do ar — daí a lista.
 */
export async function fetchRound(round: number): Promise<DrandBeacon> {
  const errors: string[] = [];
  for (const build of ENDPOINTS) {
    const url = build(round);
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/json' },
        cf: { cacheTtl: 3600, cacheEverything: true },
      });
      if (!res.ok) {
        errors.push(`${new URL(url).host}: HTTP ${res.status}`);
        continue;
      }
      const body = (await res.json()) as { round?: number; signature?: string };
      if (typeof body.signature !== 'string' || body.round !== round) {
        errors.push(`${new URL(url).host}: resposta inesperada`);
        continue;
      }
      return { round, signature: body.signature };
    } catch (e) {
      errors.push(`${new URL(url).host}: ${(e as Error).message}`);
    }
  }
  throw new Error(`nenhum espelho do drand respondeu (${errors.join('; ')})`);
}
