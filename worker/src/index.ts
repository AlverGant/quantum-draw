/**
 * sorteio-quantico — API do protocolo qdraw-v1.
 *
 * Rotas (todas em /api/*; o resto é servido pelo binding de assets):
 *
 *   POST /api/visit               registra a visita e devolve as estatísticas
 *   GET  /api/stats               contadores públicos
 *   GET  /api/pool                pool ativo (metadados + raiz de Merkle)
 *   GET  /api/draws               sorteios públicos recentes
 *   POST /api/draws               cria o sorteio (fase de compromisso)
 *   GET  /api/draws/:slug         estado do sorteio
 *   POST /api/draws/:slug/reveal  executa o sorteio (qualquer um, após a hora)
 *   GET  /api/draws/:slug/proof   pacote de prova completo
 *   POST /api/admin/pool          publica um pool novo (harvest.py)
 *
 * Nota de projeto: /reveal é aberto de propósito. Se só o operador pudesse
 * disparar o sorteio, ele teria a opção de simplesmente nunca disparar um
 * resultado que não gostou. Sendo qualquer pessoa capaz de executá-lo — e o
 * cron executando sozinho — não sobra discricionariedade nenhuma.
 */

import {
  commitHash,
  deriveSeed,
  fromHex,
  merkleProof,
  merkleRoot,
  normalizeParticipants,
  participantsHash,
  runDraw,
  sha256,
  timingSafeEqual,
  toHex,
  utf8,
  verifyProof,
  type ProofStep,
} from './protocol.ts';
import { QUICKNET, fetchRound, roundAt, timeOfRound } from './drand.ts';
import { IbmClient, buildQasm3, samplesToBits, type PubSpec } from './ibm.ts';
import { buildPool, rawBitsNeeded, type BuiltPool } from './harvest.ts';
import { CHSH_SETTINGS, chshPubs, chshScore } from './chsh.ts';
import {
  LOTTERIES,
  generate as generateLottery,
  lotteryCommitHash,
  validate as validateLottery,
} from './lottery.ts';

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ADMIN_TOKEN: string;
  VISITOR_SALT: string;
  LOCK_SECONDS: string;
  MAX_PARTICIPANTS: string;
  // Opcionais: sem eles o harvest automático fica desligado e o pool passa a
  // depender de publicação externa via POST /api/admin/pool.
  IBM_API_KEY?: string;
  IBM_CRN?: string;
  HARVEST_PULSES?: string;
  HARVEST_PERIOD?: string;
  HARVEST_MARGIN_SECONDS?: string;
  // Shots por par de bases do teste de Bell. "0" desliga o teste.
  CHSH_SHOTS?: string;
}

// ------------------------------------------------------------------ util

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  // A prova é feita para ser conferida por terceiros — inclusive por scripts
  // rodando em outros domínios. Liberar leitura é parte do produto.
  'access-control-allow-origin': '*',
};

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...JSON_HEADERS, ...extra },
  });
}

function fail(status: number, code: string, message: string): Response {
  return json({ error: code, message }, status);
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

const SLUG_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'; // Crockford: sem i, l, o, u

function newSlug(length = 10): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = '';
  for (const b of bytes) out += SLUG_ALPHABET[b % SLUG_ALPHABET.length];
  return out;
}

