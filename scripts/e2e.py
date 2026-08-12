#!/usr/bin/env python3
"""
Teste ponta a ponta contra um Worker rodando.

    cd worker && npx wrangler dev --port 8788 --local &
    python scripts/e2e.py

Percorre o ciclo real: publica um pool, cria um sorteio, espera o pulso,
executa, baixa a prova e reverifica tudo em Python — uma implementação
diferente da que produziu o resultado. Também tenta adulterar a prova para
confirmar que a verificação reprova.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "quantum"))

import entropy  # noqa: E402
import pool as poolmod  # noqa: E402
import protocol  # noqa: E402

BASE = os.environ.get("QDRAW_BASE", "http://127.0.0.1:8788")
# Contra producao, publicar um pool de teste derrubaria o pool real em uso.
SKIP_POOL = "--skip-pool" in sys.argv
ADMIN = os.environ.get("QDRAW_ADMIN_TOKEN", "dev-admin-token-nao-use-em-producao")

GREEN, RED, DIM, RESET = "\033[32m", "\033[31m", "\033[2m", "\033[0m"
passed = failed = 0


def check(label: str, condition: bool, detail: str = "") -> bool:
    global passed, failed
    if condition:
        passed += 1
        print(f"  {GREEN}ok{RESET} {label}" + (f" {DIM}{detail}{RESET}" if detail else ""))
    else:
        failed += 1
        print(f"  {RED}FALHOU{RESET} {label}" + (f" {DIM}{detail}{RESET}" if detail else ""))
    return condition


def req(path: str, method: str = "GET", body=None, token: str | None = None):
    data = json.dumps(body).encode() if body is not None else None
    headers = {
        "content-type": "application/json",
        # Cloudflare devolve 403 para o UA padrao do urllib.
        "user-agent": "qdraw-e2e/1.0",
    }
    if token:
        headers["authorization"] = f"Bearer {token}"
    r = urllib.request.Request(BASE + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(r, timeout=60) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except json.JSONDecodeError:
            return e.code, {"raw": raw[:300].decode("utf-8", "replace")}


def publish_pool():
    """Publica um pool novo e devolve o objeto Pool (para conferir os pulsos)."""
    print("1. publicação do pool")
    period, pulses_n = 10, 60
    bits, source = entropy.from_local(poolmod.raw_bits_needed(pulses_n), verbose=False)
    p = poolmod.build_pool(bits, pulses_n, period, source)
    payload = json.loads(p.to_json())

    status, resp = req("/api/admin/pool", "POST", payload, ADMIN)
    check("pool aceito", status == 200, f"HTTP {status}")
    check("raiz recalculada pelo servidor confere",
          resp.get("merkle_root") == p.merkle_root.hex())

    status, _ = req("/api/admin/pool", "POST", payload, "token-errado")
    check("token de admin inválido é rejeitado", status == 401, f"HTTP {status}")

    bad = dict(payload, merkle_root="00" * 32)
    status, _ = req("/api/admin/pool", "POST", bad, ADMIN)
    check("raiz divergente é rejeitada", status == 400, f"HTTP {status}")
    return p


def main() -> int:
    print("teste ponta a ponta — qdraw-v1\n")
    print(f"{DIM}alvo: {BASE}{RESET}\n")

    # ------------------------------------------------------- 1. publicar pool
    p = None
    if SKIP_POOL:
        print("1. publicação do pool  (pulada: --skip-pool)")
    else:
        p = publish_pool()

    # ------------------------------------------------------- 2. criar sorteio
    print("\n2. criação do sorteio (compromisso)")
    participants = ["Ana", "Bruno", "Carla", "Diego", "Élia", "Fábio",
                    "Gina", "Hugo", "Íris", "João", "Kátia", "Lucas"]
    status, draw = req("/api/draws", "POST", {
        "title": "Teste ponta a ponta",
        "participants": participants,
        "winners_count": 3,
        "locale": "pt",
        # Contra produção o sorteio é real e apareceria em "Sorteios recentes"
        # para os visitantes. A prova continua acessível pelo link — só não
        # entra na vitrine.
        "is_public": not SKIP_POOL,
    })
    if not check("sorteio criado", status == 201, f"HTTP {status} {draw.get('message', '')}"):
        return 1

    slug = draw["slug"]
    c = draw["commitment"]
    print(f"  {DIM}slug={slug} pulso={c['pulse_index']} round={c['drand_round']}{RESET}")

    check("status inicial é 'committed'", draw["status"] == "committed")
    check("pulso NÃO é exposto antes da hora", "proof" not in draw)
    check("compromisso reproduzido em Python",
          c["commit_hash"] == protocol.commit_hash(
              title="Teste ponta a ponta",
              participants=protocol.normalize_participants(participants),
              winners_count=3,
              client_nonce=c["client_nonce"],
              pool_id=c["pool_id"],
              pulse_index=c["pulse_index"],
              drand_round=c["drand_round"],
          ).hex())

    now = int(time.time())
    check("round do drand ainda não existe no commit",
          1692803367 + (c["drand_round"] - 1) * 3 > now,
          f"faltam {1692803367 + (c['drand_round'] - 1) * 3 - now}s")

    status, _ = req(f"/api/draws/{slug}/reveal", "POST")
    check("revelar antes da hora é recusado", status == 425, f"HTTP {status}")

    # ------------------------------------------------------- 3. esperar e sortear
    wait = c["reveal_time"] - int(time.time()) + 2
    print(f"\n3. execução do sorteio {DIM}(aguardando {max(0, wait)}s pelo pulso){RESET}")
    if wait > 0:
        time.sleep(wait)

    status, done = req(f"/api/draws/{slug}/reveal", "POST")
    if not check("sorteio executado", status == 200, f"HTTP {status} {done.get('message', '')}"):
        return 1
    check("status virou 'drawn'", done["status"] == "drawn")
    winners = done["result"]["winners"]
    print(f"  {DIM}vencedores: {', '.join(winners)}{RESET}")

    status, again = req(f"/api/draws/{slug}/reveal", "POST")
    check("revelar de novo é idempotente",
          status == 200 and again["result"]["winners"] == winners)

    # ------------------------------------------------------- 4. verificar prova
    print("\n4. verificação independente da prova (em Python)")
    status, proof = req(f"/api/draws/{slug}/proof")
    if not check("prova disponível", status == 200, f"HTTP {status}"):
        return 1

    norm = protocol.normalize_participants(proof["participants"])
    check("hash dos participantes confere",
          protocol.participants_hash(norm).hex() == proof["commitment"]["participants_hash"])

    check("compromisso confere",
          protocol.commit_hash(
              title=proof["title"],
              participants=norm,
              winners_count=proof["commitment"]["winners_count"],
              client_nonce=proof["commitment"]["client_nonce"],
              pool_id=proof["quantum"]["pool_id"],
              pulse_index=proof["quantum"]["pulse_index"],
              drand_round=proof["drand"]["round"],
          ).hex() == proof["commitment"]["commit_hash"])

    check("pulso pertence à raiz de Merkle",
          poolmod.verify_proof(
              proof["quantum"]["pulse_index"],
              bytes.fromhex(proof["quantum"]["pulse_value"]),
              proof["quantum"]["merkle_proof"],
              bytes.fromhex(proof["quantum"]["merkle_root"])))

    if p is not None:
        check("pulso é exatamente o que geramos localmente",
              proof["quantum"]["pulse_value"] == p.pulses[proof["quantum"]["pulse_index"]].hex())

    # Farol buscado direto no drand, sem passar pelo Worker.
    chain = proof["drand"]["chain_hash"]
    rnd = proof["drand"]["round"]
    with urllib.request.urlopen(
            f"https://api.drand.sh/v2/chains/{chain}/rounds/{rnd}", timeout=30) as r:
        beacon = json.loads(r.read())
    check("assinatura do drand confere com a fonte original",
          beacon["signature"].lower() == proof["drand"]["signature"].lower())
    check("aleatoriedade = SHA-256 da assinatura",
          protocol.drand_randomness(beacon["signature"]).hex() == proof["drand"]["randomness"])

    redraw = protocol.run_draw(
        norm,
        proof["commitment"]["winners_count"],
        bytes.fromhex(proof["commitment"]["commit_hash"]),
        bytes.fromhex(proof["quantum"]["pulse_value"]),
        bytes.fromhex(proof["drand"]["randomness"]),
    )
    check("semente recalculada confere", redraw["seed"] == proof["result"]["seed"])
    check("ordem recalculada confere", redraw["order"] == proof["result"]["order"])
    check("vencedores recalculados conferem", redraw["winners"] == winners)

    # ------------------------------------------------------- 5. detectar fraude
    print("\n5. detecção de adulteração")
    forged = protocol.run_draw(
        norm + ["Intruso"], 3,
        bytes.fromhex(proof["commitment"]["commit_hash"]),
        bytes.fromhex(proof["quantum"]["pulse_value"]),
        bytes.fromhex(proof["drand"]["randomness"]))
    check("acrescentar um participante muda o resultado",
          forged["winners"] != winners)
    check("lista adulterada não bate com o compromisso",
          protocol.participants_hash(norm + ["Intruso"]).hex()
          != proof["commitment"]["participants_hash"])

    flipped = bytearray(bytes.fromhex(proof["quantum"]["pulse_value"]))
    flipped[0] ^= 0x01
    check("pulso trocado reprova na Merkle",
          not poolmod.verify_proof(
              proof["quantum"]["pulse_index"], bytes(flipped),
              proof["quantum"]["merkle_proof"],
              bytes.fromhex(proof["quantum"]["merkle_root"])))

    # ------------------------------------------------------- 6. estatísticas
    print("\n6. contadores e listagens")
    status, stats = req("/api/visit", "POST")
    check("visita registrada", status == 200 and stats["pageviews"] >= 1,
          f"pageviews={stats.get('pageviews')}")
    check("visitante único contado", stats["unique_visitors"] >= 1)
    check("sorteios concluídos contados", stats["draws_completed"] >= 1,
          f"draws_completed={stats.get('draws_completed')}")
    check("inscrições somadas", stats["participants_total"] >= len(participants))

    status, recent = req("/api/draws")
    listed = any(d["slug"] == slug for d in recent["draws"])
    if SKIP_POOL:
        check("sorteio de teste NÃO polui a lista pública", not listed)
    else:
        check("sorteio aparece na lista pública", listed)

    status, _ = req("/api/draws/naoexiste123")
    check("sorteio inexistente devolve 404", status == 404, f"HTTP {status}")

    # ------------------------------------------------------- 7. validações
    print("\n7. validação de entrada")
    status, _ = req("/api/draws", "POST", {"title": "x", "participants": ["só um"], "winners_count": 1})
    check("lista com 1 participante é recusada", status == 400, f"HTTP {status}")
    status, _ = req("/api/draws", "POST", {"title": "", "participants": ["a", "b"], "winners_count": 1})
    check("título vazio é recusado", status == 400, f"HTTP {status}")
    status, _ = req("/api/draws", "POST", {"title": "x", "participants": ["a", "b"], "winners_count": 9})
    check("vencedores acima do total é recusado", status == 400, f"HTTP {status}")

    print(f"\n{'-' * 46}")
    total = passed + failed
    color = GREEN if failed == 0 else RED
    print(f"{color}{passed}/{total} verificações passaram{RESET}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
