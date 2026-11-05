"""Görevlerin bağımsız Python referansı (scripts/ref_vectors.py ile aynı tanım; matmul NumPy ile hızlı).

Koordinatörün gerçek kayıtlarında kabul edilen sonucun doğru olup olmadığını (hatalı sonuç oranı)
hesaplamak için kullanılır. Çıktı README'deki kanonik JSON biçimindedir.
"""

from __future__ import annotations

import hashlib
import json

import numpy as np

M = 0xFFFFFFFF


def sha_chain(seed: str, iterations: int) -> str:
    h = hashlib.sha256(seed.encode()).digest()
    for _ in range(iterations - 1):
        h = hashlib.sha256(h).digest()
    return h.hex()


def _mulberry32_stream(seed: int, count: int) -> np.ndarray:
    out = np.empty(count, dtype=np.uint64)
    a = seed & M
    for i in range(count):
        a = (a + 0x6D2B79F5) & M
        t = ((a ^ (a >> 15)) * (a | 1)) & M
        t ^= (t + (((t ^ (t >> 7)) * (t | 61)) & M)) & M
        out[i] = (t ^ (t >> 14)) & M
    return out


def matmul(seed: int, n: int) -> str:
    vals = _mulberry32_stream(seed, 2 * n * n)
    a = vals[: n * n].reshape(n, n)
    b = vals[n * n :].reshape(n, n)
    # uint64 taşması 2^64 modunda sarar; 2^32 bunu böldüğü için sonuç mod 2^32 doğrudur.
    c = (a @ b) & np.uint64(M)
    return hashlib.sha256(c.astype("<u4").tobytes()).hexdigest()


def expected_output(module: str, input_json: str) -> str | None:
    """Kanonik beklenen çıktı; bilinmeyen modül ya da geçersiz girdi için None."""
    try:
        inp = json.loads(input_json)
        if module == "sha_chain":
            out = {"hash": sha_chain(inp["seed"], int(inp["iterations"])), "iterations": inp["iterations"]}
        elif module == "matmul":
            out = {"hash": matmul(int(inp["seed"]), int(inp["n"])), "n": inp["n"], "seed": inp["seed"]}
        else:
            return None
    except (KeyError, TypeError, ValueError):
        return None
    return json.dumps(out, sort_keys=True, separators=(",", ":"))
