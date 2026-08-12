# Sorteio Quântico

Sorteios cujo resultado ninguém — nem o operador — consegue escolher, com uma
prova que qualquer pessoa refaz sozinha.

**No ar:** https://sorteio.vynstream.com

```
quantum/   protocolo de referência em Python + harvest manual (IBM / ANU)
worker/    Cloudflare Worker: API + D1 + assets + harvest automático
web/       front-end: SPA sem framework, 8 idiomas, verificador no browser
scripts/   teste ponta a ponta
```

Roda inteiro no Cloudflare: o Worker serve o site, executa os sorteios e colhe
a entropia da IBM sozinho. Nenhuma máquina externa precisa estar ligada.

## O problema

Todo "sorteio online" pede a mesma coisa: confie em quem sorteia. Quem opera o
site vê a lista de participantes e roda o `random()`. Nada impede de rodar de
novo até sair o nome desejado, e ninguém de fora consegue distinguir um sorteio
honesto de um refeito dez vezes.

O que este projeto faz é remover a necessidade dessa confiança.

## Como funciona

O resultado é uma função determinística de três coisas públicas:

```
semente = SHA-256("qdraw/v1/seed" ‖ compromisso ‖ pulso_quântico ‖ aleatoriedade_drand)
ordem   = Fisher-Yates(participantes, DRBG(semente))
```

Cada entrada é travada por um motivo diferente:

**O pulso quântico** vem de qubits em superposição medidos em hardware da IBM.
Os pulsos são gerados em lote e selados sob uma raiz de Merkle publicada *antes
de qualquer sorteio existir*. Depois disso o operador não consegue trocar um
pulso: a prova de Merkle não fecharia.

**O compromisso** é o hash da lista de participantes, do número de vencedores e
— importante — do pulso e do round exatos que decidirão o sorteio. Amarrar os
alvos dentro do compromisso impede reapontar um sorteio já criado para outra
aleatoriedade depois de ver quem entrou.

**O round do drand** é o que fecha o último buraco. Nós conhecemos o pool
inteiro no instante em que ele é gerado; se a semente dependesse só do pulso,
poderíamos escolher *qual* pulso usar. O round do drand ainda não existe quando
o sorteio é criado e nenhuma parte — nós inclusive — consegue prevê-lo.

Resultado: no momento do compromisso, o participante não sabe o resultado (falta
a aleatoriedade) e o operador também não (não controla o drand, e o pulso já
está travado na árvore).

## Dois usos da mesma semente

**Sorteio de lista** — embaralha participantes com Fisher-Yates e tira os
primeiros K.

**Jogos de loteria** — gera apostas das nove modalidades da Caixa (Mega-Sena,
Lotofácil, Quina, Lotomania, Dupla Sena, Timemania, Dia de Sorte, Super Sete e
+Milionária), incluindo os elementos extras: trevos, mês da sorte e as sete
colunas do Super Sete.

Aqui a prova serve para outra coisa. Números quânticos **não aumentam a chance
de ninguém** — nada aumenta, e o site diz isso na cara do usuário. O que muda é
que dá para demonstrar que os números foram gerados *antes* do sorteio da
Caixa. Num bolão isso mata a desconfiança clássica de que o organizador
escolheu depois de ver o resultado.

As regras de cada modalidade foram conferidas contra a API pública da Caixa
(`servicebus2.caixa.gov.br/portaldeloterias/api`). Atenção ao mexer: `picks` é
quanto o apostador marca, não quanto a Caixa sorteia — na Timemania aposta-se
10 dezenas e são sorteadas 7.

### O que isto não é

Não é aleatoriedade quântica *certificada*. Certificação de verdade exige um
teste de Bell violando a desigualdade CHSH, o que prova que os bits não foram
pré-programados no dispositivo. Aqui, confia-se que a IBM opera a QPU honestamente.
O que **não** exige confiança é o sorteio em si: dado o pulso publicado, o
resultado é verificável por qualquer um. A garantia de imparcialidade vem do
commit-reveal com o drand, não da física.

## Verificação

Toda a prova fica em `GET /api/draws/<slug>/proof`. O verificador em
`/verificar` roda inteiramente no navegador do visitante e busca o round do
drand **direto em `api.drand.sh`**, sem passar pelos nossos servidores — um
verificador que consultasse o farol através da nossa API não provaria nada.

Para conferir na sua máquina:

```bash
QDRAW_BASE=https://sorteio.vynstream.com python3 scripts/e2e.py --skip-pool
```

## Operação

### O harvest é automático

Não há cron externo, máquina ligada nem GitHub Actions: **o próprio Worker
colhe a entropia**. O cron do Cloudflare roda a cada 5 minutos e mantém uma
máquina de estados de uma linha só na tabela `harvest_state`:

```
idle       ──▶ nenhum pool cobre agora+6h?  submete job na IBM  ──▶ submitted
submitted  ──▶ polling; quando completa: monta o pool  ─────────▶ idle
```

Só existe um job em voo por vez. Sem esse estado persistido, cada tick de 5
minutos abriria um job novo e queimaria os 10 minutos mensais de QPU numa tarde.

Isso funciona porque o circuito de que precisamos dispensa o Qiskit. As portas
nativas do Heron são `cz, id, rz, sx, x` — não incluem H — mas como o Hadamard
atua em cada qubit isoladamente, a decomposição é local e cabe num laço:

