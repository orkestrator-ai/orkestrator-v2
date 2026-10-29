import { describe, expect, test } from "bun:test";
import { sha256Hex } from "./sha256.js";

// Reference values from `shasum -a 256` and FIPS 180-4's examples.
const VECTORS: Array<[string, string]> = [
  ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
  ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
  [
    "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  ],
  // Multi-byte UTF-8, including an astral-plane character.
  ["héllo wörld ✓ 🌍", "f8bcd0939d2d2bc8cfd82d1df72c87b7cf74ccafa3e52302dfb20f8cf3452a04"],
  // Padding edges: 55 bytes fit one block, 56 need two, 64 is a whole block.
  ["x".repeat(55), "d5e285683cd4efc02d021a5c62014694958901005d6f71e89e0989fac77e4072"],
  ["x".repeat(56), "04c26261370ee7541549d16dee320c723e3fd14671e66a099afe0a377c16888e"],
  ["x".repeat(64), "7ce100971f64e7001e8fe5a51973ecdfe1ced42befe7ee8d5fd6219506b5393c"],
];

describe("sha256Hex", () => {
  test.each(VECTORS)("hashes %#", (input, expected) => {
    expect(sha256Hex(input)).toBe(expected);
  });

  test("hashes a million bytes", () => {
    expect(sha256Hex("a".repeat(1_000_000))).toBe(
      "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
    );
  });
});
