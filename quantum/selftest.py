#!/usr/bin/env python3
"""
Testes do protocolo + gerador dos vetores compartilhados entre linguagens.

    python selftest.py           # roda os testes
    python selftest.py --emit    # regrava ../worker/test/vectors.json

O arquivo de vetores é consumido por worker/test/protocol.test.mjs e por
web/verify.js. Se Python e TypeScript divergirem em um único byte, o
verificador independente acusa — que é justamente o ponto do projeto.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import Counter

import lottery
import pool as poolmod
import protocol

VECTORS_PATH = os.path.join(os.path.dirname(__file__), "..", "worker", "test", "vectors.json")


def deterministic_pulses(n: int) -> list[bytes]:
    """Pulsos fixos e reprodutíveis, para os vetores não dependerem de acaso."""
    return [poolmod.sha256(b"qdraw/test/pulse", poolmod.u32(i)) for i in range(n)]


def deterministic_bits(n: int) -> list[int]:
    """Fluxo de bits reprodutível, no lugar da saída da QPU."""
    out: list[int] = []
    counter = 0
    while len(out) < n:
        block = poolmod.sha256(b"qdraw/test/rawbits", poolmod.u32(counter))
        counter += 1
        for byte in block:
            out.extend((byte >> (7 - j)) & 1 for j in range(8))
    return out[:n]


# ------------------------------------------------------------------ testes

def test_von_neumann() -> None:
    assert protocol.sha256(b"") == poolmod.sha256(b"")
    assert poolmod.von_neumann([0, 1, 1, 0, 0, 0, 1, 1]) == [0, 1]
    assert poolmod.von_neumann([1, 1, 0, 0]) == []
    assert poolmod.von_neumann([0, 1]) == [0]
    # Uma moeda viciada em 90% de 1s tem que sair equilibrada depois do VN.
    import random
    rnd = random.Random(1234)
    biased = [1 if rnd.random() < 0.9 else 0 for _ in range(400_000)]
    out = poolmod.von_neumann(biased)
    ratio = sum(out) / len(out)
    assert 0.47 < ratio < 0.53, f"von Neumann não removeu o viés: {ratio}"
    print(f"  von Neumann: viés 0.900 -> {ratio:.3f} ({len(out)} bits)")


def test_bits_bytes() -> None:
    assert poolmod.bits_to_bytes([1, 0, 1, 0, 0, 0, 0, 1]) == bytes([0b10100001])
    assert poolmod.bits_to_bytes([1, 1, 1]) == b""


def test_merkle() -> None:
    for n in (1, 2, 3, 4, 5, 7, 8, 9, 16, 17, 100, 720):
        pulses = deterministic_pulses(n)
        root = poolmod.merkle_root(pulses)
        for idx in {0, n // 2, n - 1}:
            proof = poolmod.merkle_proof(pulses, idx)
            assert poolmod.verify_proof(idx, pulses[idx], proof, root), \
                f"prova falhou para n={n} idx={idx}"
            # Pulso trocado tem que reprovar.
            forged = bytes(32)
            assert not poolmod.verify_proof(idx, forged, proof, root)
            # Índice trocado também (é por isso que o índice entra na folha).
            if n > 1:
                other = (idx + 1) % n
                assert not poolmod.verify_proof(other, pulses[idx], proof, root)
    print(f"  Merkle: provas válidas e forjadas rejeitadas em 12 tamanhos de árvore")


def test_drbg_uniform() -> None:
    """O DRBG com rejeição não pode enviesar índices."""
    n = 60
    counts = Counter()
    trials = 120_000
    rng = protocol.Drbg(poolmod.sha256(b"uniformidade"))
    for _ in range(trials):
        counts[rng.below(n)] += 1
    expected = trials / n
    chi2 = sum((c - expected) ** 2 / expected for c in counts.values())
    # 59 graus de liberdade: o valor crítico a 99.9% é ~99.6.
    assert len(counts) == n, f"nem todos os {n} valores saíram"
    assert chi2 < 99.6, f"chi2={chi2:.1f} — distribuição suspeita"
    print(f"  DRBG: chi2={chi2:.1f} em {trials:,} amostras sobre {n} valores (crítico 99.6)")


def test_shuffle_is_permutation() -> None:
    items = [f"p{i:03d}" for i in range(200)]
    seed = poolmod.sha256(b"permutacao")
    out = protocol.shuffle(items, seed)
    assert sorted(out) == sorted(items), "embaralhamento perdeu ou duplicou elementos"
    assert out != items, "embaralhamento devolveu a lista intacta"
    # Determinismo: mesma semente, mesmo resultado.
    assert protocol.shuffle(items, seed) == out


def test_normalization() -> None:
    got = protocol.normalize_participants(["  Ana  Maria ", "", "  ", "João\tSilva"])
    assert got == ["Ana Maria", "João Silva"], got
    # NFC: "é" composto e "é" decomposto têm que colidir no mesmo hash.
    a = protocol.participants_hash(protocol.normalize_participants(["José"]))
    b = protocol.participants_hash(protocol.normalize_participants(["José"]))
    assert a == b, "NFC não normalizou"


def test_commit_binds_everything() -> None:
    base = dict(title="Sorteio", participants=["a", "b", "c"], winners_count=1,
                client_nonce="ff00", pool_id="abc123", pulse_index=5, drand_round=99)
    h0 = protocol.commit_hash(**base)
    for field, value in [("title", "Outro"), ("winners_count", 2), ("client_nonce", "ff01"),
                         ("pool_id", "abc124"), ("pulse_index", 6), ("drand_round", 100)]:
        mutated = dict(base, **{field: value})
        assert protocol.commit_hash(**mutated) != h0, f"commit ignorou {field}"
    mutated = dict(base, participants=["a", "b", "d"])
    assert protocol.commit_hash(**mutated) != h0, "commit ignorou participantes"
    print("  commit: sensível a todos os 7 campos amarrados")


def test_lottery_rules() -> None:
    """Cada modalidade respeita quantidade e intervalo oficiais."""
    seed = poolmod.sha256(b"regras")
    for lid, spec in lottery.LOTTERIES.items():
        for picks in {spec["min"], spec["max"], spec["default"]}:
            extra = spec.get("extra_default")
            games = lottery.generate(lid, 3, picks, extra, seed)
            assert len(games) == 3
            for g in games:
                if "columns" in g:
                    assert len(g["columns"]) == spec["columns"]
                    for col in g["columns"]:
                        assert len(col) == picks
                        assert len(set(col)) == picks, "algarismo repetido na coluna"
                        assert all(spec["lo"] <= d <= spec["hi"] for d in col)
                else:
                    ns = g["numbers"]
                    assert len(ns) == picks, f"{lid}: {len(ns)} != {picks}"
                    assert len(set(ns)) == picks, f"{lid}: número repetido"
                    assert ns == sorted(ns), f"{lid}: fora de ordem"
                    assert all(spec["lo"] <= n <= spec["hi"] for n in ns), f"{lid}: fora do intervalo"
                if spec.get("extra") == "mes":
                    assert g["mes"] in lottery.MESES
                if spec.get("extra") == "trevos":
                    assert len(g["trevos"]) == spec["extra_default"]
                    assert all(1 <= t <= 6 for t in g["trevos"])
    print(f"  loterias: {len(lottery.LOTTERIES)} modalidades dentro das regras")


def test_lottery_rejects_invalid() -> None:
    seed = poolmod.sha256(b"invalido")
    for lid, games, picks in [("megasena", 1, 5), ("megasena", 1, 21),
                              ("lotofacil", 1, 14), ("quina", 1, 16),
                              ("desconhecida", 1, 6), ("megasena", 0, 6),
                              ("megasena", 101, 6)]:
        try:
            lottery.generate(lid, games, picks, None, seed)
            raise AssertionError(f"deveria recusar {lid} games={games} picks={picks}")
        except lottery.LotteryError:
            pass
    # Trevos fora do intervalo
    try:
        lottery.generate("maismilionaria", 1, 6, 7, seed)
        raise AssertionError("deveria recusar 7 trevos")
    except lottery.LotteryError:
        pass


def test_lottery_uniform() -> None:
    """Nenhuma dezena da Mega-Sena pode aparecer mais que as outras."""
    from collections import Counter
    counts = Counter()
    rounds = 4000
    for i in range(rounds):
        seed = poolmod.sha256(b"uniforme-loteria", poolmod.u32(i))
        for g in lottery.generate("megasena", 1, 6, None, seed):
            counts.update(g["numbers"])
    assert len(counts) == 60, "nem todas as 60 dezenas saíram"
    expected = rounds * 6 / 60
    chi2 = sum((c - expected) ** 2 / expected for c in counts.values())
    # 59 graus de liberdade, crítico a 99.9% ~ 99.6
    assert chi2 < 99.6, f"chi2={chi2:.1f} — dezenas enviesadas"
    print(f"  Mega-Sena: chi2={chi2:.1f} em {rounds} jogos (crítico 99.6)")


def test_lottery_determinism() -> None:
    seed = poolmod.sha256(b"determinismo")
    a = lottery.generate("megasena", 5, 6, None, seed)
    b = lottery.generate("megasena", 5, 6, None, seed)
    assert a == b
    other = lottery.generate("megasena", 5, 6, None, poolmod.sha256(b"outra"))
    assert a != other
    # Jogos diferentes dentro da mesma geração (probabilidade de colisão ~0)
    assert len({tuple(g["numbers"]) for g in a}) == 5


def test_pool_roundtrip() -> None:
    import random
    rnd = random.Random(7)
    bits = [rnd.getrandbits(1) for _ in range(poolmod.raw_bits_needed(32))]
    p = poolmod.build_pool(bits, 32, 60, {"provider": "test"}, genesis_time=1_700_000_000)
    assert len(p.pulses) == 32
    assert all(len(x) == 32 for x in p.pulses)
    assert len(set(p.pulses)) == 32, "pulsos repetidos no pool"
    assert p.reveal_time(0) == 1_700_000_000
    assert p.reveal_time(10) == 1_700_000_600
    parsed = json.loads(p.to_json())
    assert parsed["merkle_root"] == p.merkle_root.hex()
    assert parsed["pulse_count"] == 32


# ------------------------------------------------------------------ vetores

def build_vectors() -> dict:
    pulses = deterministic_pulses(9)  # ímpar de propósito: exercita a promoção
    root = poolmod.merkle_root(pulses)
    idx = 3
    proof = poolmod.merkle_proof(pulses, idx)

    participants = protocol.normalize_participants(
        ["Ana", "Bruno", "Carla", "Diego", "Élia", "Fábio", "Gina", "Hugo",
         "Íris", "João", "Kátia", "Lucas"]
    )
    signature = ("8fde280eba167af1a961f135a5bac89cb3e0b1e5d6b24d9768f03b478e3242f3"
                 "49c275c19a3dad43819540f4fa08f681")
    randomness = protocol.drand_randomness(signature)
    commit = protocol.commit_hash(
        title="Sorteio de teste",
        participants=participants,
        winners_count=3,
        client_nonce="00112233445566778899aabbccddeeff",
        pool_id="deadbeefcafe0001",
        pulse_index=idx,
        drand_round=31_237_368,
    )
    result = protocol.run_draw(participants, 3, commit, pulses[idx], randomness)

    # Construção completa do pool: o Worker faz isto em TypeScript, então cada
    # etapa intermediária vira vetor para o porte não divergir em silêncio.
    n_raw = poolmod.raw_bits_needed(12)
    raw = deterministic_bits(n_raw)
    vn = poolmod.von_neumann(raw)
    vn_bytes = poolmod.bits_to_bytes(vn)
    conditioned = poolmod.condition(vn_bytes, 12 * poolmod.PULSE_BYTES)
    built = poolmod.build_pool(raw, 12, 60, {"provider": "test"},
                               genesis_time=1_800_000_000)

    # Jogos de loteria: um vetor por modalidade, cobrindo colunas (Super Sete),
    # trevos (+Milionária) e mês (Dia de Sorte).
    lot_seed = poolmod.sha256(b"vetor-loteria")
    lot_cases = [
        ("megasena", 3, None, None), ("lotofacil", 2, 15, None),
        ("quina", 2, 7, None), ("lotomania", 1, None, None),
        ("duplasena", 2, 6, None), ("timemania", 2, None, None),
        ("diadesorte", 2, 7, None), ("maismilionaria", 2, 6, 3),
        ("supersete", 2, 2, None),
    ]
    lot_vectors = {}
    for lid, games, picks, extra in lot_cases:
        lot_vectors[lid] = {
            "games": games, "picks": picks, "extra_picks": extra,
            "result": lottery.generate(lid, games, picks, extra, lot_seed),
        }

    drbg = protocol.Drbg(poolmod.sha256(b"vetor-drbg"))
    return {
        "lottery": {
            "seed": lot_seed.hex(),
            "catalog": lottery.LOTTERIES,
            "meses": lottery.MESES,
            "cases": lot_vectors,
            "commit": protocol.lottery_commit_hash(
                title="Bolão do trabalho", lottery_id="megasena", games=5, picks=6,
                extra_picks=0, client_nonce="00112233445566778899aabbccddeeff",
                pool_id="deadbeefcafe0001", pulse_index=3, drand_round=31_237_368,
            ).hex(),
        },
        "pool_build": {
            "raw_bits": n_raw,
            "raw_prefix_hex": poolmod.bits_to_bytes(raw[:256]).hex(),
            "von_neumann_bits": len(vn),
            "von_neumann_hex": vn_bytes.hex(),
            "conditioned_hex": conditioned.hex(),
            "pulse_count": 12,
            "period": 60,
            "genesis_time": 1_800_000_000,
            "pool_id": built.pool_id,
            "merkle_root": built.merkle_root.hex(),
            "pulses": [p.hex() for p in built.pulses],
        },
        "protocol": poolmod.PROTOCOL,
        "note": "Gerado por quantum/selftest.py --emit. Não editar à mão.",
        "sha256_empty": poolmod.sha256(b"").hex(),
        "merkle": {
            "pulses": [p.hex() for p in pulses],
            "root": root.hex(),
            "index": idx,
            "proof": proof,
        },
        "participants": participants,
        "participants_hash": protocol.participants_hash(participants).hex(),
        "commit": {
            "title": "Sorteio de teste",
            "winners_count": 3,
            "client_nonce": "00112233445566778899aabbccddeeff",
            "pool_id": "deadbeefcafe0001",
            "pulse_index": idx,
            "drand_round": 31_237_368,
            "hash": commit.hex(),
        },
        "drand": {"signature": signature, "randomness": randomness.hex()},
        "draw": {
            "pulse": pulses[idx].hex(),
            "seed": result["seed"],
            "order": result["order"],
            "winners": result["winners"],
        },
        "drbg": {
            "seed": poolmod.sha256(b"vetor-drbg").hex(),
            "first_u32": [drbg.next_u32() for _ in range(8)],
            "below_60": [protocol.Drbg(poolmod.sha256(b"vetor-drbg")).below(60)
                         for _ in range(1)][0],
        },
        "normalization": {
            "input": ["  Ana  Maria ", "", "José"],
            "output": protocol.normalize_participants(["  Ana  Maria ", "", "José"]),
        },
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--emit", action="store_true", help="regrava worker/test/vectors.json")
    args = ap.parse_args()

    tests = [
        test_von_neumann, test_bits_bytes, test_merkle, test_drbg_uniform,
        test_shuffle_is_permutation, test_normalization,
        test_commit_binds_everything, test_pool_roundtrip,
        test_lottery_rules, test_lottery_rejects_invalid,
        test_lottery_uniform, test_lottery_determinism,
    ]
    print("qdraw-v1 — testes do protocolo\n")
    for t in tests:
        t()
        print(f"  \033[32mok\033[0m {t.__name__}")
    print(f"\n{len(tests)} testes passaram.")

    if args.emit:
        vectors = build_vectors()
        os.makedirs(os.path.dirname(VECTORS_PATH), exist_ok=True)
        with open(VECTORS_PATH, "w", encoding="utf-8") as f:
            json.dump(vectors, f, indent=2, ensure_ascii=False)
            f.write("\n")
        print(f"\nvetores gravados em {os.path.relpath(VECTORS_PATH)}")
        print(f"  vencedores de referência: {vectors['draw']['winners']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