```
H  ->  rz(pi/2) · sx · rz(pi/2)
```

O Worker gera o OpenQASM 3 direto, submete em `POST /api/v1/jobs` e lê as
amostras em hex. Qualquer circuito com emaranhamento exigiria transpilação de
verdade e o atalho não valeria; para gerar entropia, vale.

Secrets necessários no Worker: `IBM_API_KEY` (chave do IBM Cloud) e `IBM_CRN`
(CRN da instância). Sem eles o harvest automático fica desligado e o pool passa
a depender de publicação externa.

Inspecionar e operar:

```bash
# estado atual + quanto falta para o pool esgotar
curl -H "authorization: Bearer $QDRAW_ADMIN_TOKEN" .../api/admin/harvest

# renovar agora, fora do cronograma
curl -X POST -H "authorization: Bearer $QDRAW_ADMIN_TOKEN" \
     ".../api/admin/harvest?force=1"
```

### Harvest manual (opcional)

O caminho em Python continua funcionando, útil para gerar um pool offline ou
publicar de outra fonte:

```bash
export IBM_QUANTUM_TOKEN=...          # chave de API do IBM Cloud
export QDRAW_ADMIN_TOKEN=...          # o mesmo secret do Worker

pip install -r quantum/requirements.txt
python3 quantum/harvest.py --publish https://sorteio.vynstream.com
```

O padrão são 1440 pulsos de 1 em 1 minuto — 24 horas de cobertura, um harvest
por dia. `--source auto` tenta IBM, cai para ANU e, em último caso, para
entropia local **claramente rotulada como não-quântica** (o site exibe um aviso).

### Orçamento de QPU

O plano Open dá **10 minutos de QPU por mês** (600 s). Medições reais no
`ibm_marrakesh` (156 qubits, Heron r2):

| | shots | execução | **cobrado** |
|---|---|---|---|
| Calibração | 2 000 | 0,54 s | 3 s |
| Harvest de 24 h | 21 741 | 5,86 s | 8 s |

Repare no custo fixo: 3 segundos cobrados por um job de meio segundo. **Poucos
jobs grandes custam muito menos que muitos pequenos** — por isso o harvester
junta tudo num job só (`DEFAULT_SHOTS_PER_JOB = 50_000`) em vez de fatiar.

Um harvest diário gasta ~240 s/mês, 40% do teto, deixando folga para retentativas.
Se precisar economizar, dobrar o período para 120 s corta os shots pela metade —
o custo é o sorteio demorar entre 2 e 4 minutos em vez de 2 a 3.

O harvest no Worker consome ~64 ms de CPU (von Neumann sobre 3,4 M bits, 2 880
hashes de condicionamento e 1 440 folhas de Merkle). Isso **exige o plano
Workers Paid** — o Free limita a 10 ms por invocação, inclusive em cron.

Consultar o saldo:

```python
service.usage()   # usage_remaining_seconds, usage_limit_seconds
```

### Deploy

```bash
cd worker
npm install
npx wrangler d1 create qdraw          # o id vai no wrangler.toml
npm run db:remote
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put VISITOR_SALT
npm run deploy                        # roda build + testes antes de publicar
```

## Testes

```bash
python3 quantum/selftest.py           # protocolo: von Neumann, Merkle, DRBG, commit
cd worker && npm test                 # paridade byte a byte Python <-> TypeScript
python3 scripts/e2e.py                # ciclo completo contra um Worker rodando
```

A paridade entre linguagens não é detalhe: `quantum/protocol.py` e
`worker/src/protocol.ts` precisam produzir bytes idênticos, senão o verificador
do browser discorda do servidor e a premissa do projeto cai. `selftest.py --emit`
gera os vetores que o teste em Node confere.

`web/protocol.js` é **gerado** de `worker/src/protocol.ts` por
`npm run build:protocol`. Não edite à mão — a ideia é que o navegador rode
literalmente o mesmo código do servidor, e não uma segunda implementação que
poderia concordar por engano.

## Decisões que valem uma linha

- **Promoção, não duplicação, em nós ímpares da Merkle.** Duplicar o último nó
  (como o Bitcoin) cria ambiguidade entre árvores distintas.
- **O índice entra no hash da folha.** Sem isso um pulso válido poderia ser
  reapresentado numa posição diferente da árvore.
- **Amostragem com rejeição no DRBG.** `x % n` enviesa para os índices baixos
  quando `n` não divide 2³²; pequeno, mas inaceitável num sorteio que se
  apresenta como verificável.
- **A classe de espaço em branco é declarada caractere a caractere.** O `\s` do
  JavaScript e o do Python são conjuntos diferentes, e a divergência faria o
  mesmo nome hashear diferente no servidor e no verificador.
- **`/reveal` é público.** Se só o operador pudesse disparar o sorteio, ele teria
  a opção de nunca disparar um resultado que não gostou. Qualquer um executa, e
  um cron executa sozinho a cada 5 minutos.
- **Contagem de visitantes sem guardar IP.** O identificador é
  `hash(sal ‖ dia ‖ IP ‖ user-agent)` truncado: não reverte para o IP e vira
  outro identificador amanhã.

## Licença

MIT.
