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
5. **Kanıt:** Sunucu her ödemeyi `payments.log` dosyasına yazar (işlem imzası, ödeyen, ağ). Gezgin bağlantısının ekran görüntüsünü ya da kısa bir ekran kaydını danışman sunumuna ekleyin.

**Hata yolları (kabul ölçütü):**

| Durum | Nasıl denenir | Beklenen |
|---|---|---|
| Yetersiz bakiye | Faucet'ten USDC almadan istemciyi çalıştırın | Kaynak verilmez (402 ya da hata) |
| Yanlış ağ | `server.ts` içinde ağı mainnet yapın | İstemci politikası reddeder, ödeme yapılmaz |
| Tekrarlanan ödeme | Aynı `PAYMENT-SIGNATURE` başlığını ikinci kez gönderin | Facilitator reddeder |

## Alıcı ödemesi kararı için not

`@x402/svm` paketinde `exact` şemasının yanında bir **`upto`** şeması da var: istemci bir üst sınırı onaylar, sunucu gerçek kullanımı tahsil eder. Bu şema, Hafta 6–7 raporundaki **A seçeneğini (üst sınır + iade)** iade transferi olmadan, protokolün kendi içinde karşılayabilir. Ancak Solana'daki payment-channels programına ve facilitator tarafında ek imzacı desteğine dayanıyor. Bu notu danışman görüşmesine götürün; 8. aşamada `exact` + iade ile `upto` karşılaştırılabilir.
