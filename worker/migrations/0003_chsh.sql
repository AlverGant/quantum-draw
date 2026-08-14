-- Teste de Bell (CHSH) anexado ao harvest: quatro circuitos de duas qubits
-- viajam como PUBs extras no mesmo job da entropia. Como o job é submetido num
-- tick do cron e lido em outro, o plano precisa sobreviver entre invocações —
-- que par de qubits foi usado e quantos PUBs vêm depois o da entropia.
ALTER TABLE harvest_state ADD COLUMN chsh_json TEXT;
