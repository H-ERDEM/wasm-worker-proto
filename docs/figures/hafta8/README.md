# Hafta 8: İlk simülasyon sonuçları

**Konfigürasyon.** FIFO zamanlama × {sabit 2'li, sabit 3'lü + çoğunluk, uyarlanabilir} × 7 hata düzeyi
(hatasız; rastgele ve colluding modelde f = %10, %20, %30; s = 1) × 30 tohum = 630 koşu.
Varsayılan iş yükü: 20 DAG × 50 görev, 50 worker. Parametreler `shared/config/default.json`
(τ = 0,95, α_min = 10, λ = 0,99, w = 5, q = 0,10, maxReplicas = 10, birim ücret 0,001 test USDC).
Tüm stratejiler aynı tohumları kullanır (ortak rastgele sayılar).

**Yeniden üretmek için** (2 çekirdekte ≈ 2 dakika):

```bash
cd sim
python -m vcsim.sweep --name hafta8-ilk --schedulers fifo --verifiers fixed2,fixed3,adaptive \
  --faults none,random:0.1,random:0.2,random:0.3,collude:0.1,collude:0.2,collude:0.3 --seeds 1-30
python -m vcsim.figures ../experiments/data/sim/hafta8-ilk --out ../docs/figures/hafta8
```

**Dosyalar.** `maliyet.png`, `hatali_sonuc.png`, `makespan.png`; sayısal karşılıkları `ozet_tablo.md`
ve `ozet.csv`. Ortalamalar için tohumlar üzerinden %95 bootstrap güven aralığı; hatalı sonuç oranı için
tüm tohumların görevleri birleştirilerek Wilson aralığı.

## Gözlemler

Bunlar ilk alt kümenin sonuçları; tam matris ve eşleştirilmiş Wilcoxon testleri 12–13. haftada.

1. **Maliyet alıcının ödediği tutardır, harcanan hesaplama değil.** Yalnızca kabul edilen sonuçla
   eşleşen kopyalar ödendiği için sabit 3'lü stratejinin maliyeti f arttıkça düşer (hatalı kopyalar
   ödenmez); sabit 2'li hep görev başına 2 kopyadır. Worker'ların boşa giden emeği
   `replicas_per_task` ile ayrıca izlenir.
2. **RQ1.** Hatasız durumda uyarlanabilir strateji sabit 2'liye göre maliyeti ≈ %15 düşürüyor
   (0,0853'e karşı 0,1000 test USDC; sınama işleri dahil), hatalı sonuç oranını sıfırda tutarak.
   Hipotezdeki %30'un altında. Olası neden: tek kopya moduna geçmek için ≈ 20 doğrulanmış sonuç
   gerekiyor ve 50 worker'a 1000 görevde worker başına ≈ 20–40 görev düşüyor. Parametre taraması
   (τ, iş yükü uzunluğu) Kapsam'daki pilot koşularla yapılacak.
3. **Rastgele modelde (s = 1) üç strateji de hiç yanlış sonuç kabul etmiyor.** Beklenen: iki yanlış
   sonuç asla eşleşmez, hatalı worker da sınama işlerinde yakalandığı için hiçbir zaman güvenilir olmaz.
4. **RQ2. Colluding modelde üç strateji neredeyse aynı oranda yanlış sonuç kabul ediyor** (f = %30'da
   %22,5–23,6). Bu kuramla uyumlu: sabit 2'li ve sabit 3'lü için yanlış kabul olasılığı aynıdır,
   "ilk üç kopyadan en az ikisi colluder", yani 3f²(1 − f) + f³ (f = %10, %20, %30 için %2,8, %10,4,
   %21,6). Uyarlanabilir strateji de pek farklı değil: colluder'lar sınama işlerinde yakalandığı için
   tek kopya moduna geçemiyor; hatalar iki colluder'ın aynı görevin iki kopyasına denk geldiği 2 kopyalı
   görevlerden geliyor ve sınama işi ile geriye dönük iptal yalnızca tek kopyalı sonuçları kapsıyor.
   Bu, RQ2 ablasyonunda (q taraması) ve raporun sınırlılıklar bölümünde tartışılmalı.
5. **Makespan.** Uyarlanabilir strateji en kısa (hatasız 16,6 s; sabit 2'li 19,5 s, sabit 3'lü
   23,6 s). Sabit 3'lünün colluding modeldeki makespan'i f'den bağımsız: yalnızca iki farklı çıktı
   (doğru ve ortak yanlış) olduğundan üç kopyada hep çoğunluk oluşur ve ek kopya açılmaz.
6. **maxReplicas = 10** ile en kötü durumda (rastgele, f = %30) 600 işten 5–7'si FAILED.
