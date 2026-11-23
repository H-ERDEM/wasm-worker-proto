# Yol Haritası: Aşama Aşama Proje

Proje bu depoda tek bir bütün olarak büyür. Her aşama bir öncekinin üstüne kurulur, kendi testleriyle gelir ve bitince depo **çalışır durumda** kalır. Ayrıntılı plan: [`Hafta6-7_Ilerleme_Raporu_ve_Uygulama_Plani.md`](Hafta6-7_Ilerleme_Raporu_ve_Uygulama_Plani.md).

| Aşama | Hafta | İçerik | Konum | Durum |
|---|---|---|---|---|
| 0 | 5 | Rust/WASM görevleri, Web Worker, test vektörleri | kök (`src/`, `worker.js`, `index.html`…) | ✅ · 8. hafta: `image_blur` (5 vektör), 13 vektör Chrome 157, Firefox 160 ve Android Chrome 158'de eşleşti |
| 1 | 6 | Ortak sözleşmeler: DAG v0 ve mesaj v0 şemaları, parametreler, örnek iş akışları | `shared/` | ✅ |
| 2 | 6 | x402 prototipi: Solana Devnet, `exact` şeması, istemci harcama politikası | `payments/x402-proto/` | ✅ kod ve testler · ✅ Devnet'te gerçek ödeme (23 Kasım, 8. hafta; imza README'de) |
| 3 | 6 | CI (GitHub Actions) | `.github/workflows/ci.yml` | ✅ |
| 4 | 7 (B) | Koordinatör çekirdeği: HTTP API, WebSocket, DAG kuyruğu, `$ref`, fifo + accept_first, heartbeat ve zaman aşımı, SQLite, statik sayfa sunumu | `coordinator/` | ✅ |
| 5 | 7 (B) | Gönüllü sayfası: onay, CPU sınırı, şarj koşulu, yeniden bağlanma, deney modu; gerçek Chromium testleri | `volunteer.html`, `volunteer.js`, `worker-client.js`, `test/volunteer-e2e.mjs` | ✅ · telefonla uçtan uca deneme 23 Kasım'da yapıldı (Android 10, Chrome 158) |
| 6 | 7 (A) | SimPy simülatör iskeleti ve ortak analiz | `sim/` | ✅ |
| 7 | 8 | Gerçek stratejiler: en hızlı öncelikli, itibar ağırlıklı; sabit 2'li, sabit 3'lü, uyarlanabilir | `coordinator/src/strategies.ts`, `sim/vcsim/strategies/` | 🔄 simülatörde tamam: itibar, 3 zamanlayıcı, 5 doğrulayıcı, sınama işi, geriye dönük iptal, iş sonunda ödeme; TS arayüzü genişletildi (uygulamalar 9. haftada) |
| 8 | 9 | İtibar (Beta, α/β, λ, w), sınama işi kâhini (Node WASM), geriye dönük iptal, bütçe ve emanet | `coordinator/`, `sim/` | — |
| 9 | 10 | x402'nin `POST /jobs` önüne bağlanması, worker ödemeleri (SPL), MCP adaptörü | `coordinator/`, `payments/` | — |
| 10 | 11 | Yapay zekâ ajanı, Playwright deney koşucuları | `agent/`, `experiments/` | — |
| 11 | 12–13 | Deney matrisi, analiz, rapor | `experiments/`, `docs/` | — |

## Aşamalar arası kurallar

1. **Ortak sözleşme tek yerde.** DAG formatı, mesaj formatı ve parametreler yalnızca `shared/` içindedir. Koordinatör ve simülatör bunları kopyalamaz, okur.
2. **Strateji arayüzleri iki tarafta aynıdır.** `Scheduler.pick`, `Verifier.initialReplicas` / `initial_replicas`, `onAssign` / `on_assign`, `onResult` / `on_result` iki tarafta aynı anlamı taşır. Arayüz yalnızca karar kaydına işlenmiş bir genişletmeyle ve iki tarafta birlikte değişir (8. hafta: `on_assign`).
3. **Olay sütunları sabittir.** `replicas` tablosunun sütunları simülatörün olay kaydıyla aynıdır (`sim/tests` bunu denetler); `python -m vcsim.analyze` ikisini de okur.
4. Her aşama testleriyle gelir; `npm run test:quick` ağ ve WASM derlemesi gerektirmez, `npm test` her şeyi çalıştırır.

