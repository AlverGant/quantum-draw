-- Geração de jogos de loteria reutiliza a mesma máquina de sorteio: mesmo
-- pool, mesmo pulso, mesmo round do drand, mesma semente. Muda o que se faz
-- com ela — embaralhar uma lista ou tirar dezenas de um intervalo.
ALTER TABLE draws ADD COLUMN kind TEXT NOT NULL DEFAULT 'list';
ALTER TABLE draws ADD COLUMN lottery_json TEXT;
