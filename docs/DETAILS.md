# Quantum Draw — full write-up

Raffles whose outcome nobody — not even the operator — can choose, with a
proof anyone can recompute on their own.

**Live:** https://sorteio.vynstream.com/?lang=en


```
quantum/   reference protocol in Python + manual harvest (IBM / ANU)
worker/    Cloudflare Worker: API + D1 + assets + automatic harvest
web/       front-end: framework-free SPA, 8 languages, in-browser verifier
scripts/   end-to-end test
```

Everything runs on Cloudflare: the Worker serves the site, executes the draws
and harvests the entropy from IBM by itself. No external machine has to stay
on.

## The problem

Every "online raffle" asks for the same thing: trust whoever runs it. The
operator sees the participant list and calls `random()`. Nothing stops them
from running it again until the desired name comes out, and nobody outside can
tell an honest draw from one that was re-run ten times.

What this project does is remove the need for that trust.

## How it works

The result is a deterministic function of three public inputs:

```
seed  = SHA-256("qdraw/v1/seed" ‖ commitment ‖ quantum_pulse ‖ drand_randomness)
order = Fisher-Yates(participants, DRBG(seed))
```

Each input is locked for a different reason:

**The quantum pulse** comes from qubits in superposition measured on IBM
hardware. Pulses are generated in batches and sealed under a Merkle root that
is published *before any draw exists*. From then on the operator cannot swap a
pulse: the Merkle proof would not close.

**The commitment** is the hash of the participant list, the number of winners
and — importantly — the exact pulse and drand round that will decide the draw.
Binding the targets inside the commitment prevents re-pointing an existing draw
at a different source of randomness after seeing who joined.

**The drand round** closes the last hole. We know the entire pool the moment it
is generated; if the seed depended only on the pulse, we could choose *which*
pulse to use. The drand round does not exist yet when the draw is created, and
no party — us included — can predict it.

Result: at commit time the participant does not know the outcome (the
randomness is missing) and neither does the operator (it does not control
drand, and the pulse is already locked in the tree).

## Two uses of the same seed

**List draw** — shuffles the participants with Fisher-Yates and takes the
first K.

**Lottery tickets** — generates bets for the nine games run by Caixa, the
Brazilian federal lottery (Mega-Sena, Lotofácil, Quina, Lotomania, Dupla Sena,
Timemania, Dia de Sorte, Super Sete and +Milionária), including the extra
elements: clovers, lucky month and the seven columns of Super Sete.

Here the proof serves a different purpose. Quantum numbers **do not improve
anyone's odds** — nothing does, and the site says so to the user's face. What
changes is that you can demonstrate the numbers were generated *before* the
official drawing. In a betting pool this kills the classic suspicion that the
organiser picked the numbers after seeing the result.

The rules of each game were checked against Caixa's public API
(`servicebus2.caixa.gov.br/portaldeloterias/api`). Careful when touching this:
`picks` is how many numbers the bettor marks, not how many Caixa draws — in
Timemania you pick 10 numbers and 7 are drawn.

### The Bell witness

Every pool ships with a CHSH test run in the same job that harvested the
entropy. It exists because entropy alone says nothing about where the bits came
from: a QPU that actually returned the output of a PRNG would deliver equally
well-distributed samples, and no statistical test on the pool would tell the
two cases apart.

The test prepares the Bell state |Φ+> on a pair of neighbouring qubits,
measures both sides in four basis combinations and computes

```
S = E(a,b) + E(a,b') + E(a',b) − E(a',b')      a=0, a'=π/2, b=π/4, b'=−π/4
```

with `E(α,β) = cos(α−β)` in the ideal case. **S ≤ 2 for any process in which
the bits were already tabulated before the measurement**; quantum mechanics
reaches 2√2 ≈ 2.828, and real hardware usually lands at 2.4–2.7. The report —
S, its uncertainty, the distance in sigmas from the classical bound, the four
correlations and the qubit pair used — is exposed in `source.chsh`, both in
`GET /api/pool` and in each draw's proof package.

**What it still is not.** This is an *entanglement witness*, not certified
randomness. The two qubits sit micrometres apart on the same chip, are read by
the same electronics, and the bases are chosen by us at submission time: the
locality and freedom-of-choice loopholes remain open, and IBM still operates
the hardware. Real certification would require space-like separation or the
random-circuit-sampling protocol with XEB verification — the latter needs a
classical supercomputer to check. What the witness rules out is the cheapest
hypothesis against the project: that the "quantum hardware" is a classical
generator under another name.

