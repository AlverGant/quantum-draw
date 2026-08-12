"""
Núcleo criptográfico do pool de entropia quântica (protocolo qdraw-v1).

Este módulo é a referência normativa do protocolo. Cada função aqui tem uma
contraparte byte-a-byte idêntica em ../worker/src/protocol.ts. Se você mudar
uma, mude a outra e rode `python selftest.py --emit` para regerar os vetores
de teste compartilhados.
"""

from __future__ import annotations

import hashlib
import json
import time
from dataclasses import dataclass, field
from typing import Sequence

PROTOCOL = "qdraw-v1"
PULSE_BYTES = 32

# Separação de domínio: o prefixo impede que um nó interno da árvore seja
# reinterpretado como folha (ataque clássico de segunda pré-imagem em Merkle).
LEAF_TAG = b"\x00"
NODE_TAG = b"\x01"


def sha256(*chunks: bytes) -> bytes:
    h = hashlib.sha256()
    for c in chunks:
        h.update(c)
    return h.digest()


def u32(n: int) -> bytes:
    return int(n).to_bytes(4, "big")


# --------------------------------------------------------------- extração

def von_neumann(bits: Sequence[int]) -> list[int]:
    """Debiasing de von Neumann: 01 -> 0, 10 -> 1, descarta 00 e 11.

    Elimina viés de primeira ordem (P(1) != 0.5) sem precisar saber qual é o
    viés. Pressupõe bits i.i.d. — e uma QPU real não entrega isso: tem
    crosstalk entre qubits vizinhos e deriva de calibração ao longo do job.
    Por isso o resultado ainda passa pelo condicionamento SHA-256 abaixo.
    Rendimento esperado: ~25% dos bits de entrada.
    """
    out: list[int] = []
    for i in range(0, len(bits) - 1, 2):
        a, b = bits[i], bits[i + 1]
        if a != b:
            out.append(a)
    return out


def bits_to_bytes(bits: Sequence[int]) -> bytes:
    """Empacota bits em bytes, big-endian, descartando o resto incompleto."""
    n = len(bits) // 8
    out = bytearray(n)
    for i in range(n):
        byte = 0
        for j in range(8):
            byte = (byte << 1) | (bits[i * 8 + j] & 1)
        out[i] = byte
    return bytes(out)


def condition(data: bytes, out_len: int) -> bytes:
    """Condicionamento SHA-256 com compressão 2:1.

    Componente de condicionamento no espírito do NIST SP 800-90B: consome 64
    bytes por bloco e emite 32. Mesmo que os bits pós-von-Neumann tenham
    correlação residual, comprimir 2:1 num hash criptográfico entrega uma
    saída computacionalmente indistinguível de uniforme, desde que a entrada
    tenha pelo menos ~0.5 bit de min-entropia por bit.
    """
    blocks = (out_len + 31) // 32
    need = blocks * 64
    if len(data) < need:
        raise ValueError(
            f"entropia insuficiente: preciso de {need} bytes pós-von-Neumann, "
            f"recebi {len(data)}"
        )
    out = bytearray()
    for b in range(blocks):
        chunk = data[b * 64 : (b + 1) * 64]
        out += sha256(b"qdraw/v1/cond", u32(b), chunk)
    return bytes(out[:out_len])


def raw_bits_needed(pulse_count: int) -> int:
    """Quantos bits crus da QPU são precisos para `pulse_count` pulsos.

    Cada pulso tem 32 bytes -> 64 bytes de entrada no condicionador -> 512
    bits pós-von-Neumann -> ~2048 bits crus (rendimento de 25%). Sobra uma
    folga de 15% porque o rendimento real varia com o viés do backend.
    """
    vn_bits = pulse_count * 64 * 8
    return int(vn_bits * 4 * 1.15)


# ----------------------------------------------------------------- merkle

def merkle_leaf(index: int, pulse: bytes) -> bytes:
    """Folha = H(0x00 || índice || pulso).

    O índice entra no hash para que um pulso não possa ser reapresentado numa
    posição diferente da árvore.
    """
    if len(pulse) != PULSE_BYTES:
        raise ValueError(f"pulso deve ter {PULSE_BYTES} bytes, tem {len(pulse)}")
    return sha256(LEAF_TAG, u32(index), pulse)


