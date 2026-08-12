"""
Geração de jogos das Loterias Caixa a partir da mesma semente verificável.

O ponto não é "aumentar a chance" — não aumenta, e o site diz isso. O que muda
é a prova: como o compromisso é calculado antes de o pulso quântico ser
revelado e antes de o round do drand existir, dá para demonstrar que os números
foram gerados **antes** do sorteio da Caixa acontecer. Num bolão isso resolve a
desconfiança clássica de que o organizador escolheu os números depois.

Regras conferidas contra a API pública da Caixa
(servicebus2.caixa.gov.br/portaldeloterias/api) e a documentação oficial em
agosto de 2026. Cuidado ao mexer: quantidade errada gera bilhete inválido.

Espelhado em ../worker/src/lottery.ts — os vetores de teste garantem paridade.
"""

from __future__ import annotations

from typing import Sequence

from protocol import Drbg

# `picks` é quanto o apostador marca, não quanto a Caixa sorteia. Timemania é o
# caso que mais confunde: aposta-se 10 dezenas e são sorteadas 7.
LOTTERIES: dict[str, dict] = {
    "megasena": {"lo": 1, "hi": 60, "min": 6, "max": 20, "default": 6},
    "lotofacil": {"lo": 1, "hi": 25, "min": 15, "max": 20, "default": 15},
    "quina": {"lo": 1, "hi": 80, "min": 5, "max": 15, "default": 5},
    "lotomania": {"lo": 0, "hi": 99, "min": 50, "max": 50, "default": 50},
    "duplasena": {"lo": 1, "hi": 50, "min": 6, "max": 15, "default": 6},
    "timemania": {"lo": 1, "hi": 80, "min": 10, "max": 10, "default": 10},
    "diadesorte": {
        "lo": 1, "hi": 31, "min": 7, "max": 15, "default": 7,
        "extra": "mes",
    },
    "maismilionaria": {
        "lo": 1, "hi": 50, "min": 6, "max": 12, "default": 6,
        "extra": "trevos", "extra_lo": 1, "extra_hi": 6,
        "extra_min": 2, "extra_max": 6, "extra_default": 2,
    },
    # Sete colunas independentes; em cada uma marca-se de 1 a 3 algarismos.
    "supersete": {"lo": 0, "hi": 9, "min": 1, "max": 3, "default": 1, "columns": 7},
}

MESES = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
         "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"]

MAX_GAMES = 100


class LotteryError(ValueError):
    pass


def pick_distinct(rng: Drbg, count: int, lo: int, hi: int) -> list[int]:
    """`count` inteiros distintos em [lo, hi], em ordem crescente.

    Fisher-Yates parcial sobre o intervalo inteiro: cada subconjunto tem a
    mesma probabilidade, e os índices vêm do DRBG com amostragem por rejeição —
    sem viés em nenhuma etapa.
    """
    total = hi - lo + 1
    if not 1 <= count <= total:
        raise LotteryError(f"não dá para tirar {count} de {total} números")
    pool = list(range(lo, hi + 1))
    for i in range(count):
        j = i + rng.below(total - i)
        pool[i], pool[j] = pool[j], pool[i]
    return sorted(pool[:count])


def validate(lottery_id: str, games: int, picks: int | None,
             extra_picks: int | None) -> tuple[dict, int, int]:
    """Normaliza e valida os parâmetros; devolve (spec, picks, extra_picks)."""
    spec = LOTTERIES.get(lottery_id)
    if spec is None:
        raise LotteryError(f"loteria desconhecida: {lottery_id}")

    if not 1 <= games <= MAX_GAMES:
        raise LotteryError(f"quantidade de jogos fora do intervalo 1..{MAX_GAMES}")

    p = spec["default"] if picks is None else int(picks)
    if not spec["min"] <= p <= spec["max"]:
        raise LotteryError(
            f"{lottery_id} aceita de {spec['min']} a {spec['max']} números, recebi {p}")

    e = 0
    if spec.get("extra") == "trevos":
        e = spec["extra_default"] if extra_picks is None else int(extra_picks)
        if not spec["extra_min"] <= e <= spec["extra_max"]:
            raise LotteryError(
                f"trevos devem ser de {spec['extra_min']} a {spec['extra_max']}, recebi {e}")

    return spec, p, e


def generate(lottery_id: str, games: int, picks: int | None, extra_picks: int | None,
             seed: bytes) -> list[dict]:
    """Gera os jogos de forma determinística a partir da semente."""
    spec, p, e = validate(lottery_id, games, picks, extra_picks)
    rng = Drbg(seed)
    out: list[dict] = []

    for _ in range(games):
        game: dict = {}
        if spec.get("columns"):
            # Super Sete: cada coluna é um sorteio independente de algarismos.
            game["columns"] = [
                pick_distinct(rng, p, spec["lo"], spec["hi"])
                for _ in range(spec["columns"])
            ]
        else:
            game["numbers"] = pick_distinct(rng, p, spec["lo"], spec["hi"])

        extra = spec.get("extra")
        if extra == "mes":
            game["mes"] = MESES[rng.below(12)]
        elif extra == "trevos":
            game["trevos"] = pick_distinct(rng, e, spec["extra_lo"], spec["extra_hi"])

        out.append(game)

    return out


def format_game(lottery_id: str, game: dict) -> str:
    """Representação em texto, do jeito que se anota num volante."""
    spec = LOTTERIES[lottery_id]
    width = len(str(spec["hi"]))
    if "columns" in game:
        return " | ".join("".join(str(d) for d in col) for col in game["columns"])
    parts = [" ".join(str(n).zfill(width) for n in game["numbers"])]
    if "trevos" in game:
        parts.append("trevos: " + " ".join(str(t) for t in game["trevos"]))
    if "mes" in game:
        parts.append("mês: " + game["mes"])
    return "  ·  ".join(parts)
