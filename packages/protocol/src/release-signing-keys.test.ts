import { describe, expect, test } from "bun:test";
import { RELEASE_SIGNING_PUBLIC_KEYS } from "./release-signing-keys.js";

describe("embedded release signing keys", () => {
  test("are the active and the standby key: two distinct Ed25519 public keys", async () => {
    expect(RELEASE_SIGNING_PUBLIC_KEYS).toHaveLength(2);
    expect(new Set(RELEASE_SIGNING_PUBLIC_KEYS).size).toBe(2);
    for (const encoded of RELEASE_SIGNING_PUBLIC_KEYS) {
      const raw = Buffer.from(encoded, "base64");
      // A typo that still decodes would change the bytes and fail this.
      expect(raw.toString("base64")).toBe(encoded);
      expect(raw.byteLength).toBe(32);
      const key = await crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
      expect(key.algorithm.name).toBe("Ed25519");
    }
  });
});
