# Yol Haritası: Aşama Aşama Proje

Proje tek bir depo (monorepo) olarak büyür. Her aşama bir öncekinin üstüne kurulur, kendi testleriyle gelir ve bitince depo **çalışır durumda** kalır. Aşamalar haftalık planla eşleşir.

| Aşama | Hafta | İçerik | Klasörler | Durum |
|---|---|---|---|---|
| 0 | 6 | Repo iskeleti, ortak sözleşmeler (DAG ve mesaj şemaları, parametreler), örnek iş akışları | `shared/`, `docs/` | ✅ Tamamlandı |
| 1 | 7 (B kolu) | Koordinatör çekirdeği: HTTP API, WebSocket, DAG kuyruğu, `$ref` çözümü, FIFO + ilk sonucu kabul, heartbeat ve zaman aşımıyla yeniden atama, SQLite olay kaydı | `coordinator/` | ✅ Tamamlandı |
| 2 | 5 → 7 | `wasm-worker-proto`'nun depoya alınması (geçmişiyle) | `tasks/`, `worker-web/` | ⏳ Bilgisayar bağlantısı bekleniyor |
| 3 | 7 (B kolu) | Worker sayfasının koordinatöre bağlanması (`ws-client.js`, onay, CPU sınırı), Playwright uçtan uca testleri | `worker-web/`, `experiments/` | Sırada |
| 4 | 7 (A kolu) | SimPy simülatör iskeleti: worker modeli, DAG üretici, aynı strateji arayüzleri, olay kaydı, metrikler | `sim/` | Sırada |
| 5 | 6 | x402 prototipi (Solana Devnet) | `payments/x402-proto/` | Sırada |
| 6 | 8 | Gerçek stratejiler: en hızlı öncelikli, itibar ağırlıklı; sabit 2'li, sabit 3'lü, uyarlanabilir | `coordinator/`, `sim/` | — |
| 7 | 9 | İtibar (Beta, α/β, λ, w), sınama işi, geriye dönük iptal, bütçe ve emanet | `coordinator/`, `sim/` | — |
| 8 | 10 | x402'nin API'ye bağlanması, worker ödemeleri (SPL), MCP adaptörü | `coordinator/`, `payments/` | — |
| 9 | 11 | Yapay zekâ ajanı, deney koşucuları | `agent/`, `experiments/` | — |
| 10 | 12–13 | Deney matrisi, analiz, rapor | `experiments/`, `docs/` | — |

## Aşamalar arası kurallar

1. **Ortak sözleşme tek yerde.** DAG formatı, mesaj formatı ve parametreler yalnızca `shared/` içindedir. Koordinatör ve simülatör bunları kopyalamaz, okur.
2. **Strateji arayüzleri sabittir.** `Scheduler.pick` ve `Verifier.onResult` 1. aşamada tanımlandı; 6. aşama yalnızca yeni uygulamalar ekler.
3. **Olay sütunları sabittir.** `replicas` tablosunun sütunları simülatörün olay kaydıyla aynıdır; tek analiz betiği ikisini de okur.
4. Her aşama `npm test` ile doğrulanır; testler geçmeden sonraki aşamaya geçilmez.

## Karar kaydı

| Tarih | Karar | Gerekçe |
|---|---|---|
| 2026-11-05 | İtibar sayaçları `alpha`/`beta` olarak adlandırıldı | Hata modelindeki `f`, `s` ile çakışmayı önlemek için (Hafta 6–7 raporu §0.2) |
| 2026-11-05 | `max_replicas = 5` varsayılan (danışman onayı bekliyor) | Üç farklı sonuç durumunun tanımlanması |
| 2026-11-05 | Parametre dosyası YAML yerine JSON | Node ve Python ek bağımlılık olmadan okur |
| 2026-11-05 | SQLite için `better-sqlite3` yerine Node'un yerleşik `node:sqlite` modülü | Derlenmesi gereken yerel bağımlılık yok; macOS'ta kurulum sorunu çıkmaz |
| 2026-11-05 | TypeScript derleme adımı yok; Node'un tip ayıklaması ile doğrudan çalışır, `tsc --noEmit` ile tip kontrolü | Daha az araç, daha hızlı geliştirme |
