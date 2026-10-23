"""Independent reference implementation (Python hashlib) used to cross-check the
Rust and JavaScript implementations and to produce the expected test vectors."""
import hashlib, json, struct

M = 0xFFFFFFFF

def sha_chain(seed: str, iterations: int) -> str:
    h = hashlib.sha256(seed.encode()).digest()
    for _ in range(iterations - 1):
        h = hashlib.sha256(h).digest()
    return h.hex()

def mulberry32(state):
    state[0] = (state[0] + 0x6D2B79F5) & M
    t = state[0]
    t = ((t ^ (t >> 15)) * (t | 1)) & M
    t ^= (t + (((t ^ (t >> 7)) * (t | 61)) & M)) & M
    return (t ^ (t >> 14)) & M

def matmul(seed: int, n: int) -> str:
    st = [seed & M]
    a = [mulberry32(st) for _ in range(n * n)]
    b = [mulberry32(st) for _ in range(n * n)]
    c = [0] * (n * n)
    for i in range(n):
        for k in range(n):
            aik = a[i * n + k]
            for j in range(n):
                c[i * n + j] = (c[i * n + j] + aik * b[k * n + j]) & M
    return hashlib.sha256(b"".join(struct.pack("<I", v) for v in c)).hexdigest()

VECTORS = [
    ("sha_chain", {"seed": "", "iterations": 1}),
    ("sha_chain", {"seed": "hello", "iterations": 1}),
    ("sha_chain", {"seed": "hello", "iterations": 1000}),
    ("sha_chain", {"seed": "volunteer-computing", "iterations": 100000}),
    ("matmul", {"seed": 0, "n": 1}),
    ("matmul", {"seed": 42, "n": 8}),
    ("matmul", {"seed": 42, "n": 64}),
    ("matmul", {"seed": 4294967295, "n": 100}),
]

if __name__ == "__main__":
    out = []
    for module, inp in VECTORS:
        if module == "sha_chain":
            o = {"hash": sha_chain(inp["seed"], inp["iterations"]), "iterations": inp["iterations"]}
        else:
            o = {"hash": matmul(inp["seed"], inp["n"]), "n": inp["n"], "seed": inp["seed"]}
        out.append({"module": module, "input": json.dumps(inp, separators=(",", ":")),
                    "expected": json.dumps(o, sort_keys=True, separators=(",", ":"))})
    print(json.dumps(out, indent=2))
