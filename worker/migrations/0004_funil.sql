-- Funil de gestos. A borda conta downloads e a tabela `draws` conta sorteios;
-- entre os dois não havia nada. Uma linha por (dia, evento), incrementada — o
-- mesmo formato do funil do onde-morar, para as consultas serem as mesmas.
CREATE TABLE IF NOT EXISTS funil (
  dia    TEXT NOT NULL,
  evento TEXT NOT NULL,
  n      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (dia, evento)
) WITHOUT ROWID;
