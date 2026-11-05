# x402 prototipi (Hafta 6, Ç6.6)

Alıcı tarafındaki ödeme yolunu koordinatörden bağımsız olarak uçtan uca kanıtlar: `GET /demo` → **402** → Devnet USDC ile ödeme → **200**. 8. aşamada aynı ara katman koordinatörün `POST /jobs` yolunun önüne konacak.

- **Protokol:** x402 v2. Başlıklar `PAYMENT-REQUIRED` (sunucu → istemci), `PAYMENT-SIGNATURE` (istemci → sunucu) ve `PAYMENT-RESPONSE` (sunucu → istemci).
- **Paketler:** `@x402/express`, `@x402/fetch`, `@x402/svm` (`exact` şeması), `@x402/core` 2.30.
- **Ağ:** Solana Devnet (`solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`), Devnet USDC (`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`).
- **Facilitator:** `https://x402.org/facilitator`. Ödemeyi doğrular, işlemi zincire gönderir ve işlem ücretini (SOL) kendisi öder. Bu yüzden alıcının yalnızca Devnet USDC'ye ihtiyacı var.
- **İstemci güvenlik politikası:** yalnızca Devnet, yalnızca Devnet USDC, ödeme başına en fazla 0,01 USDC (`devnetPolicy`).

## Testler (ağ gerektirmez)

```bash
npm test -w payments/x402-proto
```

Sahte bir facilitator ile şunları doğrular: ödemesiz istek 402 alır; `PAYMENT-REQUIRED` doğru ağı, varlığı, tutarı (10 000 atomik birim = 0,01 USDC) ve alıcıyı taşır; geçersiz `PAYMENT-SIGNATURE` ile kaynak verilmez; istemci politikası mainnet'i, başka token'ları ve üst sınırı aşan tutarları reddeder.

## Devnet'te çalıştırma (elle)

1. **Anahtarlar:** `npm run keys -w payments/x402-proto`. Bu komut `.env` dosyasına bir alıcı ve bir platform anahtar çifti yazar. `.env` git dışındadır; bu anahtarları başka hiçbir yerde kullanmayın.
2. **Test USDC:** <https://faucet.circle.com> adresinde ağ olarak **Solana Devnet**'i seçip `.env` içindeki `BUYER_ADDRESS` adresine USDC isteyin.
3. **Sunucu:** `npm run server -w payments/x402-proto`. Sunucu `http://127.0.0.1:4021/demo` adresinde açılır.
4. **İstemci** (ikinci terminalde): `npm run client -w payments/x402-proto`. Beklenen çıktı `Durum: 200`, kesinleşme bilgisi ve Solana gezgini bağlantısıdır.
5. **Kanıt:** Sunucu her ödemeyi `payments.log` dosyasına yazar (işlem imzası, ödeyen, ağ). Gezgin bağlantısının ekran görüntüsünü ya da kısa bir ekran kaydını Hafta 6 teslimine ekleyin.

**Hata yolları (kabul ölçütü):**

| Durum | Nasıl denenir | Beklenen |
|---|---|---|
| Yetersiz bakiye | Faucet'ten USDC almadan istemciyi çalıştırın | Kaynak verilmez (402 ya da hata) |
| Yanlış ağ | `server.ts` içinde ağı mainnet yapın | İstemci politikası reddeder, ödeme yapılmaz |
| Tekrarlanan ödeme | Aynı `PAYMENT-SIGNATURE` başlığını ikinci kez gönderin | Facilitator reddeder |

## Yerel facilitator (herkese açık facilitator `429` verirse)

Herkese açık `x402.org` facilitator'ı Devnet RPC sınırına takılınca ödeme `settlement_pending` (`Too Many Requests`) ile kesinleşmez. Aynı işi yapan yerel bir facilitator çalıştırabilirsiniz: istemcinin imzaladığı işlemi doğrular, ücretini kendi hesabından öder ve zincire gönderir.

1. **Anahtar:** `npm run keys -w payments/x402-proto -- --facilitator` (`.env`'e üçüncü bir Devnet anahtarı ekler, mevcut anahtarlara dokunmaz).
2. **SOL:** Çıkan facilitator adresine <https://faucet.solana.com> üzerinden Devnet SOL alın (işlem ücreti için).
3. **RPC (isteğe bağlı ama önerilir):** `.env` içine `SOLANA_RPC_URL=<kendi Devnet RPC adresiniz>` yazın (Helius, QuickNode vb. ücretsiz katman). Boşsa herkese açık RPC kullanılır ve aynı sınıra takılabilirsiniz.
4. **Yönlendirme:** `.env` içinde `FACILITATOR_URL=http://127.0.0.1:4022` yapın.
5. **Çalıştırma:** `npm run facilitator -w payments/x402-proto`, sonra ayrı terminallerde `npm run server …` ve `npm run client …`. Facilitator terminali her `settle` sonucunu ve hata nedenini yazar.

Testler (`npm test`) yerel facilitator'ın `/supported` ve hata yolunu ağsız doğrular. Gerçek Devnet ödemesi elle denenir.

## Alıcı ödemesi kararı

**Karar (Hafta 6, Kapsam Dokümanı v2 §5 ve §8):** alıcı, işi gönderirken `exact` şemasıyla bir üst sınır öder; iş bitince gerçekleşen maliyet hesaplanır ve fark SPL transferiyle iade edilir. Üst sınır formülü, `N` görev, görev başına en fazla `maxReplicas` kopya ve sınama oranı `q` için:

```
üst sınır = p × N × maxReplicas / (1 − q)
```

Sınama işleri gerçek kopyaların `q / (1 − q)` katı olduğu için bölen `1 − q`'dur; sabit stratejilerde sınama işi olmadığından `üst sınır = p × N × maxReplicas`.

**Alternatif:** çekirdek x402 v2 spesifikasyonu `exact` yanında `upto`, `batch-settlement` ve `auth-capture` şemalarını da adlarıyla anar ve kurallarını `specs/schemes/` altındaki ayrı belgelere bırakır. `upto`'da `amount`, doğrulama anında onaylanan üst tutardır; yani aynı sonucu iade transferi olmadan verir. Ancak SVM tarafında varsayılan yöntem emanettir (escrow) ve facilitator tarafında ek imzacı desteği gerekir. Bu yüzden `upto` 10. haftada alternatif olarak denenecek, ana akış `exact` + iade olarak kalacak.
