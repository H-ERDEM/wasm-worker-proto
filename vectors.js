// Fixed test vectors. Expected outputs were produced by scripts/ref_vectors.py
// (Python hashlib) and are compared byte-for-byte against the WASM and JS outputs.
export const VECTORS = [
  {
    module: "sha_chain",
    input: "{\"seed\":\"\",\"iterations\":1}",
    expected: "{\"hash\":\"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\",\"iterations\":1}",
  },
  {
    module: "sha_chain",
    input: "{\"seed\":\"hello\",\"iterations\":1}",
    expected: "{\"hash\":\"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824\",\"iterations\":1}",
  },
  {
    module: "sha_chain",
    input: "{\"seed\":\"hello\",\"iterations\":1000}",
    expected: "{\"hash\":\"f6eec10c841b542f37ffb4ca00f82c5b6b4b11b79636d20201078b667ac37159\",\"iterations\":1000}",
  },
  {
    module: "sha_chain",
    input: "{\"seed\":\"volunteer-computing\",\"iterations\":100000}",
    expected: "{\"hash\":\"333e4629aeb9312c9063c373b3d0b7db049fa0a2c679132a6c9c91b1f18d98b3\",\"iterations\":100000}",
  },
  {
    module: "matmul",
    input: "{\"seed\":0,\"n\":1}",
    expected: "{\"hash\":\"87e16c1e90587c59c2441e76f450335022fcbf78a3874d40552e76945f195d0f\",\"n\":1,\"seed\":0}",
  },
  {
    module: "matmul",
    input: "{\"seed\":42,\"n\":8}",
    expected: "{\"hash\":\"92c16ccf9c66fd5fc69187be6d73caf2b9da3ccdcbfc5cfbb21b25941c734c0a\",\"n\":8,\"seed\":42}",
  },
  {
    module: "matmul",
    input: "{\"seed\":42,\"n\":64}",
    expected: "{\"hash\":\"21bfb70784701c76d11da1401dec6eb95c570e074e7a831c5ac69a56514433cb\",\"n\":64,\"seed\":42}",
  },
  {
    module: "matmul",
    input: "{\"seed\":4294967295,\"n\":100}",
    expected: "{\"hash\":\"3049e408e7397b82fdd6f7917489d516cb4b65adbe608bbb4776b5e05c0378a7\",\"n\":100,\"seed\":4294967295}",
  },
  {
    module: "image_blur",
    input: "{\"seed\":0,\"w\":1,\"h\":1,\"passes\":1}",
    expected: "{\"h\":1,\"hash\":\"3f39d5c348e5b79d06e842c114e6cc571583bbf44e4b0ebfda1a01ec05745d43\",\"passes\":1,\"seed\":0,\"w\":1}",
  },
  {
    module: "image_blur",
    input: "{\"seed\":42,\"w\":8,\"h\":8,\"passes\":1}",
    expected: "{\"h\":8,\"hash\":\"5870cb5633065f4a14668b74c118c18d934ed33460b3310dbc7d10af6f3da7fe\",\"passes\":1,\"seed\":42,\"w\":8}",
  },
  {
    module: "image_blur",
    input: "{\"seed\":42,\"w\":64,\"h\":48,\"passes\":3}",
    expected: "{\"h\":48,\"hash\":\"3894adbe0c4011c6f5b7e8e3c248b1275401d8082f8cb5be5483e3bc5b488863\",\"passes\":3,\"seed\":42,\"w\":64}",
  },
  {
    module: "image_blur",
    input: "{\"seed\":4294967295,\"w\":100,\"h\":1,\"passes\":2}",
    expected: "{\"h\":1,\"hash\":\"1bee202d14ca061c4e28f9c353cbed38836c986cd98de7598aff807da5e0296b\",\"passes\":2,\"seed\":4294967295,\"w\":100}",
  },
  {
    module: "image_blur",
    input: "{\"seed\":7,\"w\":1,\"h\":50,\"passes\":16}",
    expected: "{\"h\":50,\"hash\":\"cf658d4ac50c2ce22d6e13c28115149c8229757799ca700181bf2961b7f9b718\",\"passes\":16,\"seed\":7,\"w\":1}",
  },
];