def _levels(leaves: list[bytes]) -> list[list[bytes]]:
    """Constrói todos os níveis da árvore, da base até a raiz.

    Nó ímpar sobe promovido (sem duplicação). Duplicar o último nó — como faz
    o Bitcoin — cria ambiguidade entre árvores diferentes; promover não.
    """
    if not leaves:
        raise ValueError("árvore vazia")
    levels = [leaves]
    cur = leaves
    while len(cur) > 1:
        nxt: list[bytes] = []
        for i in range(0, len(cur), 2):
            if i + 1 < len(cur):
                nxt.append(sha256(NODE_TAG, cur[i], cur[i + 1]))
            else:
                nxt.append(cur[i])
        levels.append(nxt)
        cur = nxt
    return levels


def merkle_root(pulses: list[bytes]) -> bytes:
    leaves = [merkle_leaf(i, p) for i, p in enumerate(pulses)]
    return _levels(leaves)[-1][0]


def merkle_proof(pulses: list[bytes], index: int) -> list[dict]:
    """Caminho de autenticação do pulso `index` até a raiz.

    Retorna uma lista de {"hash": hex, "left": bool}, onde `left` diz se o
    irmão fica à esquerda do nó corrente.
    """
    if not 0 <= index < len(pulses):
        raise IndexError(f"índice {index} fora do pool de {len(pulses)} pulsos")
    leaves = [merkle_leaf(i, p) for i, p in enumerate(pulses)]
    levels = _levels(leaves)
    proof: list[dict] = []
    idx = index
    for level in levels[:-1]:
        sibling = idx ^ 1
        if sibling < len(level):
            proof.append({"hash": level[sibling].hex(), "left": sibling < idx})
        # Sem irmão => o nó foi promovido; nada a registrar neste nível.
        idx //= 2
    return proof


def verify_proof(index: int, pulse: bytes, proof: list[dict], root: bytes) -> bool:
    h = merkle_leaf(index, pulse)
    for step in proof:
        sib = bytes.fromhex(step["hash"])
        h = sha256(NODE_TAG, sib, h) if step["left"] else sha256(NODE_TAG, h, sib)
    return h == root


# ------------------------------------------------------------------- pool

@dataclass
class Pool:
    pool_id: str
    genesis_time: int
    period: int
    pulses: list[bytes]
    source: dict = field(default_factory=dict)

    @property
    def merkle_root(self) -> bytes:
        return merkle_root(self.pulses)

    def reveal_time(self, index: int) -> int:
        return self.genesis_time + index * self.period

    def to_json(self) -> str:
        return json.dumps(
            {
                "protocol": PROTOCOL,
                "pool_id": self.pool_id,
                "genesis_time": self.genesis_time,
                "period": self.period,
                "pulse_count": len(self.pulses),
                "merkle_root": self.merkle_root.hex(),
                "source": self.source,
                "pulses": [p.hex() for p in self.pulses],
            },
            indent=2,
            ensure_ascii=False,
        )


def build_pool(raw_bits: Sequence[int], pulse_count: int, period: int,
               source: dict, genesis_time: int | None = None) -> Pool:
    """Transforma bits crus da QPU num pool de pulsos com raiz de Merkle."""
    vn = von_neumann(raw_bits)
    material = bits_to_bytes(vn)
    conditioned = condition(material, pulse_count * PULSE_BYTES)
    pulses = [
        conditioned[i * PULSE_BYTES : (i + 1) * PULSE_BYTES]
        for i in range(pulse_count)
    ]

    if genesis_time is None:
        # Primeiro pulso só fica revelável no próximo múltiplo do período,
        # com uma folga de um período inteiro para a publicação acontecer.
        now = int(time.time())
        genesis_time = ((now // period) + 2) * period

    source = dict(source)
    source.update(
        {
            "raw_bits": len(raw_bits),
            "von_neumann_bits": len(vn),
            "von_neumann_yield": round(len(vn) / max(len(raw_bits), 1), 4),
            "ones_ratio_raw": round(sum(raw_bits) / max(len(raw_bits), 1), 6),
        }
    )

    pool_id = sha256(
        b"qdraw/v1/pool-id",
        merkle_root(pulses),
        u32(genesis_time),
    ).hex()[:16]

    return Pool(pool_id, genesis_time, period, pulses, source)