function randomHex(bytes: number): string {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

function utcDay(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

// --------------------------------------------------------------- estatísticas

interface Stats {
  pageviews: number;
  unique_visitors: number;
  draws_created: number;
  draws_completed: number;
  participants_total: number;
  countries: number;
}

async function readStats(env: Env): Promise<Stats> {
  const [counters, countries] = await env.DB.batch<{ key: string; value: number }>([
    env.DB.prepare('SELECT key, value FROM counters'),
    env.DB.prepare("SELECT 'countries' AS key, COUNT(*) AS value FROM countries"),
  ]);
  const map = new Map<string, number>();
  for (const row of [...(counters.results ?? []), ...(countries.results ?? [])]) {
    map.set(row.key, Number(row.value) || 0);
  }
  return {
    pageviews: map.get('pageviews') ?? 0,
    unique_visitors: map.get('unique_visitors') ?? 0,
    draws_created: map.get('draws_created') ?? 0,
    draws_completed: map.get('draws_completed') ?? 0,
    participants_total: map.get('participants_total') ?? 0,
    countries: map.get('countries') ?? 0,
  };
}

function bump(env: Env, key: string, by = 1): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO counters (key, value) VALUES (?1, ?2)
     ON CONFLICT(key) DO UPDATE SET value = value + ?2`,
  ).bind(key, by);
}

/**
 * Conta a visita. O identificador é hash(sal + dia + IP + user-agent)
 * truncado: não é reversível para o IP, e vira outro identificador amanhã.
 * Nenhum IP é gravado.
 */
async function handleVisit(request: Request, env: Env): Promise<Response> {
  const ts = now();
  const day = utcDay(ts);
  const ip = request.headers.get('CF-Connecting-IP') ?? '0.0.0.0';
  const ua = request.headers.get('user-agent') ?? '';
  const country = (request.headers.get('CF-IPCountry') ?? 'XX').toUpperCase().slice(0, 2);

  const visitor = toHex(await sha256(utf8(`${env.VISITOR_SALT}|${day}|${ip}|${ua}`))).slice(0, 32);

  const inserted = await env.DB.prepare(
    'INSERT OR IGNORE INTO visitors (day, visitor, country) VALUES (?, ?, ?)',
  )
    .bind(day, visitor, country)
    .run();

  const isNewToday = (inserted.meta?.changes ?? 0) > 0;
  const writes: D1PreparedStatement[] = [bump(env, 'pageviews')];
  if (isNewToday) {
    writes.push(bump(env, 'unique_visitors'));
    if (country !== 'XX' && country !== 'T1') {
      writes.push(
        env.DB.prepare(
          `INSERT INTO countries (code, count) VALUES (?1, 1)
           ON CONFLICT(code) DO UPDATE SET count = count + 1`,
        ).bind(country),
      );
    }
  }
  await env.DB.batch(writes);

  return json({ ...(await readStats(env)), country, new_visitor: isNewToday });
}

// ---------------------------------------------------------------- pools

interface PoolRow {
  id: string;
  merkle_root: string;
  genesis_time: number;
  period: number;
  pulse_count: number;
  source_json: string;
  created_at: number;
}

/** Pool mais recente que ainda tem pulso disponível em/depois de `targetTime`. */
async function activePool(env: Env, targetTime: number): Promise<PoolRow | null> {
  const { results } = await env.DB.prepare(
    'SELECT * FROM pools ORDER BY created_at DESC LIMIT 10',
  ).all<PoolRow>();
  for (const pool of results ?? []) {
    const lastReveal = pool.genesis_time + (pool.pulse_count - 1) * pool.period;
    if (lastReveal >= targetTime) return pool;
  }
  return null;
}

function pulseIndexFor(pool: PoolRow, targetTime: number): number {
  const raw = Math.ceil((targetTime - pool.genesis_time) / pool.period);
  return Math.min(Math.max(raw, 0), pool.pulse_count - 1);
}

async function handlePool(env: Env): Promise<Response> {
  const pool = await activePool(env, now());
  if (!pool) return fail(503, 'sem_pool', 'Nenhum pool de entropia ativo no momento.');
  const lastReveal = pool.genesis_time + (pool.pulse_count - 1) * pool.period;
  const consumed = Math.max(0, Math.min(pulseIndexFor(pool, now()), pool.pulse_count));
  return json({
    pool_id: pool.id,
    merkle_root: pool.merkle_root,
    genesis_time: pool.genesis_time,
    period: pool.period,
    pulse_count: pool.pulse_count,
    pulses_elapsed: consumed,
    exhausted_at: lastReveal,
    source: JSON.parse(pool.source_json),
    drand: { chain_hash: QUICKNET.chainHash, scheme: QUICKNET.scheme, period: QUICKNET.period },
    server_time: now(),
  });
}

function adminAuthorized(request: Request, env: Env): boolean {
  const auth = request.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return Boolean(env.ADMIN_TOKEN) && timingSafeEqual(token, env.ADMIN_TOKEN);
}

async function handleAdminPool(request: Request, env: Env): Promise<Response> {
  if (!adminAuthorized(request, env)) {
    return fail(401, 'nao_autorizado', 'Token de admin inválido.');
  }

  const body = (await request.json()) as {
    pool_id?: string;
    genesis_time?: number;
    period?: number;
    pulse_count?: number;
    merkle_root?: string;
    source?: unknown;
    pulses?: string[];
  };

  const { pool_id, genesis_time, period, merkle_root, pulses } = body;
  if (!pool_id || !genesis_time || !period || !merkle_root || !Array.isArray(pulses)) {
    return fail(400, 'payload_invalido', 'Campos obrigatórios ausentes.');
  }
  if (pulses.length === 0 || pulses.length > 5000) {
    return fail(400, 'payload_invalido', 'Pool precisa ter entre 1 e 5000 pulsos.');
  }

  // Recalcular a raiz aqui não é paranoia: se o pool subisse com uma raiz que
  // não corresponde aos pulsos, todo sorteio derivado dele geraria uma prova
  // que falha na verificação — e só descobriríamos com o sorteio já feito.
  let recomputed: string;
  try {
    recomputed = toHex(await merkleRoot(pulses.map(fromHex)));
  } catch (e) {
    return fail(400, 'pulsos_invalidos', (e as Error).message);
  }
  if (recomputed !== merkle_root.toLowerCase()) {
    return fail(400, 'raiz_divergente', `Raiz enviada ${merkle_root}, recalculada ${recomputed}.`);
  }

  await persistPool(env, {
    poolId: pool_id,
    merkleRoot: recomputed,
    genesisTime: genesis_time,
    period,
    pulses: pulses.map(fromHex),
    source: (body.source ?? {}) as Record<string, unknown>,
  });

  return json({
    ok: true,
    pool_id,
    merkle_root: recomputed,
    pulse_count: pulses.length,
    first_reveal: genesis_time,
    last_reveal: genesis_time + (pulses.length - 1) * period,
  });
}

/** Grava pool + pulsos. Usado tanto pelo upload externo quanto pelo cron. */
async function persistPool(env: Env, pool: BuiltPool): Promise<void> {
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT OR REPLACE INTO pools
         (id, merkle_root, genesis_time, period, pulse_count, source_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      pool.poolId,
      pool.merkleRoot,
      pool.genesisTime,
      pool.period,
      pool.pulses.length,
      JSON.stringify(pool.source),
      now(),
    ),
  ];
  const insertPulse = env.DB.prepare(
    'INSERT OR REPLACE INTO pulses (pool_id, idx, value) VALUES (?, ?, ?)',
  );
  pool.pulses.forEach((value, idx) =>
    statements.push(insertPulse.bind(pool.poolId, idx, toHex(value))),
  );

  // D1 limita o tamanho do batch; 500 por vez passa com folga.
  for (let i = 0; i < statements.length; i += 500) {
    await env.DB.batch(statements.slice(i, i + 500));
  }
}

// ------------------------------------------------------- harvest automático

interface HarvestRow {
  status: string;
  job_id: string | null;
  backend: string | null;
  shots: number | null;
  qubits: number | null;
  pulses: number | null;
  period: number | null;
  submitted_at: number | null;
  last_check: number | null;
  last_error: string | null;
  last_success: number | null;
  charged_seconds: number | null;
  failures: number;
  retry_after: number | null;
  chsh_json: string | null;
}

/** O que foi submetido de CHSH neste job, para saber ler os PUBs na volta. */
interface ChshPlan {
  pair: [number, number];
  shots: number;
  /** Rótulos na ordem dos PUBs; o comprimento diz quantos PUBs pular. */
  labels: string[];
}

const HARVEST_DEFAULTS = { pulses: 1440, period: 60, margin: 6 * 3600 };
/**
 * Shots por par de bases do teste de Bell — quatro pares, então 4x isto de
 * shots a mais no job. Com 2.048, σ_S ≈ 0,044: uma violação de hardware típica
 * (S ≈ 2,5) fica a mais de 10σ do teto clássico, o que já é conclusivo. Subir
 * não compra quase nada de certeza e sai direto do orçamento de QPU, que é o
 * recurso escasso aqui.
 */
const CHSH_SHOTS_DEFAULT = 2048;
// Um job que não termina em 2h está travado na fila; melhor desistir e tentar
// outro backend do que ficar preso para sempre esperando.
const HARVEST_JOB_TIMEOUT = 2 * 3600;
// Backoff exponencial a partir de 15 min, teto de 4h. Depois de 5 falhas
// seguidas o harvest para de tentar sozinho e exige ?force=1 — o problema
// provavelmente não é transitório, e cada tentativa pode custar QPU.
const HARVEST_BACKOFF = [900, 1800, 3600, 7200, 14400];
const HARVEST_MAX_FAILURES = 5;

async function harvestState(env: Env): Promise<HarvestRow | null> {
  return env.DB.prepare('SELECT * FROM harvest_state WHERE id = 1').first<HarvestRow>();
}

async function harvestError(env: Env, message: string, failures: number): Promise<void> {
  console.error('harvest:', message);
  const n = failures + 1;
  const wait = HARVEST_BACKOFF[Math.min(n - 1, HARVEST_BACKOFF.length - 1)];
  await env.DB.prepare(
    `UPDATE harvest_state SET status='idle', job_id=NULL, last_error=?, last_check=?,
       failures=?, retry_after=? WHERE id=1`,
  )
    .bind(message.slice(0, 500), now(), n, now() + wait)
    .run();
}

/**
 * Um passo da máquina de estados, chamado a cada tick do cron.
 *
 * idle      -> se nenhum pool cobre agora+margem, submete um job e vai para submitted
 * submitted -> faz polling; quando o job completa, monta o pool e volta para idle
 *
 * Só há um job em voo por vez, o que também protege o orçamento de QPU: sem o
 * estado persistido, cada tick de 5 minutos abriria um job novo e queimaria os
 * 10 minutos mensais numa tarde.
 */
async function harvestTick(env: Env, force = false): Promise<void> {
  if (!env.IBM_API_KEY || !env.IBM_CRN) return; // harvest automático desligado

  const ts = now();
  const st = await harvestState(env);
  const client = new IbmClient({ apiKey: env.IBM_API_KEY, crn: env.IBM_CRN });

  if (st?.status === 'submitted' && st.job_id) {
    let info: { status: string; charged: number | null };
    try {
      info = await client.job(st.job_id);
    } catch (e) {
      // Falha de rede no polling não deve perder o job: só registra e tenta
      // no próximo tick.
      console.error('harvest: polling falhou', e);
      await env.DB.prepare('UPDATE harvest_state SET last_check=?, last_error=? WHERE id=1')
        .bind(ts, `polling: ${(e as Error).message}`.slice(0, 500))
        .run();
      return;
    }

    if (info.status === 'Completed') {
      try {
        const pubs = await client.results(st.job_id);
        const { raw, nBits } = samplesToBits(pubs[0], st.qubits ?? 0);
        const chsh = readChsh(st, pubs);
        const pool = await buildPool(raw, nBits, st.pulses ?? HARVEST_DEFAULTS.pulses,
          st.period ?? HARVEST_DEFAULTS.period, {
            provider: 'ibm_quantum',
            backend: st.backend,
            qubits: st.qubits,
            job_ids: [st.job_id],
            circuit: 'H^n + measure',
            shots: st.shots,
            charged_seconds: info.charged,
            captured_at: ts,
            harvested_by: 'cloudflare-cron',
            chsh,
          });
        await persistPool(env, pool);
        if (chsh && !chsh.violates) {
          // Não bloqueia o pool: sem pool o site inteiro cai em 503, e o teste
          // é evidência publicada junto da entropia, não um portão na frente
          // dela. Quem lê a prova vê o S e julga sozinho.
          console.error(
            `harvest: CHSH sem violação (S=${chsh.s} ± ${chsh.sigma}) — pool publicado assim mesmo`,
          );
        }
        await env.DB.prepare(
          `UPDATE harvest_state SET status='idle', job_id=NULL, last_error=NULL,
             last_success=?, charged_seconds=?, last_check=?, failures=0, retry_after=NULL
           WHERE id=1`,
        )
          .bind(ts, info.charged, ts)
          .run();
        console.log(
          `harvest: pool ${pool.poolId} publicado (${pool.pulses.length} pulsos, ` +
            `${info.charged}s de QPU${chsh ? `, CHSH S=${chsh.s}` : ''})`,
        );
      } catch (e) {
        // O QPU já foi gasto neste job. Voltar para idle faria o próximo tick
        // submeter outro; o backoff garante que uma falha de montagem não vire
        // uma torneira aberta de jobs.
        await harvestError(env, `montagem do pool: ${(e as Error).message}`, st.failures);
      }
      return;
    }

    if (info.status === 'Failed' || info.status === 'Cancelled') {
      await harvestError(env, `job ${st.job_id} terminou como ${info.status}`, st.failures);
      return;
    }

    if (st.submitted_at && ts - st.submitted_at > HARVEST_JOB_TIMEOUT) {
      await harvestError(env, `job ${st.job_id} passou de ${HARVEST_JOB_TIMEOUT}s em '${info.status}'`, st.failures);
      return;
    }

    await env.DB.prepare('UPDATE harvest_state SET last_check=? WHERE id=1').bind(ts).run();
    return;
  }

  const failures = st?.failures ?? 0;
  if (!force) {
    if (failures >= HARVEST_MAX_FAILURES) {
      console.error(`harvest: parado após ${failures} falhas seguidas; use ?force=1 para retomar`);
      return;
    }
    if (st?.retry_after && ts < st.retry_after) return; // em backoff

    // Ocioso: só submete se o pool atual não cobrir a janela de segurança.
    const margin = Number(env.HARVEST_MARGIN_SECONDS) || HARVEST_DEFAULTS.margin;
    if (await activePool(env, ts + margin)) return;
  }

  const pulses = Number(env.HARVEST_PULSES) || HARVEST_DEFAULTS.pulses;
  const period = Number(env.HARVEST_PERIOD) || HARVEST_DEFAULTS.period;

  try {
    const backend = await client.leastBusy();
    const config = await client.configuration(backend);
    const qubits = config.n_qubits;
    const shots = Math.ceil(rawBitsNeeded(pulses) / qubits);
    if (shots > config.max_shots) {
      throw new Error(`preciso de ${shots} shots, backend aceita ${config.max_shots}`);
    }

    const pubs: PubSpec[] = [{ qasm: buildQasm3(qubits), shots }];
    // Um CHSH_SHOTS acima do teto do backend faria a IBM recusar o job inteiro,
    // entropia junto — o teste nunca pode custar isso.
    const chshShots = Math.min(Number(env.CHSH_SHOTS ?? CHSH_SHOTS_DEFAULT), config.max_shots);
    const plan = await planChsh(client, backend, config, chshShots);
    if (plan) pubs.push(...chshPubs(plan.pair, plan.shots));

    const jobId = await client.submitSampler(backend, pubs);
    await env.DB.prepare(
      `UPDATE harvest_state SET status='submitted', job_id=?, backend=?, shots=?, qubits=?,
         pulses=?, period=?, submitted_at=?, last_check=?, last_error=NULL, chsh_json=? WHERE id=1`,
    )
      .bind(jobId, backend, shots, qubits, pulses, period, ts, ts, plan ? JSON.stringify(plan) : null)
      .run();
    console.log(
      `harvest: job ${jobId} submetido em ${backend} (${shots} shots x ${qubits} qubits` +
        `${plan ? `, + CHSH em [${plan.pair}] com ${plan.shots} shots x 4 bases` : ', sem CHSH'})`,
    );
  } catch (e) {
    await harvestError(env, `submissão: ${(e as Error).message}`, failures);
  }
}

/**
 * Escolhe o par de qubits do teste de Bell, ou null para submeter só a entropia.
 *
 * Toda falha aqui é engolida de propósito: o teste é um acréscimo à prova, e
 * derrubar a colheita de entropia por causa dele inverteria as prioridades —
 * ficaríamos sem pool, e o site sem pool devolve 503.
 */
async function planChsh(
  client: IbmClient,
  backend: string,
  config: { basis_gates: string[]; coupling_map: number[][] },
  shots: number,
): Promise<ChshPlan | null> {
  if (!Number.isFinite(shots) || shots <= 0) return null;
  try {
    // O circuito emaranha com cz. Num backend cujo par nativo seja outro (a
    // família Eagle usa ecr), o QASM não seria ISA e a IBM recusaria o job
    // inteiro — junto com a entropia. Melhor sair fora do que arriscar isso.
    if (!config.basis_gates.includes('cz')) {
      console.error(`CHSH: ${backend} não tem cz nativa (${config.basis_gates.join(',')}), pulando`);
      return null;
    }
    const pair = await client.bestPair(backend, config.coupling_map);
    if (!pair) {
      console.error(`CHSH: ${backend} não expôs mapa de acoplamento, pulando`);
      return null;
    }
    return { pair, shots, labels: CHSH_SETTINGS.map((s) => s.label) };
  } catch (e) {
    console.error('CHSH: planejamento falhou, seguindo só com a entropia', e);
    return null;
  }
}

/** Laudo do teste de Bell a partir dos PUBs que vieram depois o da entropia. */
function readChsh(st: HarvestRow, pubs: string[][]): ReturnType<typeof chshScore> | null {
  if (!st.chsh_json) return null;
  try {
    const plan = JSON.parse(st.chsh_json) as ChshPlan;
    const samples = pubs.slice(1, 1 + plan.labels.length);
    return chshScore(plan.pair, samples);
  } catch (e) {
    // Idem: o pool já custou o QPU deste job e não depende do teste. Perder o
    // laudo é um pool sem CHSH; deixar a exceção subir seria um pool a menos.
    console.error('CHSH: laudo não pôde ser calculado', e);
    return null;
  }
}

// ---------------------------------------------------------------- sorteios

interface DrawRow {
  id: string;
  slug: string;
  kind: string;
  lottery_json: string | null;
  title: string;
  participants_json: string;
  participants_hash: string;
  participant_count: number;
  winners_count: number;
  client_nonce: string;
  commit_hash: string;
  pool_id: string;
  pulse_index: number;
  drand_round: number;
  reveal_time: number;
  status: string;
  is_public: number;
  locale: string | null;
  created_at: number;
  drawn_at: number | null;
  pulse_value: string | null;
  drand_signature: string | null;
  drand_randomness: string | null;
  seed: string | null;
  winners_json: string | null;
  order_json: string | null;
  merkle_proof_json: string | null;
}

async function rateLimited(env: Env, request: Request): Promise<boolean> {
  const ip = request.headers.get('CF-Connecting-IP') ?? '0.0.0.0';
  const hour = Math.floor(now() / 3600);
  const bucket = toHex(await sha256(utf8(`${env.VISITOR_SALT}|rl|${hour}|${ip}`))).slice(0, 24);
  const expires = (hour + 1) * 3600;
  await env.DB.prepare(
    `INSERT INTO rate_limit (bucket, count, expires_at) VALUES (?1, 1, ?2)
     ON CONFLICT(bucket) DO UPDATE SET count = count + 1`,
  )
    .bind(bucket, expires)
    .run();
  const row = await env.DB.prepare('SELECT count FROM rate_limit WHERE bucket = ?')
    .bind(bucket)
    .first<{ count: number }>();
  return (row?.count ?? 0) > 30;
}

async function handleCreateDraw(request: Request, env: Env): Promise<Response> {
  if (await rateLimited(env, request)) {
    return fail(429, 'limite_excedido', 'Muitos sorteios criados desta origem. Tente em uma hora.');
  }

  let body: {
    kind?: string;
    title?: string;
    participants?: unknown;
    winners_count?: number;
    lottery?: string;
    games?: number;
    picks?: number;
    extra_picks?: number;
    is_public?: boolean;
    locale?: string;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return fail(400, 'json_invalido', 'Corpo da requisição não é JSON válido.');
  }

  const kind = body.kind === 'lottery' ? 'lottery' : 'list';
  // Título é opcional: obrigar a nomear "sorteio de quê" só atrapalha quem só
  // quer números. Entra no compromisso do mesmo jeito, vazio ou não.
  const title = String(body.title ?? '').trim().slice(0, 140);

  // Entrada específica de cada tipo. `participants` fica vazio na loteria e
  // `lotteryCfg` fica nulo no sorteio de lista.
  let participants: string[] = [];
  let lotteryCfg: { lottery: string; games: number; picks: number; extra_picks: number } | null = null;
  let winnersCount: number;

  if (kind === 'lottery') {
    const lotteryId = String(body.lottery ?? '');
    const games = Math.trunc(Number(body.games ?? 1));
    try {
      const v = validateLottery(lotteryId, games, body.picks, body.extra_picks);
      lotteryCfg = { lottery: lotteryId, games, picks: v.picks, extra_picks: v.extraPicks };
    } catch (e) {
      return fail(400, 'loteria_invalida', (e as Error).message);
    }
    // Numa loteria, "vencedores" são os jogos gerados.
    winnersCount = games;
  } else {
    const rawList = Array.isArray(body.participants)
      ? (body.participants as unknown[]).map(String)
      : String(body.participants ?? '').split('\n');
    participants = normalizeParticipants(rawList);

    const maxParticipants = Number(env.MAX_PARTICIPANTS) || 20000;
    if (participants.length < 2) {
      return fail(400, 'poucos_participantes', 'São necessários ao menos 2 participantes.');
    }
    if (participants.length > maxParticipants) {
      return fail(400, 'muitos_participantes', `Máximo de ${maxParticipants} participantes.`);
    }

    winnersCount = Math.trunc(Number(body.winners_count ?? 1));
    if (!Number.isFinite(winnersCount) || winnersCount < 1 || winnersCount > participants.length) {
      return fail(400, 'vencedores_invalido', 'Número de vencedores fora do intervalo.');
    }
  }

  const lock = Number(env.LOCK_SECONDS) || 120;
  const targetTime = now() + lock;
  const pool = await activePool(env, targetTime);
  if (!pool) {
    return fail(503, 'sem_pool', 'Nenhum pool de entropia com pulsos futuros disponíveis.');
  }

  const pulseIndex = pulseIndexFor(pool, targetTime);
  const revealTime = pool.genesis_time + pulseIndex * pool.period;
  const drandRound = roundAt(revealTime);

  // Se o round já existir, a aleatoriedade já é pública e o compromisso não
  // vale nada. Melhor recusar do que emitir uma prova enganosa.
  if (timeOfRound(drandRound) <= now()) {
    return fail(503, 'janela_curta', 'A janela de bloqueio ficou no passado. Tente de novo.');
  }

  const clientNonce = randomHex(16);

  // Compromissos com separadores de domínio distintos: um commit de loteria
  // nunca pode ser reinterpretado como um de lista, nem vice-versa.
  const commit = lotteryCfg
    ? await lotteryCommitHash({
        title,
        lotteryId: lotteryCfg.lottery,
        games: lotteryCfg.games,
        picks: lotteryCfg.picks,
        extraPicks: lotteryCfg.extra_picks,
        clientNonce,
        poolId: pool.id,
        pulseIndex,
        drandRound,
      })
    : await commitHash({
        title, participants, winnersCount, clientNonce,
        poolId: pool.id, pulseIndex, drandRound,
      });

  // Hash da entrada: a lista de participantes ou a configuração do jogo.
  const inputHash = lotteryCfg
    ? await sha256(utf8('qdraw/v1/lottery-config\n'), utf8(JSON.stringify(lotteryCfg)))
    : await participantsHash(participants);

  const slug = newSlug();
  const id = crypto.randomUUID();
  const ts = now();
  const inputCount = lotteryCfg ? lotteryCfg.games : participants.length;

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO draws (
         id, slug, kind, lottery_json, title, participants_json, participants_hash,
         participant_count, winners_count, client_nonce, commit_hash, pool_id,
         pulse_index, drand_round, reveal_time, status, is_public, locale, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'committed', ?, ?, ?)`,
    ).bind(
      id,
      slug,
      kind,
      lotteryCfg ? JSON.stringify(lotteryCfg) : null,
      title,
      JSON.stringify(participants),
      toHex(inputHash),
      inputCount,
      winnersCount,
      clientNonce,
      toHex(commit),
      pool.id,
      pulseIndex,
      drandRound,
      revealTime,
      // Privado por padrão: publicar a lista de alguém sem que a pessoa tenha
      // pedido é o tipo de default que não se conserta depois.
      body.is_public === true ? 1 : 0,
      String(body.locale ?? '').slice(0, 8) || null,
      ts,
    ),
    bump(env, 'draws_created'),
    bump(env, 'participants_total', inputCount),
  ]);

  const row = await env.DB.prepare('SELECT * FROM draws WHERE slug = ?').bind(slug).first<DrawRow>();
  return json(await presentDraw(env, row!), 201);
}

