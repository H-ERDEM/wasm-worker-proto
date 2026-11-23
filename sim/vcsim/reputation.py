"""Beta itibar modeli (Kapsam Dokümanı v2 §5; Jøsang ve Ismail [16], Jøsang vd. [21]).

Her worker için iki sayaç tutulur:
    alpha  doğrulanmış doğru sonuçlar
    beta   doğrulanmış hatalı sonuçlar (ağırlıklı)

    R = (alpha + 1) / (alpha + beta + 2)          başlangıçta R = 0,5

Doğrulanmış her olayda önce geçmiş indirgenir, sonra olay eklenir:
    alpha ← λ·alpha,  beta ← λ·beta
    doğru  → alpha += 1
    hatalı → beta  += w

Doğrulanmış sayılan olaylar:
    match / mismatch      replikasyonla kabul edilen sonuçla eşleşen / eşleşmeyen kopya
    spot_pass / spot_fail geçilen / başarısız olunan sınama işi
Tek kopyayla, sınamasız kabul edilen sonuç itibarı değiştirmez.

Tek kopya koşulu (uyarlanabilir doğrulama): R ≥ τ ve alpha ≥ alpha_min.

Bu modül saf fonksiyonlardan oluşur; durum (alpha, beta) worker nesnesinde tutulur.
Koordinatördeki TypeScript karşılığı aynı kuralları uygular ve
shared/test/reputation-vectors.json içindeki ortak test vektörlerini geçmek zorundadır.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Literal, Optional

EventKind = Literal["match", "mismatch", "spot_pass", "spot_fail"]
CORRECT_KINDS: frozenset[str] = frozenset({"match", "spot_pass"})
EVENT_KINDS: frozenset[str] = frozenset({"match", "mismatch", "spot_pass", "spot_fail"})


@dataclass(frozen=True)
class RepParams:
    tau: float
    alpha_min: float
    lam: float
    w: float

    @classmethod
    def from_shared(cls, shared: dict) -> "RepParams":
        r = shared["reputation"]
        return cls(tau=float(r["tau"]), alpha_min=float(r["alphaMin"]), lam=float(r["lambda"]), w=float(r["w"]))

    def __post_init__(self) -> None:
        if not 0.0 < self.lam <= 1.0:
            raise ValueError(f"lambda (0, 1] aralığında olmalı: {self.lam}")
        if self.w <= 0.0:
            raise ValueError(f"w pozitif olmalı: {self.w}")
        if not 0.0 < self.tau < 1.0:
            raise ValueError(f"tau (0, 1) aralığında olmalı: {self.tau}")
        if self.alpha_min < 0.0:
            raise ValueError(f"alpha_min negatif olamaz: {self.alpha_min}")


def score(alpha: float, beta: float) -> float:
    """İtibar R = (α + 1) / (α + β + 2)."""
    return (alpha + 1.0) / (alpha + beta + 2.0)


def update(alpha: float, beta: float, kind: str, p: RepParams) -> tuple[float, float]:
    """Doğrulanmış bir olaydan sonra yeni (α, β). Önce λ indirgemesi, sonra olay."""
    if kind not in EVENT_KINDS:
        raise ValueError(f"bilinmeyen itibar olayı: {kind!r}")
    alpha *= p.lam
    beta *= p.lam
    if kind in CORRECT_KINDS:
        alpha += 1.0
    else:
        beta += p.w
    return alpha, beta


def is_trusted(alpha: float, beta: float, p: RepParams) -> bool:
    """Uyarlanabilir doğrulamada tek kopya koşulu: R ≥ τ ve α ≥ α_min."""
    return score(alpha, beta) >= p.tau and alpha >= p.alpha_min


def replication_events(accepted_output: str,
                       returned: Iterable[tuple[str, Optional[str]]]) -> list[tuple[str, EventKind]]:
    """Replikasyonla kabul edilen bir görevin kopyalarından doğan itibar olayları.

    `returned`: kabul anında RETURNED_OK durumundaki gerçek (sınama olmayan) kopyalar için
    (worker_id, output) çiftleri. Kabul edilen çıktıyı en az iki kopya vermişse sonuç
    replikasyonla doğrulanmış sayılır: eşleşen her kopya `match`, eşleşmeyen her kopya
    `mismatch` olayı üretir. Tek bir kopyayla kabul edilen sonuç doğrulanmış sayılmaz ve
    hiç olay üretmez.

    Not: iki colluder aynı yanlış sonucu verirse bu sonuç kabul edilir ve ikisi de `match`
    alır; bu, Kapsam v2 §5'teki colluding modelinin istenen davranışıdır.
    """
    pairs = list(returned)
    if sum(1 for _, out in pairs if out == accepted_output) < 2:
        return []
    return [(wid, "match" if out == accepted_output else "mismatch") for wid, out in pairs]
