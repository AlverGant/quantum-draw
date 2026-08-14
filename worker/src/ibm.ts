/**
 * Cliente da IBM Quantum via REST puro — sem Qiskit, sem SDK, só fetch().
 *
 * Isto só é possível porque o circuito de que precisamos é o mais simples que
 * existe: Hadamard em todos os qubits e mede. Como o H atua em cada qubit
 * isoladamente, não há roteamento nem mapa de acoplamento a resolver — a
 * "transpilação" é uma reescrita local que cabe num laço:
 *
 *     H  ->  rz(pi/2) . sx . rz(pi/2)
 *
 * (as portas nativas do Heron são cz, id, rz, sx, x — H não é uma delas).
 *
 * O teste de Bell anexado ao mesmo job (ver chsh.ts) é a única exceção: ele
 * emaranha, e por isso precisa de um par de qubits que já seja vizinho no mapa
 * de acoplamento. Continua sem exigir roteamento — `bestPair` escolhe uma
 * aresta que existe no hardware, e um circuito de dois qubits adjacentes não
 * tem o que rotear. É o máximo que dá para fazer sem transpilador de verdade.
 */

const IAM_URL = 'https://iam.cloud.ibm.com/identity/token';
const API = 'https://quantum.cloud.ibm.com/api/v1';
// A API da IBM fica atrás de CDN e recusa clientes sem User-Agent com 403.
const UA = 'qdraw-worker/1.0 (+https://sorteio.vynstream.com)';

export interface IbmAuth {
  apiKey: string;
  crn: string;
}