/** Serializa o sorteio, escondendo o pulso enquanto ele não for revelável. */
async function presentDraw(env: Env, row: DrawRow): Promise<Record<string, unknown>> {
  const pool = await env.DB.prepare('SELECT * FROM pools WHERE id = ?')
    .bind(row.pool_id)
    .first<PoolRow>();

  const base: Record<string, unknown> = {
    slug: row.slug,
    kind: row.kind,
    lottery: row.lottery_json ? JSON.parse(row.lottery_json) : null,
    title: row.title,
    status: row.status,
    participants: JSON.parse(row.participants_json),
    participant_count: row.participant_count,
    winners_count: row.winners_count,
    locale: row.locale,
    created_at: row.created_at,
    server_time: now(),
    commitment: {
      commit_hash: row.commit_hash,
      participants_hash: row.participants_hash,
      client_nonce: row.client_nonce,
      pool_id: row.pool_id,
      merkle_root: pool?.merkle_root ?? null,
      pulse_index: row.pulse_index,
      drand_round: row.drand_round,
      drand_chain_hash: QUICKNET.chainHash,
      reveal_time: row.reveal_time,
    },
  };

  if (row.status === 'drawn') {
    const produced = JSON.parse(row.winners_json ?? '[]');
    base.result = {
      // Em 'lottery' o campo carrega os jogos gerados; em 'list', os nomes.
      winners: row.kind === 'lottery' ? [] : produced,
      games: row.kind === 'lottery' ? produced : [],
      order: JSON.parse(row.order_json ?? '[]'),
      drawn_at: row.drawn_at,
    };
    base.proof = {
      pulse_value: row.pulse_value,
      merkle_proof: JSON.parse(row.merkle_proof_json ?? '[]'),
      drand_signature: row.drand_signature,
      drand_randomness: row.drand_randomness,
      seed: row.seed,
    };
  } else {
    base.seconds_remaining = Math.max(0, row.reveal_time - now());
  }
  return base;
}