## Karar kaydı

| Tarih | Karar | Gerekçe |
|---|---|---|
| 2026-11-05 | İtibar sayaçları `alpha`/`beta` olarak adlandırıldı | Hata modelindeki `f`, `s` ile çakışmayı önlemek için (rapor §0.2) |
| 2026-11-05 | `maxReplicas = 5`; toplam deneme sınırı 15 *(2026-11-23'te 10'a çıkarıldı)* | Uyuşmazlığın sonsuza kadar sürmemesi; sınıra ulaşan görev FAILED ve ayrı metrik (Kapsam v2 §5) |
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
| 2026-11-23 | İtibar modeli saf fonksiyonlar olarak (`reputation.py`); ortak test vektörleri `shared/test/reputation-vectors.json` | Koordinatörün TypeScript karşılığı (9. hafta) aynı vektörleri geçmek zorunda; iki tarafın aynı kuralı uyguladığı test edilir |
| 2026-11-23 | Bir sonuç, kabul edilen çıktıyı en az iki gerçek kopya verdiyse "replikasyonla doğrulanmış" sayılır; o görevin dönmüş her kopyası `match` ya da `mismatch` alır | Kapsam v2 §5: tek kopyayla sınamasız kabul itibarı değiştirmez. Kural doğrulayıcıdan bağımsız olduğu için sabit 2'li, sabit 3'lü ve uyarlanabilir stratejide aynı çalışır |
| 2026-11-23 | İtibar yalnızca kabul anında dönmüş kopyalar için güncellenir (ödemeyle aynı küme); kabulden sonra gelen sonuçlar dikkate alınmaz | İtibar ile ödeme tutarlı kalır; geç sonuçlar zaten yok sayılıyor |
| 2026-11-23 | `rep_events` tablosu (`id, worker_id, replica_id, kind, alpha_after, beta_after, t`) simülatörde ve koordinatör şemasında aynı sütunlarla | Kural 3; itibarın zaman içindeki seyri analizde çizilebilir, olay kaydı yeniden oynatılarak α, β doğrulanır |
| 2026-11-23 | Arayüz genişletmesi: `Verifier.on_assign(task, replicas, worker, u) → (extra, alone_ok)`, `Verifier.uses_spot_checks`, `WorkerView.trusted`, `WorkerView.consecutive_valid` (yalnızca simülatör), `ReplicaView.alone_ok` | Uyarlanabilir doğrulamada kopya sayısı görevi alan worker'a bağlı; görev hazır olduğunda bilinemez. Ek kopya atama anında açılır, paralel çalışır. `alone_ok` atama anının anlık görüntüsüdür |
| 2026-11-23 | Uyarlanabilir ve BOINC adaptive: tek başına yeterli sayılmayan bir kopya bir görevde bir kez atandıysa o görev iki eşleşen sonuç bekler | Aksi hâlde güvenilir kopya önce dönüp kabul ettirir, güvenilmez worker hiç doğrulanmaz ve itibar kazanamaz |
| 2026-11-23 | Sabit 3'lü: canlı kopyaların hepsi dönünce çoğunluk; erken (2 eşleşmede) kabul yok | Kapsam §5 "her görev üç worker'a gider"; üst maliyet referansı olarak görev başına 3 ödenen kopya. Erken kabul üçüncü worker'ın emeğini ödenmemiş bırakırdı |
| 2026-11-23 | Sınama işi: doğrulayıcı açtıysa her atamada `spotCheckRate` olasılıkla (CRN: tohum, worker, atama sırası) gerçek kopya yerine sınama işi verilir; modül ve maliyet o gerçek görevinkiyle aynı; ücreti o görevin işine yansır. `tasks` tablosuna girmez, `replicas.is_spotcheck = 1`. WASM hatası veren ya da kaybolan sınama işi itibar olayı üretmez ve yenilenmez | Kapsam §5: aynı modül ve girdi dağılımı, worker'ın o sırada çalıştığı işin maliyetine eklenir. Görev metrikleri sınama işlerinden etkilenmez |
| 2026-11-23 | Geriye dönük iptal: `spot_fail` olan worker'ın bitmemiş işlerdeki tek kopyalı kabulleri geçersiz; görev ACCEPTED → READY (üstleri kabul edilmişse) ya da WAITING; çıktısını kullanan alt görevler de sıfırlanır, çalışan kopyaları iptal edilir. Bitmiş işlerdeki yanlış sonuçlar `late_detected_wrong` olarak sayılır | Kapsam §4–5. Görev durum makinesine yeni geçiş: ACCEPTED → READY / WAITING |
| 2026-11-23 | Ödeme iş bitince (COMPLETED ya da FAILED) toplu: kabul edilmiş görevlerin kabul anında eşleşen kopyaları ve geçilen sınama işleri `paid = 1`. Simülatörde uygulandı; koordinatörde 9. hafta | Kapsam §8. İptal edilebilecek sonuç önceden ödenmiş sayılamaz. FAILED işte de kabul edilmiş görevlerin emeği ödenir |
| 2026-11-23 | Zamanlayıcılar: ölçülmemiş worker'ın hızı boştakilerin en yüksek ölçülmüş hızı sayılır (yoksa 1); eşitlikte önce ölçülmemiş, sonra sıra. İtibar ağırlıklı puan `R × hız` | Yeni worker'lar denenir ve hızları ölçülür; aksi hâlde hiç seçilmeyebilirler |
| 2026-11-23 | BOINC adaptive: N, `match`/`spot_pass` ile artar, `mismatch`/`spot_fail` ile sıfırlanır; 1/N kararı CRN (tohum, worker, görev) ile | Kapsam §5; ortak rastgele sayılarla eşleştirilmiş karşılaştırma |
| 2026-11-23 | `maxReplicas = 10`; toplam deneme sınırı 30. "Bir görev FAILED → iş FAILED" kuralı korunur | 5 ile 50 görevli bir işin başarısız olma olasılığı f = %20'de %29, f = %30'da %79 (simülasyon: %30 ve %68); RQ1 maliyet ve makespan karşılaştırması stratejileri değil bu tavanı ölçerdi. 10 ile f = %30'da ≈ %0,7, f = %40'ta ≈ %8. Bedeli: alıcının peşin ödediği üst sınır iki katı (fark iade edilir) |
| 2026-11-23 | WASM hatası (`fatal`) itibarı etkilemez; `replicas_error` olarak ayrıca raporlanır | Görevler belirlenimci: girdiden kaynaklanan panic her worker'da olur; tarayıcı kaynaklı hata (ör. telefonda bellek) dürüst worker'ı w = 5 ile cezalandırırdı. Hata döndüren worker ödeme ve itibar kazanmaz, sınamayı ayırt edemez. Gelecek çalışma: başkaları başarıyla çalıştırmışken hata verene hafif ceza |
| 2026-11-23 | `image_blur`: mulberry32 ile u8 görüntü, 3×3 kutu bulanıklaştırma, kenarda kıstırma, toplam/9 tamsayı bölme, `passes` kez; maliyet `w·h·passes`. Simülatör iş yükü karışımı değişmedi (yalnızca `base_rate` yer tutucusu eklendi) | Kayan nokta yok (Kapsam §4). Hafta 8 grafikleri aynı iş yüküyle yeniden üretilebilir kalır. Vektörler Rust (yerel), JS, saf Python ve NumPy referansında aynı; Rust testi `vectors.js`'teki tüm vektörleri yerel derlemeyle denetler (wasm32 hedefi olmayan ortamlarda da) |
| 2026-11-23 | `moduleHash` = tek WASM paketinin (`pkg/vc_tasks_bg.wasm`) özeti. Koordinatör özeti başlangıçta hesaplar; her görev gönderimde bu özete bağlanır: DAG'de verilmişse eşleşmeli (yoksa 400), verilmemişse koordinatör doldurur. `assign` mesajı özeti taşır; worker WASM'ı çalıştırmadan önce denetler (saf JS SHA-256: düz HTTP'deki LAN sayfasında `crypto.subtle` yok). `welcome` ve `GET /modules` modül listesini verir. Paket derlenmemişse özet `null` | Modüller ayrı .wasm dosyaları değil, tek paketteki fonksiyonlar. "Zorunlu" her görevin bir özete bağlı olması olarak uygulandı; istemcinin (11. hafta ajanı) özet hesaplaması gerekmez, isterse `GET /modules`'tan alır |
