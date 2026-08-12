/**
 * Verificador independente — roda inteiramente no navegador do visitante.
 *
 * O ponto deste arquivo é não precisar confiar em nós. Ele:
 *   - usa protocol.js, que é o MESMO código do servidor (gerado do
 *     worker/src/protocol.ts), então não há uma segunda implementação que
 *     pudesse "concordar por engano";
 *   - busca o round do drand direto em api.drand.sh, sem passar pelos nossos
 *     servidores. Se mentíssemos sobre a aleatoriedade, o passo 5 quebraria.
 *
 * Um verificador que buscasse o farol através da nossa API não provaria nada.
 */

import * as P from './protocol.js';

const DRAND_MIRRORS = [
  (chain, round) => `https://api.drand.sh/v2/chains/${chain}/rounds/${round}`,
  (chain, round) => `https://drand.cloudflare.com/${chain}/public/${round}`,
];

export const STEP_KEYS = [
  'verify.s1', 'verify.s2', 'verify.s3', 'verify.s4', 'verify.s5', 'verify.s6',
];

/** Extrai o código do sorteio de um link completo, de um caminho ou do código puro. */
export function parseSlug(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const fromUrl = raw.match(/\/s\/([0-9a-z]{4,32})/i);
  if (fromUrl) return fromUrl[1].toLowerCase();
  const bare = raw.match(/^[0-9a-z]{4,32}$/i);
  return bare ? raw.toLowerCase() : null;
}

async function fetchDrandIndependently(chainHash, round) {
  const errors = [];
  for (const build of DRAND_MIRRORS) {
    const url = build(chainHash, round);
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      if (!res.ok) { errors.push(`${res.status} @ ${new URL(url).host}`); continue; }
      const body = await res.json();
      if (body && typeof body.signature === 'string') {
        return { signature: body.signature, host: new URL(url).host };
      }
      errors.push(`resposta inesperada @ ${new URL(url).host}`);
    } catch (e) {
      errors.push(`${e.message} @ ${new URL(url).host}`);
    }
  }
  throw new Error(errors.join('; '));
}

/**
 * Executa as seis etapas. `onStep(i, status, detail)` é chamado com
 * status 'busy' | 'ok' | 'bad' para a UI acompanhar.
 */