async function iamToken(apiKey: string): Promise<string> {
  const res = await fetch(IAM_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA },
    body: new URLSearchParams({
      grant_type: 'urn:ibm:params:oauth:grant-type:apikey',
      apikey: apiKey,
    }),
  });
  if (!res.ok) throw new Error(`IAM ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) throw new Error('IAM não devolveu access_token');
  return body.access_token;
}

/** Sessão autenticada. O token IAM vale 1h — mais que suficiente por invocação. */
export class IbmClient {
  private token: string | null = null;
  private readonly auth: IbmAuth;

  // Campo explícito: parameter property (`constructor(private auth: ...)`)
  // exigiria geração de código, e o type-stripping do Node — usado pelos
  // testes — só apaga tipos.
  constructor(auth: IbmAuth) {
    this.auth = auth;
  }

  private async headers(): Promise<Record<string, string>> {
    if (!this.token) this.token = await iamToken(this.auth.apiKey);
    return {
      authorization: `Bearer ${this.token}`,
      'Service-CRN': this.auth.crn,
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': UA,
    };
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(API + path, { ...init, headers: await this.headers() });
    if (!res.ok) {
      throw new Error(`IBM ${init.method ?? 'GET'} ${path} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    return (await res.json()) as T;
  }

  async backends(): Promise<string[]> {
    const b = await this.call<{ devices?: string[] }>('/backends');
    return b.devices ?? [];
  }

  async status(name: string): Promise<{ status: string; length_queue: number }> {
    return this.call(`/backends/${encodeURIComponent(name)}/status`);
  }

  async configuration(name: string): Promise<BackendConfig> {
    const c = await this.call<{
      n_qubits?: number;
      max_shots?: number;
      basis_gates?: string[];
      coupling_map?: number[][];
    }>(`/backends/${encodeURIComponent(name)}/configuration`);
    if (!c.n_qubits) throw new Error(`configuração de ${name} sem n_qubits`);
    return {
      n_qubits: c.n_qubits,
      max_shots: c.max_shots ?? 100_000,
      basis_gates: c.basis_gates ?? [],
      coupling_map: c.coupling_map ?? [],
    };
  }

  /**
   * Par de qubits vizinhos para o teste de Bell, preferindo o de menor erro.
   *
   * A qualidade do par manda direto no valor de S: num par ruim o
   * emaranhamento decoere e S despenca em direção a 2, que é justamente o
   * número que não queremos ver por motivo errado. O critério soma o erro da
   * cz com os erros de leitura dos dois qubits — leitura pesa tanto quanto a
   * porta, porque cada shot passa por ela duas vezes.
   *
   * Devolve null quando o backend não expõe mapa de acoplamento; nesse caso o
   * harvest segue só com a entropia. As propriedades são um JSON grande e a
   * chamada é opcional: se falhar, cai na primeira aresta do mapa em vez de
   * derrubar o teste inteiro.
   */
  async bestPair(name: string, couplingMap: number[][]): Promise<[number, number] | null> {
    const edges = couplingMap.filter(
      (e) => Array.isArray(e) && e.length === 2 && e[0] !== e[1],
    );
    if (edges.length === 0) return null;

    try {
      const props = await this.call<BackendProps>(
        `/backends/${encodeURIComponent(name)}/properties`,
      );
      const readout = new Map<number, number>();
      (props.qubits ?? []).forEach((params, q) => {
        const p = params.find((x) => x.name === 'readout_error');
        if (typeof p?.value === 'number') readout.set(q, p.value);
      });

      // O par sai das propriedades, mas quem manda no que o hardware aceita é
      // o mapa de acoplamento: um par fora dele viraria circuito não-ISA e o
      // job inteiro seria recusado, entropia junto.
      const adjacent = new Set(edges.map(([a, b]) => `${a},${b}`));

      let best: { pair: [number, number]; score: number } | null = null;
      for (const gate of props.gates ?? []) {
        if (gate.gate !== 'cz' || gate.qubits?.length !== 2) continue;
        const err = gate.parameters?.find((p) => p.name === 'gate_error')?.value;
        if (typeof err !== 'number') continue;
        const [qa, qb] = gate.qubits;
        if (!adjacent.has(`${qa},${qb}`) && !adjacent.has(`${qb},${qa}`)) continue;
        // Sem leitura conhecida assumimos 5%, pior que qualquer qubit decente:
        // um par sem dado nunca ganha de um par medido e bom.
        const score = err + (readout.get(qa) ?? 0.05) + (readout.get(qb) ?? 0.05);
        if (!best || score < best.score) best = { pair: [qa, qb], score };
      }
      if (best) return best.pair;
    } catch (e) {
      console.error('CHSH: propriedades indisponíveis, usando a primeira aresta', e);
    }

    return [edges[0][0], edges[0][1]];
  }

  /** Backend operacional com a menor fila. */
  async leastBusy(): Promise<string> {
    const names = await this.backends();
    if (names.length === 0) throw new Error('nenhum backend disponível na conta');
    let best: { name: string; queue: number } | null = null;
    for (const name of names) {
      try {
        const st = await this.status(name);
        if (st.status !== 'active') continue;
        const queue = st.length_queue ?? Number.MAX_SAFE_INTEGER;
        if (!best || queue < best.queue) best = { name, queue };
      } catch {
        // Backend com status indisponível: só ignoramos e tentamos o próximo.
      }
    }
    if (!best) throw new Error('nenhum backend ativo');
    return best.name;
  }

  /**
   * Submete um job com um ou mais circuitos.
   *
   * Vários PUBs num job só, e não vários jobs, porque **o custo por job tem um
   * componente fixo grande**: um job de 2.000 shots já custou 3 s de QPU
   * cobrada para 0,54 s de execução. Separar o teste de Bell num job próprio
   * custaria mais no overhead do que nos shots dele.
   */
  async submitSampler(backend: string, pubs: PubSpec[]): Promise<string> {
    if (pubs.length === 0) throw new Error('submissão sem nenhum circuito');
    const job = await this.call<{ id?: string }>('/jobs', {
      method: 'POST',
      body: JSON.stringify({
        program_id: 'sampler',
        backend,
        params: {
          pubs: pubs.map((p) => [p.qasm, null, p.shots]),
          version: 2,
          support_qiskit: false,
        },
      }),
    });
    if (!job.id) throw new Error('submissão não devolveu id de job');
    return job.id;
  }

  async job(id: string): Promise<{ status: string; charged: number | null }> {
    const j = await this.call<{
      state?: { status?: string; reason?: string };
      bss?: { seconds?: number };
    }>(`/jobs/${encodeURIComponent(id)}`);
    return { status: j.state?.status ?? 'Unknown', charged: j.bss?.seconds ?? null };
  }

  /** Amostras hex de cada PUB, na mesma ordem em que foram submetidos. */
  async results(id: string): Promise<string[][]> {
    const r = await this.call<{
      results?: Array<{ data?: Record<string, { samples?: string[] }> }>;
    }>(`/jobs/${encodeURIComponent(id)}/results`);
    const entries = r.results;
    if (!entries?.length) throw new Error('resultado sem campo results');
    return entries.map((entry, i) => {
      const data = entry.data;
      if (!data) throw new Error(`resultado ${i} sem campo data`);
      // Os registradores se chamam "meas" (entropia) e "chsh" (Bell), que é
      // como os nomeamos no QASM, mas aceitamos qualquer nome para não quebrar
      // se a API mudar o rótulo.
      const reg = data.meas ?? data.chsh ?? Object.values(data)[0];
      if (!reg?.samples) throw new Error(`resultado ${i} sem amostras`);
      return reg.samples;
    });
  }
}

