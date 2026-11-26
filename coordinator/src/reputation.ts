/**
 * Beta itibar modeli (Kapsam Dokümanı v3 §5; Jøsang ve Ismail [16], Jøsang vd. [21]).
 * sim/vcsim/reputation.py ile birebir aynı kurallar; ikisi de shared/test/reputation-vectors.json'ı geçer.
 *
 *   R = (alpha + 1) / (alpha + beta + 2)         başlangıçta R = 0,5
 *   Doğrulanmış her olayda önce alpha ← λ·alpha, beta ← λ·beta; sonra
 *   doğru (match, spot_pass) → alpha += 1;  hatalı (mismatch, spot_fail) → beta += w
 *   Tek kopya koşulu: R ≥ τ ve alpha ≥ alpha_min.
 * Tek kopyayla, sınamasız kabul edilen sonuç itibarı değiştirmez.
 */

export type RepEventKind = "match" | "mismatch" | "spot_pass" | "spot_fail";

export interface RepParams {
  tau: number;
  alphaMin: number;
  lambda: number;
  w: number;
}

const CORRECT: ReadonlySet<string> = new Set(["match", "spot_pass"]);
const KINDS: ReadonlySet<string> = new Set(["match", "mismatch", "spot_pass", "spot_fail"]);

export function validateParams(p: RepParams): RepParams {
  if (!(p.lambda > 0 && p.lambda <= 1)) throw new Error(`lambda (0, 1] aralığında olmalı: ${p.lambda}`);
  if (!(p.w > 0)) throw new Error(`w pozitif olmalı: ${p.w}`);
  if (!(p.tau > 0 && p.tau < 1)) throw new Error(`tau (0, 1) aralığında olmalı: ${p.tau}`);
  if (!(p.alphaMin >= 0)) throw new Error(`alphaMin negatif olamaz: ${p.alphaMin}`);
  return p;
}

export function score(alpha: number, beta: number): number {
  return (alpha + 1) / (alpha + beta + 2);
}

export function update(alpha: number, beta: number, kind: string, p: RepParams): [number, number] {
  if (!KINDS.has(kind)) throw new Error(`bilinmeyen itibar olayı: ${kind}`);
  alpha *= p.lambda;
  beta *= p.lambda;
  if (CORRECT.has(kind)) alpha += 1;
  else beta += p.w;
  return [alpha, beta];
}

export function isTrusted(alpha: number, beta: number, p: RepParams): boolean {
  return score(alpha, beta) >= p.tau && alpha >= p.alphaMin;
}

/**
 * Replikasyonla kabul edilen bir görevin kopyalarından doğan olaylar (girdiyle aynı sırada).
 * Kabul edilen çıktıyı en az iki gerçek kopya verdiyse her dönmüş kopya match ya da mismatch alır;
 * tek kopyayla kabul edilen sonuç olay üretmez.
 */
export function replicationEvents(
  acceptedOutput: string,
  returned: { workerId: string; output: string | null }[],
): { workerId: string; kind: RepEventKind }[] {
  if (returned.filter((r) => r.output === acceptedOutput).length < 2) return [];
  return returned.map((r) => ({ workerId: r.workerId, kind: r.output === acceptedOutput ? "match" : "mismatch" }));
}