/**
 * Executa o sorteio. Idempotente e sem autenticação: depois do reveal_time o
 * resultado é uma função determinística de dados públicos, então quem chama
 * não muda nada.
 */
async function executeDraw(env: Env, row: DrawRow): Promise<{ ok: true } | { ok: false; response: Response }> {
  if (row.status === 'drawn') return { ok: true };
  if (now() < row.reveal_time) {
    return {
      ok: false,
      response: fail(
        425,
        'cedo_demais',
        `O pulso quântico deste sorteio só é revelado em ${row.reveal_time - now()}s.`,
      ),
    };
  }

  const pool = await env.DB.prepare('SELECT * FROM pools WHERE id = ?')
    .bind(row.pool_id)
    .first<PoolRow>();
  if (!pool) return { ok: false, response: fail(500, 'pool_ausente', 'Pool do sorteio sumiu.') };

  const { results: pulseRows } = await env.DB.prepare(
    'SELECT idx, value FROM pulses WHERE pool_id = ? ORDER BY idx ASC',
  )
    .bind(row.pool_id)
    .all<{ idx: number; value: string }>();
  const pulses = (pulseRows ?? []).map((p) => fromHex(p.value));
  if (pulses.length !== pool.pulse_count) {
    return { ok: false, response: fail(500, 'pool_incompleto', 'Pool com pulsos faltando.') };
  }

  const pulse = pulses[row.pulse_index];
  const proof: ProofStep[] = await merkleProof(pulses, row.pulse_index);
  const rootOk = await verifyProof(row.pulse_index, pulse, proof, fromHex(pool.merkle_root));
  if (!rootOk) {
    return { ok: false, response: fail(500, 'merkle_invalido', 'Prova de Merkle não fecha.') };
  }

  let beacon;
  try {
    beacon = await fetchRound(row.drand_round);
  } catch (e) {
    return { ok: false, response: fail(503, 'drand_indisponivel', (e as Error).message) };
  }

  const participants: string[] = JSON.parse(row.participants_json);
  const lotteryCfg = row.lottery_json
    ? (JSON.parse(row.lottery_json) as { lottery: string; games: number; picks: number; extra_picks: number })
    : null;

  // Recomputar o compromisso a partir do que está gravado detecta qualquer
  // adulteração da entrada entre o commit e o sorteio — inclusive nossa.
  const recommitted = toHex(
    lotteryCfg
      ? await lotteryCommitHash({
          title: row.title,
          lotteryId: lotteryCfg.lottery,
          games: lotteryCfg.games,
          picks: lotteryCfg.picks,
          extraPicks: lotteryCfg.extra_picks,
          clientNonce: row.client_nonce,
          poolId: row.pool_id,
          pulseIndex: row.pulse_index,
          drandRound: row.drand_round,
        })
      : await commitHash({
          title: row.title,
          participants,
          winnersCount: row.winners_count,
          clientNonce: row.client_nonce,
          poolId: row.pool_id,
          pulseIndex: row.pulse_index,
          drandRound: row.drand_round,
        }),
  );
  if (recommitted !== row.commit_hash) {
    return {
      ok: false,
      response: fail(500, 'commit_divergente', 'A entrada não confere com o compromisso publicado.'),
    };
  }

  const randomness = await sha256(fromHex(beacon.signature));

  // A semente é derivada exatamente igual nos dois tipos; só o que se faz com
  // ela difere — embaralhar a lista ou tirar dezenas do intervalo.
  let result: { seed: string; order: string[]; winners: string[] };
  if (lotteryCfg) {
    const seed = await deriveSeed(fromHex(row.commit_hash), pulse, randomness);
    const games = await generateLottery(
      lotteryCfg.lottery, lotteryCfg.games, lotteryCfg.picks, lotteryCfg.extra_picks, seed);
    result = { seed: toHex(seed), order: [], winners: games as unknown as string[] };
  } else {
    result = await runDraw(participants, row.winners_count, fromHex(row.commit_hash), pulse, randomness);
  }

  const updated = await env.DB.prepare(
    `UPDATE draws SET
       status = 'drawn', drawn_at = ?, pulse_value = ?, drand_signature = ?,
       drand_randomness = ?, seed = ?, winners_json = ?, order_json = ?, merkle_proof_json = ?
     WHERE id = ? AND status = 'committed'`,
  )
    .bind(
      now(),
      toHex(pulse),
      beacon.signature,
      toHex(randomness),
      result.seed,
      JSON.stringify(result.winners),
      JSON.stringify(result.order),
      JSON.stringify(proof),
      row.id,
    )
    .run();

  // changes === 0 significa que outra requisição chegou primeiro. Como o
  // resultado é determinístico, o dela é idêntico ao nosso — nada a fazer.
  if ((updated.meta?.changes ?? 0) > 0) {
    await env.DB.batch([bump(env, 'draws_completed')]);
  }
  return { ok: true };
}