And none of that is what guarantees the fairness of the draw. That comes from
commit-reveal with drand: given the published pulse, the outcome is verifiable
by anyone, physics or no physics.

**A low S does not block the pool.** If the test fails to violate, the pool is
published anyway with the number exposed — without a pool the whole site
returns 503, and the witness is evidence attached to the entropy, not a gate in
front of it. Whoever reads the proof sees S and judges for themselves. The case
shows up as an error in `wrangler tail`.

## Verification

The full proof lives at `GET /api/draws/<slug>/proof`. The verifier at
`/verificar` runs entirely in the visitor's browser and fetches the drand round
**directly from `api.drand.sh`**, never through our servers — a verifier that
queried the beacon through our API would prove nothing.

To check from your own machine:

```bash
QDRAW_BASE=https://sorteio.vynstream.com python3 scripts/e2e.py --skip-pool
```

## Operations

### The harvest is automatic

There is no external cron, no machine left on and no GitHub Actions: **the
Worker itself harvests the entropy**. The Cloudflare cron fires every 5 minutes
and maintains a one-row state machine in the `harvest_state` table:

```
idle       ──▶ no pool covers now+6h?  submit a job to IBM  ──▶ submitted
submitted  ──▶ poll; on completion: build the pool  ──────────▶ idle
```

Only one job is in flight at a time. Without that persisted state, every
5-minute tick would open a new job and burn the 10 monthly QPU minutes in an
afternoon.

This works because the circuit we need does not require Qiskit. Heron's native
gates are `cz, id, rz, sx, x` — no H — but since the Hadamard acts on each qubit
independently, the decomposition is local and fits in a loop:

```
H  ->  rz(pi/2) · sx · rz(pi/2)
```

The Worker emits OpenQASM 3 directly, submits it to `POST /api/v1/jobs` and
reads the samples back in hex.

The Bell test is the only exception — it entangles — and it still avoids the
transpiler: `cz` is native and the qubit pair is chosen **among those already
adjacent in the coupling map**, preferring the pair with the lowest gate and
readout error. Two adjacent qubits have nothing to route. The four circuits
travel as extra PUBs in the **same job** as the entropy, never in a job of
their own: with a fixed cost of 3 s per job, separating them would cost more in
overhead than in shots. On a backend without native `cz` (the Eagle family uses
`ecr`) the test is skipped and the harvest proceeds with entropy only —
decomposing `ecr` by hand with no transpiler to check against would be asking
to fail silently.

Secrets required in the Worker: `IBM_API_KEY` (IBM Cloud key) and `IBM_CRN`
(instance CRN). Without them the automatic harvest is off and the pool depends
on external publication.

Inspect and operate:

```bash
# current state + how long until the pool runs out
curl -H "authorization: Bearer $QDRAW_ADMIN_TOKEN" .../api/admin/harvest

# renew now, off schedule
curl -X POST -H "authorization: Bearer $QDRAW_ADMIN_TOKEN" \
     ".../api/admin/harvest?force=1"
```

### Manual harvest (optional)

The Python path still works, useful for generating a pool offline or
publishing from another source:

```bash
export IBM_QUANTUM_TOKEN=...          # IBM Cloud API key
export QDRAW_ADMIN_TOKEN=...          # the same secret as the Worker's

pip install -r quantum/requirements.txt
python3 quantum/harvest.py --publish https://sorteio.vynstream.com
```

The default is 1440 pulses one minute apart — 24 hours of coverage, one harvest
per day. `--source auto` tries IBM, falls back to ANU and, as a last resort, to
local entropy **clearly labelled as non-quantum** (the site shows a warning).

### QPU budget

The Open plan gives **10 QPU minutes per month** (600 s). Real measurements on
`ibm_marrakesh` (156 qubits, Heron r2):

| | shots | execution | **charged** |
|---|---|---|---|
| Calibration | 2 000 | 0.54 s | 3 s |
| 24 h harvest | 21 741 | 5.86 s | 8 s |
| 24 h harvest + CHSH | 21 741 + 4×2 048 | 8.87 s | **10 s** |

