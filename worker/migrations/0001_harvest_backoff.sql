-- Adiciona backoff ao harvest em bancos criados antes dessa proteção.
-- CREATE TABLE IF NOT EXISTS não altera tabelas existentes, então as colunas
-- novas precisam entrar por ALTER.
ALTER TABLE harvest_state ADD COLUMN failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE harvest_state ADD COLUMN retry_after INTEGER;