async function handleReveal(env: Env, slug: string): Promise<Response> {
  const row = await env.DB.prepare('SELECT * FROM draws WHERE slug = ?').bind(slug).first<DrawRow>();
  if (!row) return fail(404, 'nao_encontrado', 'Sorteio inexistente.');

  const outcome = await executeDraw(env, row);
  if (!outcome.ok) return outcome.response;

  const fresh = await env.DB.prepare('SELECT * FROM draws WHERE slug = ?').bind(slug).first<DrawRow>();
  return json(await presentDraw(env, fresh!));
}

async function handleProof(env: Env, slug: string): Promise<Response> {
  const row = await env.DB.prepare('SELECT * FROM draws WHERE slug = ?').bind(slug).first<DrawRow>();
  if (!row) return fail(404, 'nao_encontrado', 'Sorteio inexistente.');
  if (row.status !== 'drawn') {
    return fail(409, 'nao_sorteado', 'Sorteio ainda não foi realizado.');
  }
  const pool = await env.DB.prepare('SELECT * FROM pools WHERE id = ?')
    .bind(row.pool_id)
    .first<PoolRow>();

  return json(
    {
      protocol: 'qdraw-v1',
      slug: row.slug,
      kind: row.kind,
      title: row.title,
      how_to_verify: 'https://sorteio.vynstream.com/verificar?s=' + row.slug,
      commitment: {
        commit_hash: row.commit_hash,
        participants_hash: row.participants_hash,
        client_nonce: row.client_nonce,
        winners_count: row.winners_count,
        participant_count: row.participant_count,
        created_at: row.created_at,
      },
      lottery: row.lottery_json ? JSON.parse(row.lottery_json) : null,
      participants: JSON.parse(row.participants_json),
      quantum: {
        pool_id: row.pool_id,
        merkle_root: pool?.merkle_root,
        pulse_index: row.pulse_index,
        pulse_value: row.pulse_value,
        merkle_proof: JSON.parse(row.merkle_proof_json ?? '[]'),
        source: pool ? JSON.parse(pool.source_json) : null,
      },
      drand: {
        chain_hash: QUICKNET.chainHash,
        scheme: QUICKNET.scheme,
        round: row.drand_round,
        signature: row.drand_signature,
        randomness: row.drand_randomness,
        independent_url: `https://api.drand.sh/v2/chains/${QUICKNET.chainHash}/rounds/${row.drand_round}`,
      },
      result: {
        seed: row.seed,
        order: JSON.parse(row.order_json ?? '[]'),
        winners: row.kind === 'lottery' ? [] : JSON.parse(row.winners_json ?? '[]'),
        games: row.kind === 'lottery' ? JSON.parse(row.winners_json ?? '[]') : [],
        drawn_at: row.drawn_at,
      },
    },
    200,
    { 'content-disposition': `inline; filename="prova-${row.slug}.json"` },
  );
}

