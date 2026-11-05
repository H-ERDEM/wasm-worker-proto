"""vcsim: tarayıcı tabanlı gönüllü hesaplama platformunun SimPy simülatörü.

Koordinatörle (coordinator/) aynı ortak sözleşmeleri kullanır:
  - shared/schemas/dag.v0.schema.json   iş tanımı
  - shared/config/default.json          parametreler
  - Scheduler / Verifier arayüzleri      coordinator/src/strategies.ts ile aynı anlam
  - replicas tablosu sütunları           coordinator/src/db/db.ts ile aynı
"""

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SHARED_DIR = REPO_ROOT / "shared"
