// Yerel facilitator'ın ağ gerektirmeyen testi: /supported Devnet 'exact' şemasını ve ücret ödeyen adresi bildirir.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { webcrypto } from "node:crypto";
import { base58 } from "@scure/base";
import { createFacilitatorApp } from "../src/facilitator.ts";
import { SOLANA_DEVNET } from "../src/config.ts";

let server: Server, base: string, address: string;

before(async () => {
  const kp = (await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as webcrypto.CryptoKeyPair;
  const pkcs8 = new Uint8Array(await webcrypto.subtle.exportKey("pkcs8", kp.privateKey));
  const pub = new Uint8Array(await webcrypto.subtle.exportKey("raw", kp.publicKey));
  const secret = new Uint8Array(64);
  secret.set(pkcs8.slice(-32), 0);
  secret.set(pub, 32);
  const made = await createFacilitatorApp({ privateKey: base58.encode(secret), rpcUrl: "http://127.0.0.1:1" });
  address = made.address;
  assert.equal(address, base58.encode(pub));
  server = createServer(made.app);
  base = await new Promise<string>((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
});
after(() => server.close());

test("/supported: Devnet 'exact' şeması ve ücret ödeyen adres", async () => {
  const body = (await (await fetch(`${base}/supported`)).json()) as { kinds: { scheme: string; network: string; extra?: { feePayer?: string } }[] };
  const kind = body.kinds.find((k) => k.network === SOLANA_DEVNET && k.scheme === "exact");
  assert.ok(kind, "Devnet exact kaydı olmalı");
  assert.equal(kind.extra?.feePayer, address);
});

test("/settle: geçersiz gövde hata olarak döner, süreç çökmez", async () => {
  const res = await fetch(`${base}/settle`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as { success: boolean }).success, false);
});
