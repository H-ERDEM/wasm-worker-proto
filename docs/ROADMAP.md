# Yol Haritası: Aşama Aşama Proje

Proje bu depoda tek bir bütün olarak büyür. Her aşama bir öncekinin üstüne kurulur, kendi testleriyle gelir ve bitince depo **çalışır durumda** kalır. Ayrıntılı plan: [`Hafta6-7_Ilerleme_Raporu_ve_Uygulama_Plani.md`](Hafta6-7_Ilerleme_Raporu_ve_Uygulama_Plani.md).

| Aşama | Hafta | İçerik | Konum | Durum |
|---|---|---|---|---|
| 0 | 5 | Rust/WASM görevleri, Web Worker, test vektörleri | kök (`src/`, `worker.js`, `index.html`…) | ✅ |
| 1 | 6 | Ortak sözleşmeler: DAG v0 ve mesaj v0 şemaları, parametreler, örnek iş akışları | `shared/` | ✅ |
| 2 | 6 | x402 prototipi: Solana Devnet, `exact` şeması, istemci harcama politikası | `payments/x402-proto/` | ✅ kod ve testler · ⏳ Devnet'te elle deneme |
| 3 | 6 | CI (GitHub Actions) | `.github/workflows/ci.yml` | ✅ |
| 4 | 7 (B) | Koordinatör çekirdeği: HTTP API, WebSocket, DAG kuyruğu, `$ref`, fifo + accept_first, heartbeat ve zaman aşımı, SQLite, statik sayfa sunumu | `coordinator/` | ✅ |
| 5 | 7 (B) | Gönüllü sayfası: onay, CPU sınırı, şarj koşulu, yeniden bağlanma, deney modu; gerçek Chromium testleri | `volunteer.html`, `volunteer.js`, `worker-client.js`, `test/volunteer-e2e.mjs` | ✅ |
| 6 | 7 (A) | SimPy simülatör iskeleti ve ortak analiz | `sim/` | ✅ |
| 7 | 8 | Gerçek stratejiler: en hızlı öncelikli, itibar ağırlıklı; sabit 2'li, sabit 3'lü, uyarlanabilir | `coordinator/src/strategies.ts`, `sim/vcsim/strategies/` | Sırada |
| 8 | 9 | İtibar (Beta, α/β, λ, w), sınama işi kâhini (Node WASM), geriye dönük iptal, bütçe ve emanet | `coordinator/`, `sim/` | — |
| 9 | 10 | x402'nin `POST /jobs` önüne bağlanması, worker ödemeleri (SPL), MCP adaptörü | `coordinator/`, `payments/` | — |
| 10 | 11 | Yapay zekâ ajanı, Playwright deney koşucuları | `agent/`, `experiments/` | — |
| 11 | 12–13 | Deney matrisi, analiz, rapor | `experiments/`, `docs/` | — |

## Aşamalar arası kurallar

1. **Ortak sözleşme tek yerde.** DAG formatı, mesaj formatı ve parametreler yalnızca `shared/` içindedir. Koordinatör ve simülatör bunları kopyalamaz, okur.
2. **Strateji arayüzleri sabittir.** `Scheduler.pick` ve `Verifier.onResult` / `on_result` iki tarafta aynı anlamı taşır; 8. hafta yalnızca yeni uygulamalar ekler.
3. **Olay sütunları sabittir.** `replicas` tablosunun sütunları simülatörün olay kaydıyla aynıdır (`sim/tests` bunu denetler); `python -m vcsim.analyze` ikisini de okur.
4. Her aşama testleriyle gelir; `npm run test:quick` ağ ve WASM derlemesi gerektirmez, `npm test` her şeyi çalıştırır.

## Karar kaydı

| Tarih | Karar | Gerekçe |
|---|---|---|
| 2026-11-05 | İtibar sayaçları `alpha`/`beta` olarak adlandırıldı | Hata modelindeki `f`, `s` ile çakışmayı önlemek için (rapor §0.2) |
| 2026-11-05 | `maxReplicas = 5`; toplam deneme sınırı 15 | Uyuşmazlığın sonsuza kadar sürmemesi; sınıra ulaşan görev FAILED ve ayrı metrik (Kapsam v2 §5) |
| 2026-11-05 | Parametre dosyası YAML yerine JSON | Node ve Python ek bağımlılık olmadan okur |
| 2026-11-05 | SQLite için `better-sqlite3` yerine Node'un yerleşik `node:sqlite` modülü | Derlenmesi gereken yerel bağımlılık yok |
| 2026-11-05 | TypeScript derleme adımı yok; Node'un tip ayıklaması, `tsc --noEmit` ile kontrol | Daha az araç |
| 2026-11-05 | Mevcut dosyalar kökte bırakıldı (planlanan `tasks/` ve `worker-web/` taşıması yapılmadı) | README yolları, `pkg/` çıktısı ve 5. hafta testleri bozulmasın; gerekirse `git mv` ile sonra yapılır |
| 2026-11-05 | Protokole `status {available}` mesajı eklendi | CPU sınırı ve şarj koşulu: worker müsait değilken görev atanmasın |
| 2026-11-05 | Koordinatör gönüllü sayfasını da sunar (`/` → `volunteer.html`) | Telefon tek adres açar; ayrı statik sunucu gerekmez |
| 2026-11-05 | Alıcı ödemesi: x402 `exact` şemasıyla üst sınır + iade; `upto` 10. haftada alternatif | `upto` çekirdek spesifikasyonda ayrı şema belgesi olarak var ama Solana'da emanet (escrow) hesabı gerektiriyor (bkz. `payments/x402-proto/README.md`) |
| 2026-11-05 | Ajan ve MCP sunucusu Could → Should | Proje başlığının parçası; 10–11. haftalardaki merkezi yeriyle uyumlu (Kapsam v2 §7) |
| 2026-11-05 | Lisans MIT; kod, simülatör ve deney verisi GitHub'da | Açık, yeniden üretilebilir çalışma (Kapsam v2 §8) |
| 2026-11-05 | Ek karşılaştırma tabanları: BOINC adaptive ve `accept_first`, yalnızca simülatörde | BOINC kuralı kaynak koddan teyit edildi (N < 10 her zaman replike, N ≥ 10 ise 1/N olasılıkla) |
| 2026-11-05 | Tüm kararlar proje ekibi tarafından alınır | Danışman kararları ekibe bıraktı; açık nokta listesi kaldırıldı |
| 2026-11-05 | Simülatörde hata kararları akıştan değil (tohum, worker, görev) özetinden | Sıralamadan bağımsız ortak rastgele sayılar (CRN): aynı worker aynı görevde her stratejide aynı kararı verir |