async function handleRecent(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT slug, kind, lottery_json, title, participant_count, winners_count,
            winners_json, drawn_at
     FROM draws WHERE is_public = 1 AND status = 'drawn'
     ORDER BY drawn_at DESC LIMIT 12`,
  ).all<{
    slug: string;
    kind: string;
    lottery_json: string | null;
    title: string;
    participant_count: number;
    winners_count: number;
    winners_json: string;
    drawn_at: number;
  }>();
  return json({
    draws: (results ?? []).map((r) => {
      const produced = JSON.parse(r.winners_json ?? '[]');
      return {
        slug: r.slug,
        kind: r.kind,
        lottery: r.lottery_json ? JSON.parse(r.lottery_json) : null,
        title: r.title,
        participant_count: r.participant_count,
        winners_count: r.winners_count,
        winners: r.kind === 'lottery' ? [] : produced.slice(0, 3),
        games: r.kind === 'lottery' ? produced.slice(0, 1) : [],
        drawn_at: r.drawn_at,
      };
    }),
  });
}

// ------------------------------------------------------------------ router

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method.toUpperCase();

  if (method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type, authorization',
        'access-control-max-age': '86400',
      },
    });
  }

  if (path === '/api/health') return json({ ok: true, time: now() });
  if (path === '/api/stats' && method === 'GET') return json(await readStats(env));
  if (path === '/api/visit' && method === 'POST') return handleVisit(request, env);
  if (path === '/api/pool' && method === 'GET') return handlePool(env);
  // Catálogo das modalidades: o front monta os limites do formulário a partir
  // daqui, para não duplicar as regras da Caixa no cliente.
  if (path === '/api/lotteries' && method === 'GET') return json({ lotteries: LOTTERIES });
  if (path === '/api/draws' && method === 'GET') return handleRecent(env);
  if (path === '/api/draws' && method === 'POST') return handleCreateDraw(request, env);
  if (path === '/api/admin/pool' && method === 'POST') return handleAdminPool(request, env);

  if (path === '/api/admin/harvest') {
    if (!adminAuthorized(request, env)) {
      return fail(401, 'nao_autorizado', 'Token de admin inválido.');
    }
    if (method === 'POST') {
      // Força um tick agora, sem esperar o cron. Se um job já estiver em voo,
      // o tick apenas faz o polling dele — nunca abre um segundo, mesmo com
      // ?force=1, o que protege o orçamento de QPU de cliques repetidos.
      await harvestTick(env, url.searchParams.get('force') === '1');
    }
    if (method === 'GET' || method === 'POST') {
      const st = await harvestState(env);
      const pool = await activePool(env, now());
      return json({
        harvest: st,
        enabled: Boolean(env.IBM_API_KEY && env.IBM_CRN),
        server_time: now(),
        active_pool: pool
          ? {
              pool_id: pool.id,
              exhausted_at: pool.genesis_time + (pool.pulse_count - 1) * pool.period,
              seconds_left: pool.genesis_time + (pool.pulse_count - 1) * pool.period - now(),
            }
          : null,
      });
    }
    return fail(405, 'metodo_invalido', `${method} não é aceito nesta rota.`);
  }

  const drawMatch = path.match(/^\/api\/draws\/([0-9a-z]{4,32})(\/reveal|\/proof)?$/);
  if (drawMatch) {
    const [, slug, action] = drawMatch;
    if (action === '/reveal' && method === 'POST') return handleReveal(env, slug);
    if (action === '/proof' && method === 'GET') return handleProof(env, slug);
    if (!action && method === 'GET') {
      const row = await env.DB.prepare('SELECT * FROM draws WHERE slug = ?')
        .bind(slug)
        .first<DrawRow>();
      if (!row) return fail(404, 'nao_encontrado', 'Sorteio inexistente.');
      // Se a hora já passou e ninguém disparou, resolve agora mesmo.
      if (row.status === 'committed' && now() >= row.reveal_time) {
        const outcome = await executeDraw(env, row);
        if (outcome.ok) {
          const fresh = await env.DB.prepare('SELECT * FROM draws WHERE slug = ?')
            .bind(slug)
            .first<DrawRow>();
          return json(await presentDraw(env, fresh!));
        }
      }
      return json(await presentDraw(env, row));
    }
    return fail(405, 'metodo_invalido', `${method} não é aceito nesta rota.`);
  }

  return fail(404, 'rota_desconhecida', `${method} ${path} não existe.`);
}

/** Serve um arquivo específico do bundle de assets, com status próprio. */
async function serveAsset(env: Env, request: Request, path: string, status: number,
                          extra: Record<string, string> = {}): Promise<Response> {
  const target = new URL(request.url);
  target.pathname = path;
  const res = await env.ASSETS.fetch(new Request(target.toString(), { method: 'GET' }));
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(res.body, { status, headers });
}

/**
 * Página de sorteio. O conteúdo é montado no cliente, mas o *status* precisa
 * ser honesto: código inexistente é 404, não 200 com uma página vazia. Só o
 * banco sabe a diferença, por isso esta rota passa pelo Worker.
 */
async function handleDrawPage(request: Request, env: Env, slug: string): Promise<Response> {
  const row = await env.DB.prepare('SELECT 1 AS ok FROM draws WHERE slug = ?')
    .bind(slug)
    .first<{ ok: number }>();
  if (!row) return serveAsset(env, request, '/404.html', 404);
  // Sorteios são conteúdo de usuário: fora do índice, mas os links da página
  // seguem valendo. Como cabeçalho, vale mesmo sem o visitante executar JS.
  return serveAsset(env, request, '/index.html', 200, { 'x-robots-tag': 'noindex, follow' });
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    const drawPage = url.pathname.match(/^\/s\/([0-9a-z]{4,32})\/?$/i);
    if (drawPage) {
      try {
        return await handleDrawPage(request, env, drawPage[1].toLowerCase());
      } catch (e) {
        console.error('falha ao servir página de sorteio', e);
        return serveAsset(env, request, '/index.html', 200);
      }
    }
    // /s/ com formato inválido nunca foi um sorteio.
    if (url.pathname.startsWith('/s/')) return serveAsset(env, request, '/404.html', 404);

    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await route(request, env);
    } catch (e) {
      console.error('erro não tratado', e);
      return fail(500, 'erro_interno', (e as Error).message);
    }
  },

  /**
   * Rede de segurança: sorteios cuja hora chegou mas que ninguém abriu.
   * Sem isto, um sorteio só sairia quando alguém visitasse a página — o que
   * daria a impressão de que o operador escolhe quando revelar.
   */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        const { results } = await env.DB.prepare(
          `SELECT * FROM draws WHERE status = 'committed' AND reveal_time <= ?
           ORDER BY reveal_time ASC LIMIT 25`,
        )
          .bind(now())
          .all<DrawRow>();
        for (const row of results ?? []) {
          try {
            await executeDraw(env, row);
          } catch (e) {
            console.error(`falha ao sortear ${row.slug}`, e);
          }
        }
        await env.DB.prepare('DELETE FROM rate_limit WHERE expires_at < ?').bind(now()).run();

        // Renova o pool de entropia antes que ele esgote. Roda depois dos
        // sorteios de propósito: se a IBM estiver fora do ar, os sorteios já
        // comprometidos ainda saem.
        try {
          await harvestTick(env);
        } catch (e) {
          console.error('harvest: falha não tratada', e);
        }
      })(),
    );
  },
};
