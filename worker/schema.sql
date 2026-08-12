-- Esquema D1 do sorteio-quantico (qdraw-v1)
-- Aplicar com:
--   npx wrangler d1 execute qdraw --local  --file=./schema.sql
--   npx wrangler d1 execute qdraw --remote --file=./schema.sql

-- Pools de entropia. Um pool é publicado inteiro de uma vez; a raiz de
-- Merkle fica pública imediatamente, mas cada pulso só é servido depois do
-- seu reveal_time. É esse descasamento que trava o operador: a árvore já
-- está comprometida quando o sorteio é criado.
CREATE TABLE IF NOT EXISTS pools (
  id            TEXT PRIMARY KEY,
  merkle_root   TEXT    NOT NULL,
  genesis_time  INTEGER NOT NULL,
  period        INTEGER NOT NULL,
  pulse_count   INTEGER NOT NULL,
  source_json   TEXT    NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pulses (
  pool_id TEXT    NOT NULL,
  idx     INTEGER NOT NULL,
  value   TEXT    NOT NULL,
  PRIMARY KEY (pool_id, idx)
) WITHOUT ROWID;

-- Dois tipos de sorteio compartilham toda a maquinaria de prova (pool, pulso,
-- round do drand, semente). O que muda é o uso da semente: 'list' embaralha
-- uma lista de participantes, 'lottery' tira dezenas de um intervalo.
-- Em linhas 'lottery', participants_json fica vazio e a configuração do jogo
-- vive em lottery_json; participants_hash guarda o hash dessa configuração.
CREATE TABLE IF NOT EXISTS draws (
  id                TEXT PRIMARY KEY,
  slug              TEXT    NOT NULL UNIQUE,
  kind              TEXT    NOT NULL DEFAULT 'list',   -- list | lottery
  lottery_json      TEXT,
  title             TEXT    NOT NULL,
  participants_json TEXT    NOT NULL,
  participants_hash TEXT    NOT NULL,
  participant_count INTEGER NOT NULL,
  winners_count     INTEGER NOT NULL,
  client_nonce      TEXT    NOT NULL,
  commit_hash       TEXT    NOT NULL,
  pool_id           TEXT    NOT NULL,
  pulse_index       INTEGER NOT NULL,
  drand_round       INTEGER NOT NULL,
  reveal_time       INTEGER NOT NULL,
  status            TEXT    NOT NULL DEFAULT 'committed',
  is_public         INTEGER NOT NULL DEFAULT 1,
  locale            TEXT,
  created_at        INTEGER NOT NULL,
  drawn_at          INTEGER,
  pulse_value       TEXT,
  drand_signature   TEXT,
  drand_randomness  TEXT,
  seed              TEXT,
  winners_json      TEXT,
  order_json        TEXT,
  merkle_proof_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_draws_pending ON draws (status, reveal_time);
CREATE INDEX IF NOT EXISTS idx_draws_recent  ON draws (is_public, drawn_at DESC);

-- Estado do harvest automático (linha única). O job da IBM fica minutos na
-- fila, então o cron não espera: um tick submete, os seguintes fazem polling,
-- e quando completa o pool é montado. Sem isto, cada tick tentaria submeter
-- um job novo enquanto o anterior ainda roda.
CREATE TABLE IF NOT EXISTS harvest_state (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  status          TEXT    NOT NULL DEFAULT 'idle',   -- idle | submitted
  job_id          TEXT,
  backend         TEXT,
  shots           INTEGER,
  qubits          INTEGER,
  pulses          INTEGER,
  period          INTEGER,
  submitted_at    INTEGER,
  last_check      INTEGER,
  last_error      TEXT,
  last_success    INTEGER,
  charged_seconds INTEGER,
  -- Proteção do orçamento de QPU: sem backoff, uma falha na montagem do pool
  -- faria o tick seguinte submeter outro job, a cada 5 minutos, queimando os
  -- 10 minutos mensais numa tarde.
  failures        INTEGER NOT NULL DEFAULT 0,
  retry_after     INTEGER
);

INSERT OR IGNORE INTO harvest_state (id, status) VALUES (1, 'idle');

-- Contadores públicos exibidos na home.
CREATE TABLE IF NOT EXISTS counters (
  key   TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

-- Visitantes únicos por dia. `visitor` é um hash truncado de
-- salt+dia+IP+user-agent: some sozinho na virada do dia e não permite voltar
-- ao IP. Não guardamos IP em lugar nenhum.
CREATE TABLE IF NOT EXISTS visitors (
  day     TEXT NOT NULL,
  visitor TEXT NOT NULL,
  country TEXT,
  PRIMARY KEY (day, visitor)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS countries (
  code  TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

-- Janela de limite de taxa por hora, para a criação de sorteios.
CREATE TABLE IF NOT EXISTS rate_limit (
  bucket TEXT PRIMARY KEY,
  count  INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL
) WITHOUT ROWID;

INSERT OR IGNORE INTO counters (key, value) VALUES
  ('pageviews', 0),
  ('unique_visitors', 0),
  ('draws_created', 0),
  ('draws_completed', 0),
  ('participants_total', 0);
