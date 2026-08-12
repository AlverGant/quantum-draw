"""
Fontes de entropia física para o pool.

Ordem de preferência:
  1. IBM Quantum  — circuito nosso, hardware supercondutor real, job auditável
  2. ANU QRNG     — entropia fotônica (flutuação de vácuo) via API HTTP
  3. local        — os.urandom, SÓ para desenvolvimento; marcado como não-quântico

A fonte usada fica registrada no campo `source` do pool e aparece na página
pública do sorteio. Um pool `local` é rotulado como tal no site — a ideia é
que ninguém possa confundir um pool de teste com um pool real.
"""

from __future__ import annotations

import os
import time

# Circuito: H em todos os qubits e mede. Cada shot devolve um bitstring de
# `n_qubits` bits, cada bit vindo do colapso de uma superposição |+>.
# Um pool de 24h cabe em um job só num backend de 156 qubits (~21,7 mil shots).
# Dividir em dois jobs pagaria a sobrecarga fixa de enfileiramento duas vezes,
# e o plano Open tem apenas 10 minutos de QPU por mês.
DEFAULT_SHOTS_PER_JOB = 50_000


class EntropyError(RuntimeError):
    pass


# ------------------------------------------------------------ IBM Quantum

def from_ibm(n_bits: int, token: str | None = None, instance: str | None = None,
             backend_name: str | None = None, verbose: bool = True) -> tuple[list[int], dict]:
    """Coleta `n_bits` bits medindo superposições numa QPU da IBM.

    Usa qiskit-ibm-runtime >= 0.40 (canal `ibm_quantum_platform`). O canal
    antigo `ibm_quantum` foi desligado em 2025 junto com o qiskit-ibm-provider,
    então nada de `execute()` nem `IBMProvider` aqui.
    """
    try:
        from qiskit import QuantumCircuit
        from qiskit.transpiler.preset_passmanagers import generate_preset_pass_manager
        from qiskit_ibm_runtime import QiskitRuntimeService, SamplerV2
    except ImportError as e:  # pragma: no cover
        raise EntropyError(
            "qiskit não instalado. Rode: pip install -r requirements.txt"
        ) from e

    token = token or os.environ.get("IBM_QUANTUM_TOKEN")
    instance = instance or os.environ.get("IBM_QUANTUM_INSTANCE")
    if not token:
        raise EntropyError("IBM_QUANTUM_TOKEN não definido")

    # instance="auto" deixa o runtime escolher entre as instâncias da conta e
    # evita o aviso de instanciação sem instância explícita.
    service = QiskitRuntimeService(
        channel="ibm_quantum_platform", token=token, instance=instance or "auto"
    )

    if backend_name:
        backend = service.backend(backend_name)
    else:
        backend = service.least_busy(operational=True, simulator=False)
    n_qubits = backend.num_qubits
    if verbose:
        print(f"[ibm] backend: {backend.name} ({n_qubits} qubits)")

    qc = QuantumCircuit(n_qubits)
    qc.h(range(n_qubits))
    qc.measure_all()

    pm = generate_preset_pass_manager(optimization_level=1, backend=backend)
    isa_circuit = pm.run(qc)

    bits: list[int] = []
    jobs: list[str] = []
    sampler = SamplerV2(mode=backend)

    while len(bits) < n_bits:
        remaining = n_bits - len(bits)
        shots = min(DEFAULT_SHOTS_PER_JOB, -(-remaining // n_qubits))
        if verbose:
            print(f"[ibm] enviando job: {shots} shots x {n_qubits} qubits "
                  f"({len(bits)}/{n_bits} bits)")
        job = sampler.run([isa_circuit], shots=shots)
        jobs.append(job.job_id())
        if verbose:
            print(f"[ibm] job {job.job_id()} na fila...")
        result = job.result()
        for bitstring in result[0].data.meas.get_bitstrings():
            bits.extend(int(c) for c in bitstring)

    return bits[:n_bits], {
        "provider": "ibm_quantum",
        "backend": backend.name,
        "qubits": n_qubits,
        "job_ids": jobs,
        "circuit": "H^n + measure",
        "captured_at": int(time.time()),
    }


# ---------------------------------------------------------------- ANU QRNG

def from_anu(n_bits: int, api_key: str | None = None, verbose: bool = True) -> tuple[list[int], dict]:
    """Entropia fotônica da Australian National University.

    Mede flutuação quântica do vácuo. A API atual exige chave (o endpoint
    livre antigo, qrng.anu.edu.au/API/jsonI.php, foi descontinuado) e aceita
    no máximo 1024 valores por requisição.
    """
    import urllib.error
    import urllib.request
    import json as _json

    api_key = api_key or os.environ.get("ANU_API_KEY")
    if not api_key:
        raise EntropyError("ANU_API_KEY não definido")

    n_bytes = -(-n_bits // 8)
    values: list[int] = []
    while len(values) < n_bytes:
        step = min(1024, n_bytes - len(values))
        url = f"https://api.quantumnumbers.anu.edu.au/?length={step}&type=uint8"
        req = urllib.request.Request(url, headers={"x-api-key": api_key})
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = _json.loads(resp.read())
        except urllib.error.HTTPError as e:
            raise EntropyError(f"ANU HTTP {e.code}: {e.read()[:200]!r}") from e
        if not data.get("success"):
            raise EntropyError(f"ANU respondeu sem sucesso: {data}")
        values.extend(int(v) for v in data["data"])
        if verbose:
            print(f"[anu] {len(values)}/{n_bytes} bytes")
        if len(values) < n_bytes:
            time.sleep(1)  # a API limita taxa por chave

    bits: list[int] = []
    for v in values:
        bits.extend((v >> (7 - j)) & 1 for j in range(8))
    return bits[:n_bits], {
        "provider": "anu_qrng",
        "method": "vacuum fluctuation (photonic)",
        "captured_at": int(time.time()),
    }


# ------------------------------------------------------------------ local

def from_local(n_bits: int, verbose: bool = True) -> tuple[list[int], dict]:
    """CSPRNG do sistema. NÃO é quântico — só para desenvolvimento."""
    if verbose:
        print("[local] AVISO: pool de desenvolvimento, entropia NÃO quântica")
    raw = os.urandom(-(-n_bits // 8))
    bits: list[int] = []
    for v in raw:
        bits.extend((v >> (7 - j)) & 1 for j in range(8))
    return bits[:n_bits], {
        "provider": "local_csprng",
        "quantum": False,
        "warning": "pool de desenvolvimento — entropia clássica, não use em produção",
        "captured_at": int(time.time()),
    }


def collect(n_bits: int, source: str = "auto", verbose: bool = True,
            **kwargs) -> tuple[list[int], dict]:
    """Coleta bits da fonte pedida, com cascata de fallback quando `auto`."""
    if source == "ibm":
        return from_ibm(n_bits, verbose=verbose, **kwargs)
    if source == "anu":
        return from_anu(n_bits, verbose=verbose)
    if source == "local":
        return from_local(n_bits, verbose=verbose)
    if source != "auto":
        raise ValueError(f"fonte desconhecida: {source}")

    for name, fn in (("ibm", from_ibm), ("anu", from_anu)):
        try:
            return fn(n_bits, verbose=verbose)
        except EntropyError as e:
            print(f"[auto] {name} indisponível: {e}")
        except Exception as e:  # noqa: BLE001 — fila caiu, rede caiu, etc.
            print(f"[auto] {name} falhou: {type(e).__name__}: {e}")
    print("[auto] caindo para entropia local (desenvolvimento)")
    return from_local(n_bits, verbose=verbose)
