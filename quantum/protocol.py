"""
Protocolo de sorteio qdraw-v1: compromisso, semente e embaralhamento.

Referência normativa — espelhada byte a byte em ../worker/src/protocol.ts e
em ../web/verify.js. Os três precisam produzir resultados idênticos; é isso
que `selftest.py` garante.

Modelo de confiança
-------------------
A semente do sorteio combina duas fontes que nenhuma parte controla sozinha:

  * o pulso quântico, comprometido numa raiz de Merkle publicada ANTES de o
    sorteio existir — o operador não pode trocar o pulso depois;
  * um round futuro do drand (League of Entropy), imprevisível para todo
    mundo, inclusive para o operador, até o momento em que é assinado.

O compromisso da lista de participantes é calculado antes do round do drand
sair. Então: o participante não sabe o resultado (falta a aleatoriedade) e o
operador também não (não controla o drand, e o pulso já está travado na
árvore). É isso que torna o sorteio verificável e não só auditável.
"""

from __future__ import annotations

import hashlib
import re
import unicodedata
from typing import Sequence

from pool import sha256, u32  # noqa: F401  (reexporta para os CLIs)

# Classe de espaço em branco declarada caractere a caractere de propósito.
# O `\s` do Python e o do JavaScript não são o mesmo conjunto: o JS inclui
# ﻿ e o Python não; o Python inclui \x1c-\x1f e \x85 e o JS não. Deixar
# no padrão faria a mesma lista de participantes hashear diferente no
# servidor e no verificador do browser para nomes com caracteres exóticos —
# uma prova que falha sem motivo. Este regex é replicado, idêntico, em
# worker/src/protocol.ts.
_WS = re.compile(
    "[\t\n\x0b\x0c\r \x1c\x1d\x1e\x1f\x85\xa0\u1680\u2000-\u200a"
    "\u2028\u2029\u202f\u205f\u3000\ufeff]+"
)


# ------------------------------------------------------------ compromisso

def normalize_participants(raw: Sequence[str]) -> list[str]:
    """Canonicaliza a lista para que o hash não dependa de espaços invisíveis.

    NFC + trim + colapso de espaços internos. Duplicatas são preservadas de
    propósito: quem aparece duas vezes tem duas chances (é um recurso comum
    em sorteio por número de bilhetes).
    """
    out: list[str] = []
    for item in raw:
        s = unicodedata.normalize("NFC", str(item))
        s = _WS.sub(" ", s).strip()
        if s:
            out.append(s)
    return out


def participants_hash(participants: Sequence[str]) -> bytes:
    if not participants:
        raise ValueError("lista de participantes vazia")
    body = "\n".join(participants) + "\n"
    return sha256(b"qdraw/v1/participants\n", body.encode("utf-8"))


def commit_hash(title: str, participants: Sequence[str], winners_count: int,
                client_nonce: str, pool_id: str, pulse_index: int,
                drand_round: int) -> bytes:
    """Compromisso que amarra tudo que o sorteio é ao que vai sorteá-lo.

    Incluir pool_id, pulse_index e drand_round no compromisso impede que o
    operador reaponte um sorteio já criado para outra aleatoriedade depois de
    ver os participantes.
    """
    ph = participants_hash(participants)
    parts = "\n".join([
        "qdraw/v1/commit",
        unicodedata.normalize("NFC", title),
        str(int(winners_count)),
        str(len(participants)),
        ph.hex(),
        client_nonce,
        pool_id,
        str(int(pulse_index)),
        str(int(drand_round)),
    ]) + "\n"
    return sha256(parts.encode("utf-8"))


def lottery_commit_hash(title: str, lottery_id: str, games: int, picks: int,
                        extra_picks: int, client_nonce: str, pool_id: str,
                        pulse_index: int, drand_round: int) -> bytes:
    """Compromisso da geração de jogos de loteria.

    Separador de domínio próprio: um compromisso de loteria nunca pode colidir
    com um de sorteio de lista, nem ser reinterpretado como tal.
    """
    parts = "\n".join([
        "qdraw/v1/lottery-commit",
        unicodedata.normalize("NFC", title),
        lottery_id,
        str(int(games)),
        str(int(picks)),
        str(int(extra_picks)),
        client_nonce,
        pool_id,
        str(int(pulse_index)),
        str(int(drand_round)),
    ]) + "\n"
    return sha256(parts.encode("utf-8"))


# ---------------------------------------------------------------- semente

def drand_randomness(signature_hex: str) -> bytes:
    """No quicknet (bls-unchained-g1-rfc9380) a aleatoriedade é SHA-256 da assinatura."""
    return hashlib.sha256(bytes.fromhex(signature_hex)).digest()


def derive_seed(commit: bytes, pulse: bytes, randomness: bytes) -> bytes:
    return sha256(b"qdraw/v1/seed", commit, pulse, randomness)


# ------------------------------------------------------------------ DRBG

class Drbg:
    """Gerador determinístico em counter mode sobre SHA-256.

    Cada bloco é H("qdraw/v1/drbg" || seed || contador), lido como palavras
    de 32 bits big-endian. Determinístico e trivialmente reimplementável em
    qualquer linguagem — o que é exatamente o requisito de um verificador
    independente.
    """

    def __init__(self, seed: bytes):
        self.seed = seed
        self._counter = 0
        self._buf = b""
        self._pos = 0

    def _refill(self) -> None:
        self._buf = sha256(b"qdraw/v1/drbg", self.seed, u32(self._counter))
        self._counter += 1
        self._pos = 0

    def next_u32(self) -> int:
        if self._pos + 4 > len(self._buf):
            self._refill()
        word = int.from_bytes(self._buf[self._pos : self._pos + 4], "big")
        self._pos += 4
        return word

    def below(self, n: int) -> int:
        """Inteiro uniforme em [0, n) por amostragem com rejeição.

        `x % n` puro enviesaria para os índices baixos sempre que n não
        divide 2^32 — com 60 participantes o desvio é pequeno, mas num
        sorteio que se diz verificável não dá para ter viés nenhum.
        """
        if n <= 0:
            raise ValueError("n deve ser positivo")
        if n == 1:
            return 0
        limit = (0x100000000 // n) * n
        while True:
            x = self.next_u32()
            if x < limit:
                return x % n


def shuffle(items: Sequence[str], seed: bytes) -> list[str]:
    """Fisher-Yates descendente, com índices vindos do DRBG."""
    arr = list(items)
    rng = Drbg(seed)
    for i in range(len(arr) - 1, 0, -1):
        j = rng.below(i + 1)
        arr[i], arr[j] = arr[j], arr[i]
    return arr


def run_draw(participants: Sequence[str], winners_count: int, commit: bytes,
             pulse: bytes, randomness: bytes) -> dict:
    """Executa o sorteio completo e devolve a ordem final e os vencedores."""
    seed = derive_seed(commit, pulse, randomness)
    order = shuffle(participants, seed)
    return {
        "seed": seed.hex(),
        "order": order,
        "winners": order[:winners_count],
    }
