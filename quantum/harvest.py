#!/usr/bin/env python3
"""
Coleta entropia quântica, monta o pool e publica no Worker.

Uso típico (cron diário):

    export IBM_QUANTUM_TOKEN=...        # chave de API do IBM Cloud
    export IBM_QUANTUM_INSTANCE=crn:... # opcional, mas economiza chamadas
    export QDRAW_ADMIN_TOKEN=...        # mesmo valor do secret do Worker
    python harvest.py --publish https://sorteio.vynstream.com

Só gerar o arquivo, sem publicar:

    python harvest.py --source local --pulses 60 --out pool.json
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.request

import entropy
import pool as poolmod


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Gera o pool de entropia quântica do qdraw")
    p.add_argument("--source", default="auto", choices=["auto", "ibm", "anu", "local"],
                   help="fonte de entropia (padrão: auto, com fallback em cascata)")
    p.add_argument("--pulses", type=int, default=1440,
                   help="quantidade de pulsos no pool (padrão: 1440 = 24h a 1 pulso/min)")
    p.add_argument("--period", type=int, default=60,
                   help="segundos entre pulsos (padrão: 60)")
    p.add_argument("--backend", default=None, help="backend específico da IBM (ex: ibm_brisbane)")
    p.add_argument("--out", default=None, help="grava o pool completo neste arquivo")
    p.add_argument("--publish", default=None, metavar="URL",
                   help="publica o pool no Worker nesta origem")
    p.add_argument("--admin-token", default=None,
                   help="token de admin (padrão: variável QDRAW_ADMIN_TOKEN)")
    p.add_argument("--quiet", action="store_true")
    return p.parse_args()


def publish(origin: str, pool: poolmod.Pool, token: str, verbose: bool = True) -> None:
    url = origin.rstrip("/") + "/api/admin/pool"
    body = pool.to_json().encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "content-type": "application/json",
            "authorization": f"Bearer {token}",
            # Sem isto o urllib se anuncia como "Python-urllib/3.x" e a
            # proteção antibot da Cloudflare devolve 403 antes de a
            # requisição chegar no Worker.
            "user-agent": "qdraw-harvest/1.0 (+https://sorteio.vynstream.com)",
        },
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        payload = json.loads(resp.read())
    if verbose:
        print(f"[publish] {url} -> {payload}")


def main() -> int:
    args = parse_args()
    verbose = not args.quiet

    if args.pulses < 1:
        print("--pulses precisa ser >= 1", file=sys.stderr)
        return 2

    n_bits = poolmod.raw_bits_needed(args.pulses)
    if verbose:
        print(f"[plan] {args.pulses} pulsos x {poolmod.PULSE_BYTES} bytes "
              f"=> preciso de ~{n_bits:,} bits crus")

    kwargs = {}
    if args.source in ("ibm", "auto") and args.backend:
        kwargs["backend_name"] = args.backend

    t0 = time.time()
    try:
        bits, source = entropy.collect(n_bits, source=args.source, verbose=verbose,
                                       **(kwargs if args.source == "ibm" else {}))
    except entropy.EntropyError as e:
        print(f"erro: {e}", file=sys.stderr)
        return 1
    elapsed = time.time() - t0

    source["collect_seconds"] = round(elapsed, 1)
    p = poolmod.build_pool(bits, args.pulses, args.period, source)

    if verbose:
        print(f"[pool] id={p.pool_id}")
        print(f"[pool] raiz de Merkle: {p.merkle_root.hex()}")
        # As métricas de extração ficam em p.source: build_pool trabalha sobre
        # uma cópia do dicionário, então `source` aqui não as tem.
        print(f"[pool] rendimento von Neumann: {p.source['von_neumann_yield']:.1%}")
        print(f"[pool] proporção de 1s nos bits crus: {p.source['ones_ratio_raw']:.4f}")
        print(f"[pool] primeiro pulso revelável: "
              f"{time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(p.genesis_time))}")
        print(f"[pool] último pulso revelável: "
              f"{time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(p.reveal_time(args.pulses - 1)))}")

    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(p.to_json())
        if verbose:
            print(f"[out] {args.out}")

    if args.publish:
        token = args.admin_token or os.environ.get("QDRAW_ADMIN_TOKEN")
        if not token:
            print("erro: --publish exige --admin-token ou QDRAW_ADMIN_TOKEN", file=sys.stderr)
            return 2
        publish(args.publish, p, token, verbose)

    if not args.out and not args.publish:
        print(p.to_json())

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
