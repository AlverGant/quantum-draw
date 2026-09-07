# Quantum Draw

A raffle whose result nobody can rig — not the participants, not the person
running it — and whose proof anyone can check in a browser.

**Try it:** https://sorteio.vynstream.com/?lang=en · *[Versão em português](README.pt-BR.md)*

## Why a normal online raffle asks you to trust the operator

When a site "draws a winner", someone's computer calls `random()`. If they
don't like the name that comes out, they can run it again. Nobody outside can
tell the difference between an honest draw and one re-run ten times, because
the randomness lives on their machine and the list is only known to them.

This project rearranges the draw so that cheating is not merely forbidden,
but impossible to do without leaving evidence.

## The idea in three locks

The winner is computed from a *seed*, and the seed is the hash of three
things that are all public:

```
seed  = SHA-256( commitment  ‖  quantum pulse  ‖  drand beacon )
order = shuffle(participants, seed)
```

Each piece closes one way of cheating.

**Lock 1 — the commitment (nobody can edit the list).**
Before anything is drawn, the site publishes the hash of the participant
list, the number of winners and *which* pulse and beacon round will decide
the draw. A hash is a fingerprint: change one letter of the list and the
fingerprint changes completely. Once it is published, the operator cannot
add, remove or reorder participants without the fingerprint no longer
matching. This pattern is called **commit-reveal**: you commit first, reveal
later, and everyone can check the reveal matches the commitment.

**Lock 2 — the quantum pulse (the randomness was fixed in advance).**
Once a day the site runs a circuit on an IBM quantum computer: put qubits in
superposition, measure them, keep the bits. Those bits are cut into 1 440
"pulses" (one per minute) and sealed under a **Merkle root** — one hash that
summarises all 1 440 pulses at once, published before any draw exists. Later,
each draw comes with a short proof that its pulse really was inside that
sealed batch. Swapping a pulse would break the proof.

**Lock 3 — the drand beacon (not even the operator knows the pulse's effect).**
There is still a hole: the operator knows all 1 440 pulses the moment they are
generated, so it could pick a convenient one. So the seed also mixes in a
round of [drand](https://drand.love), a public random beacon produced every few
seconds by a network of independent organisations. The round used by a draw is
one that *does not exist yet* when the draw is created. Nobody — the operator
included — can predict it.

Put the three together: when a draw is created, the participant can't know the
outcome (the beacon hasn't happened) and the operator can't either (it doesn't
control the beacon, and the pulse is already sealed in the tree).

## Why bother with a quantum computer at all?

Honestly: the *unpredictability* is already guaranteed by the beacon. What the
quantum pulse adds is a second, independent source of entropy whose physical
origin can be demonstrated.

That last part is the interesting one. Random-looking bits could come from
anywhere — a pseudo-random generator produces perfectly good-looking bits. So
every batch carries a **Bell test** (the CHSH inequality), run in the same job
on the same chip. In plain terms: two entangled qubits are measured in
different ways, and a number S is computed from the correlations. If the
outcomes had been decided in advance by any classical process, S cannot exceed
2. Quantum mechanics allows up to 2.83. The hardware typically lands around
2.7, twenty-odd standard deviations above the classical limit.

This is an *entanglement witness*, not certified randomness — the two qubits
sit micrometres apart on the same chip and IBM operates the machine, so the
usual loopholes stay open. What it rules out is the cheap accusation that the
"quantum hardware" is a classical generator with a fancier name. And it has
nothing to do with the fairness of the draw: that comes from the three locks
above, physics or no physics.

## Check a draw yourself

Every draw exposes its full proof at `GET /api/draws/<slug>/proof`: the
committed list, the pulse, its Merkle path, the beacon round and the result.
The verifier page recomputes everything **in your browser** and fetches the
beacon straight from `api.drand.sh`, never through this site — a verifier that
asked the operator for the beacon would prove nothing.

You can also run the checks from your own machine:

```bash
QDRAW_BASE=https://sorteio.vynstream.com python3 scripts/e2e.py --skip-pool
```

## A second use: lottery numbers

The same seed can generate tickets for Brazil's federal lotteries (Mega-Sena,
Lotofácil and seven others). Quantum numbers **do not improve anyone's odds** —
nothing does, and the site says so. What the proof buys you is different: in a
betting pool you can show the numbers were generated *before* the official
drawing, so nobody can claim the organiser picked them afterwards.

## What's in the repo

```
quantum/   reference protocol in Python + manual harvest
worker/    Cloudflare Worker: API, database, static site, automatic harvest
web/       front-end, 8 languages, in-browser verifier
scripts/   end-to-end test
docs/      the full write-up: operations, QPU budget, design decisions
```

The whole thing runs inside one Cloudflare Worker. It writes the quantum
circuit as OpenQASM by hand, submits it to IBM's REST API on a cron, debiases
the bits and builds the Merkle tree — no Qiskit, no server left on. The
Python and TypeScript implementations of the protocol are tested to produce
identical bytes, and the browser runs literally the same code as the server.

Read [docs/DETAILS.md](docs/DETAILS.md) for how the harvest works, what a day
of entropy costs in QPU seconds, how to deploy your own copy, and the small
design decisions (why the Merkle tree promotes odd nodes, why the DRBG uses
rejection sampling, why `/reveal` is public).

## License

MIT. See [LICENSE](LICENSE).
