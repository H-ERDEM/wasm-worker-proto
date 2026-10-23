// Pure JavaScript reference implementations of the same tasks, used for the
// WASM-vs-JS comparison and as a cross-check. Output strings are byte-identical
// to the Rust versions (keys sorted alphabetically, no whitespace).

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const H0 = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];
const W = new Uint32Array(64);

function rotr(x, n) {
  return (x >>> n) | (x << (32 - n));
}

function compress(h, block, off) {
  for (let i = 0; i < 16; i++) {
    const j = off + i * 4;
    W[i] = (block[j] << 24) | (block[j + 1] << 16) | (block[j + 2] << 8) | block[j + 3];
  }
  for (let i = 16; i < 64; i++) {
    const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
    const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
    W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
  }
  let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
  for (let i = 0; i < 64; i++) {
    const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
    const ch = (e & f) ^ (~e & g);
    const t1 = (hh + S1 + ch + K[i] + W[i]) | 0;
    const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const t2 = (S0 + maj) | 0;
    hh = g; g = f; f = e; e = (d + t1) | 0;
    d = c; c = b; b = a; a = (t1 + t2) | 0;
  }
  h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
  h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
}

/** SHA-256 of a byte array; returns a 32-byte Uint8Array. */
export function sha256(bytes) {
  const len = bytes.length;
  const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[len] = 0x80;
  const bitLen = len * 8;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000));
  dv.setUint32(padded.length - 4, bitLen >>> 0);
  const h = new Int32Array(H0);
  for (let off = 0; off < padded.length; off += 64) compress(h, padded, off);
  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) odv.setUint32(i * 4, h[i] >>> 0);
  return out;
}

export function toHex(bytes) {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function parseInput(inputJson, allowed) {
  let obj;
  try {
    obj = JSON.parse(inputJson);
  } catch (e) {
    throw new Error(`invalid input: ${e.message}`);
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    throw new Error("invalid input: expected a JSON object");
  }
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) throw new Error(`invalid input: unknown field ${k}`);
  }
  return obj;
}

function shaChain(inputJson) {
  const { seed, iterations } = parseInput(inputJson, ["seed", "iterations"]);
  if (typeof seed !== "string") throw new Error("invalid input: seed must be a string");
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 100_000_000) {
    throw new Error("iterations must be in 1..=100000000");
  }
  let h = sha256(new TextEncoder().encode(seed));
  for (let i = 1; i < iterations; i++) h = sha256(h);
  return `{"hash":"${toHex(h)}","iterations":${iterations}}`;
}

function mulberry32(state) {
  state.v = (state.v + 0x6d2b79f5) >>> 0;
  let t = state.v;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return (t ^ (t >>> 14)) >>> 0;
}

function matmul(inputJson) {
  const { seed, n } = parseInput(inputJson, ["seed", "n"]);
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new Error("invalid input: seed must be a u32");
  }
  if (!Number.isInteger(n) || n < 1 || n > 512) throw new Error("n must be in 1..=512");
  const state = { v: seed };
  const a = new Uint32Array(n * n);
  const b = new Uint32Array(n * n);
  for (let i = 0; i < n * n; i++) a[i] = mulberry32(state);
  for (let i = 0; i < n * n; i++) b[i] = mulberry32(state);
  const c = new Uint32Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < n; k++) {
      const aik = a[i * n + k];
      for (let j = 0; j < n; j++) {
        c[i * n + j] = (c[i * n + j] + Math.imul(aik, b[k * n + j])) >>> 0;
      }
    }
  }
  // Uint32Array is little-endian on every browser-supported platform; make it explicit.
  const bytes = new Uint8Array(n * n * 4);
  const dv = new DataView(bytes.buffer);
  for (let i = 0; i < n * n; i++) dv.setUint32(i * 4, c[i], true);
  return `{"hash":"${toHex(sha256(bytes))}","n":${n},"seed":${seed}}`;
}

const MODULES = { sha_chain: shaChain, matmul };

export function runJs(moduleName, inputJson) {
  const fn = MODULES[moduleName];
  if (!fn) throw new Error(`unknown module: ${moduleName}`);
  return fn(inputJson);
}