Note the fixed cost: 3 seconds charged for a half-second job. **A few large
jobs cost far less than many small ones** — which is why the harvester packs
everything into a single job (`DEFAULT_SHOTS_PER_JOB = 50_000`) instead of
slicing.

A daily harvest spends ~240 s/month, 40% of the cap, leaving room for retries.
If you need to save, doubling the period to 120 s halves the shots — the price
is a draw taking 2 to 4 minutes instead of 2 to 3.

The Bell test adds 4 × 2 048 = 8 192 shots to that same job, ~38% more shots,
and **measured on `ibm_marrakesh` it cost 2 s: from 8 s to 10 s**. Since it
opens no new job, it does not pay the fixed cost again — 8k two-qubit shots
come out at a quarter of what they would cost on their own. A daily harvest
rises to ~300 s/month, half the cap. If that is too tight, `CHSH_SHOTS` tunes
it: at 1 024 the uncertainty in S is still ~0.06, enough for a typical violation
to show up 8σ above the classical bound; `CHSH_SHOTS=0` turns the test off.

First run, on 2026-08-14: **S = 2.781 ± 0.032**, 24.6σ above the classical
bound and 98.3% of the Tsirelson maximum, on qubit pair 54–55. All four
correlations came out within 0.03 of the ideal value.

An API quirk: **`bss.seconds` is null on a freshly completed job** and only
gets filled in minutes later. Since the Worker reads the job the instant it
completes, the `charged_seconds` recorded in the pool is usually `null`; the
real value shows up in `GET /api/v1/jobs` on the IBM account.

The harvest inside the Worker consumes ~64 ms of CPU (von Neumann over 3.4 M
bits, 2 880 conditioning hashes and 1 440 Merkle leaves). That **requires the
Workers Paid plan** — Free caps invocations at 10 ms, cron included.

Checking the balance:

```python
service.usage()   # usage_remaining_seconds, usage_limit_seconds
```

### Deploy

```bash
cd worker
npm install
npx wrangler d1 create qdraw          # the id goes into wrangler.toml
npm run db:remote
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put VISITOR_SALT
npm run deploy                        # runs build + tests before publishing
```

On an existing database, `npm run db:remote` does **not** alter tables — the
schema is all `CREATE TABLE IF NOT EXISTS`. New columns come in through the
files in `migrations/`, and the Bell-test one must go in before the deploy:
without it the `UPDATE harvest_state` fails, no new pool gets published and the
site falls to 503 once the current pool runs out.

```bash
npx wrangler d1 execute qdraw --remote --file=./migrations/0003_chsh.sql
```

## Tests

```bash
python3 quantum/selftest.py           # protocol: von Neumann, Merkle, DRBG, commit
cd worker && npm test                 # byte-for-byte parity Python <-> TypeScript
python3 scripts/e2e.py                # full cycle against a running Worker
```

Cross-language parity is not a detail: `quantum/protocol.py` and
`worker/src/protocol.ts` must produce identical bytes, otherwise the browser
verifier disagrees with the server and the project's premise collapses.
`selftest.py --emit` generates the vectors the Node test checks against.

`web/protocol.js` is **generated** from `worker/src/protocol.ts` by
`npm run build:protocol`. Do not edit it by hand — the point is that the browser
runs literally the same code as the server, not a second implementation that
might agree by accident.

## Decisions worth a line

- **Promotion, not duplication, on odd Merkle nodes.** Duplicating the last
  node (as Bitcoin does) creates ambiguity between distinct trees.
- **The index goes into the leaf hash.** Without it a valid pulse could be
  re-presented at a different position in the tree.
- **Rejection sampling in the DRBG.** `x % n` biases towards low indices when
  `n` does not divide 2³²; small, but unacceptable in a draw that calls itself
  verifiable.
- **The whitespace class is declared character by character.** JavaScript's
  `\s` and Python's are different sets, and the divergence would make the same
  name hash differently on the server and in the verifier.
- **`/reveal` is public.** If only the operator could trigger the draw, it
  would have the option of never triggering a result it disliked. Anyone can
  execute it, and a cron executes it on its own every 5 minutes.
- **Visitor counting without storing IPs.** The identifier is
  `hash(salt ‖ day ‖ IP ‖ user-agent)`, truncated: it does not reverse to the
  IP and becomes a different identifier tomorrow.

## License

MIT. See [LICENSE](../LICENSE).