export async function verifyDraw(slug, onStep, origin = '', onKind) {
  const step = (i, status, detail) => onStep?.(i, status, detail);
  const fail = (i, detail) => { step(i, 'bad', detail); return { ok: false, failedAt: i, detail }; };

  // 1 — baixar a prova publicada
  step(0, 'busy');
  let proof;
  try {
    const res = await fetch(`${origin}/api/draws/${slug}/proof`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return fail(0, body.message || `HTTP ${res.status}`);
    }
    proof = await res.json();
  } catch (e) {
    return fail(0, e.message);
  }
  onKind?.(proof.kind);
  step(0, 'ok', proof.kind === 'lottery'
    ? { key: 'vd.gamesN', vars: { n: proof.lottery.games } }
    : { key: 'vd.participants', vars: { n: proof.participants.length } });

  const isLottery = proof.kind === 'lottery';
  // Reconstruido campo a campo, e nao com JSON.stringify(proof.lottery), para
  // a ordem das chaves nao depender de como o JSON foi serializado no caminho.
  const cfg = isLottery
    ? {
        lottery: proof.lottery.lottery,
        games: proof.lottery.games,
        picks: proof.lottery.picks,
        extra_picks: proof.lottery.extra_picks,
      }
    : null;

  // 2 - o hash da entrada corresponde ao publicado
  step(1, 'busy');
  let pHash;
  try {
    pHash = isLottery
      ? P.toHex(await P.sha256(P.utf8('qdraw/v1/lottery-config\n'), P.utf8(JSON.stringify(cfg))))
      : P.toHex(await P.participantsHash(proof.participants));
  } catch (e) {
    return fail(1, e.message);
  }
  if (pHash !== proof.commitment.participants_hash) {
    return fail(1, `computed ${pHash.slice(0, 16)}\u2026, published ${proof.commitment.participants_hash.slice(0, 16)}\u2026`);
  }
  step(1, 'ok', pHash.slice(0, 32) + '\u2026');

  // 3 - o compromisso corresponde a todas as entradas declaradas
  step(2, 'busy');
  const commit = P.toHex(
    isLottery
      ? await P.lotteryCommitHash({
          title: proof.title,
          lotteryId: cfg.lottery,
          games: cfg.games,
          picks: cfg.picks,
          extraPicks: cfg.extra_picks,
          clientNonce: proof.commitment.client_nonce,
          poolId: proof.quantum.pool_id,
          pulseIndex: proof.quantum.pulse_index,
          drandRound: proof.drand.round,
        })
      : await P.commitHash({
          title: proof.title,
          participants: proof.participants,
          winnersCount: proof.commitment.winners_count,
          clientNonce: proof.commitment.client_nonce,
          poolId: proof.quantum.pool_id,
          pulseIndex: proof.quantum.pulse_index,
          drandRound: proof.drand.round,
        }),
  );
  if (commit !== proof.commitment.commit_hash) {
    return fail(2, `computed ${commit.slice(0, 16)}\u2026, published ${proof.commitment.commit_hash.slice(0, 16)}\u2026`);
  }
  step(2, 'ok', commit.slice(0, 32) + '\u2026');

  // 4 — o pulso quântico pertence mesmo à raiz publicada
  step(3, 'busy');
  let merkleOk;
  try {
    merkleOk = await P.verifyProof(
      proof.quantum.pulse_index,
      P.fromHex(proof.quantum.pulse_value),
      proof.quantum.merkle_proof,
      P.fromHex(proof.quantum.merkle_root),
    );
  } catch (e) {
    return fail(3, e.message);
  }
  if (!merkleOk) return fail(3, 'Merkle path does not reach the published root');
  step(3, 'ok', { key: 'vd.indexRoot', vars: { i: proof.quantum.pulse_index, root: proof.quantum.merkle_root.slice(0, 16) + '\u2026' } });

  // 5 — o farol, buscado direto na fonte (não através da nossa API)
  step(4, 'busy');
  let beacon;
  try {
    beacon = await fetchDrandIndependently(proof.drand.chain_hash, proof.drand.round);
  } catch (e) {
    return fail(4, `no drand mirror responded: ${e.message}`);
  }
  if (beacon.signature.toLowerCase() !== String(proof.drand.signature).toLowerCase()) {
    return fail(4, 'published signature differs from what drand serves');
  }
  const randomness = P.toHex(await P.drandRandomness(beacon.signature));
  if (randomness !== proof.drand.randomness) {
    return fail(4, 'derived randomness does not match the published one');
  }
  step(4, 'ok', { key: 'vd.confirmedBy', vars: { r: proof.drand.round, host: beacon.host } });

  // 6 — refazer a geração e comparar
  step(5, 'busy');

  if (isLottery) {
    const seed = await P.deriveSeed(
      P.fromHex(proof.commitment.commit_hash),
      P.fromHex(proof.quantum.pulse_value),
      P.fromHex(proof.drand.randomness),
    );
    if (P.toHex(seed) !== proof.result.seed) {
      return fail(5, 'recomputed seed differs from the published one');
    }
    let games;
    try {
      games = await P.generateLottery(cfg.lottery, cfg.games, cfg.picks, cfg.extra_picks, seed);
    } catch (e) {
      return fail(5, e.message);
    }
    if (JSON.stringify(games) !== JSON.stringify(proof.result.games)) {
      return fail(5, 'recomputed games differ from the published ones');
    }
    step(5, 'ok', { key: 'vd.games', vars: { n: games.length } });
    return { ok: true, proof, games };
  }

  const redraw = await P.runDraw(
    proof.participants,
    proof.commitment.winners_count,
    P.fromHex(proof.commitment.commit_hash),
    P.fromHex(proof.quantum.pulse_value),
    P.fromHex(proof.drand.randomness),
  );
  if (redraw.seed !== proof.result.seed) {
    return fail(5, 'recomputed seed differs from the published one');
  }
  const same = redraw.order.length === proof.result.order.length
    && redraw.order.every((v, i) => v === proof.result.order[i]);
  if (!same) return fail(5, 'recomputed order differs from the published one');
  step(5, 'ok', { key: 'vd.winners', vars: { list: redraw.winners.join(', ') } });

  return { ok: true, proof, winners: redraw.winners };
}