export interface PubSpec {
  qasm: string;
  shots: number;
}

export interface BackendConfig {
  n_qubits: number;
  max_shots: number;
  basis_gates: string[];
  coupling_map: number[][];
}

interface BackendProps {
  qubits?: Array<Array<{ name?: string; value?: number }>>;
  gates?: Array<{
    gate?: string;
    qubits?: number[];
    parameters?: Array<{ name?: string; value?: number }>;
  }>;
}

/** Circuito H^n + measure em OpenQASM 3, com qubits físicos. */
export function buildQasm3(nQubits: number): string {
  const lines = ['OPENQASM 3.0;', 'include "stdgates.inc";', `bit[${nQubits}] meas;`];
  for (let q = 0; q < nQubits; q++) {
    lines.push(`rz(pi/2) $${q};`, `sx $${q};`, `rz(pi/2) $${q};`);
  }
  for (let q = 0; q < nQubits; q++) lines.push(`meas[${q}] = measure $${q};`);
  return lines.join('\n');
}

/**
 * Converte as amostras hex da IBM num fluxo de bits empacotado.
 *
 * Cada amostra é o valor do registrador clássico em hex ("0x48f7…"). A API
 * pode omitir zeros à esquerda, então preenchemos até o comprimento esperado
 * antes de ler — sem isso, uma amostra que comece com zero deslocaria todo o
 * resto do fluxo.
 */
export function samplesToBits(samples: string[], nQubits: number): { raw: Uint8Array; nBits: number } {
  const hexDigits = Math.ceil(nQubits / 4);
  const padBits = hexDigits * 4 - nQubits;
  const raw = new Uint8Array(Math.ceil((samples.length * nQubits) / 8) + 1);
  let n = 0;

  for (const sample of samples) {
    let h = sample.startsWith('0x') || sample.startsWith('0X') ? sample.slice(2) : sample;
    if (h.length < hexDigits) h = '0'.repeat(hexDigits - h.length) + h;
    else if (h.length > hexDigits) h = h.slice(h.length - hexDigits);

    let seen = 0;
    for (let d = 0; d < hexDigits; d++) {
      const v = parseInt(h[d], 16);
      if (Number.isNaN(v)) throw new Error(`amostra hex inválida: ${sample.slice(0, 24)}`);
      for (let k = 3; k >= 0; k--) {
        if (seen++ < padBits) continue; // bits de preenchimento no topo
        if ((v >> k) & 1) raw[n >> 3] |= 0x80 >> (n & 7);
        n++;
      }
    }
  }
  return { raw, nBits: n };
}
