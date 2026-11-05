"""Adlandırılmış, bağımsız rastgele sayı akışları (ortak rastgele sayılar / CRN).

Eşleştirilmiş Wilcoxon testleri için aynı tohumda worker popülasyonu ve iş yükü stratejiden
bağımsız olarak aynı kalmalıdır. Her akış SeedSequence'tan sabit bir sırayla türetilir; strateji
değişikliği yalnızca kendi kullandığı akışı etkiler.

Hata kararları (bir worker bir görevde yanlış mı dönecek?) sıralamadan bağımsız olsun diye
akıştan değil, (tohum, anahtar) özetinden üretilir: aynı worker aynı görevde her stratejide
aynı kararı verir.
"""

from __future__ import annotations

import hashlib

import numpy as np

STREAMS = ("population", "arrivals", "sessions", "workload", "speed_noise", "detection")


class Streams:
    def __init__(self, seed: int):
        self.seed = int(seed)
        children = np.random.SeedSequence(self.seed).spawn(len(STREAMS))
        self._gens = {name: np.random.default_rng(ss) for name, ss in zip(STREAMS, children)}

    def __getitem__(self, name: str) -> np.random.Generator:
        return self._gens[name]

    def uniform_for(self, *key: object) -> float:
        """Sıralamadan bağımsız, [0, 1) aralığında deterministik sayı."""
        h = hashlib.sha256("|".join([str(self.seed), *map(str, key)]).encode()).digest()
        return int.from_bytes(h[:7], "big") / 2**56
