import "./testing/unit-test-env.js";
import { describe, expect, test } from "bun:test";
import { externalSessionToken, parseExternalSessionToken } from "./acp-context.js";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

describe("provider-owned session tokens", () => {
  test("only the issued spelling of the signature resumes a session", () => {
    // The signature is a 32-byte digest, so its last base64url character carries
    // four data bits and two unused ones: four characters decode to the same
    // bytes. The signing key is random per bridge, so a fixed edit to that
    // character used to leave the bytes unchanged in one run of sixteen.
    for (const acpSessionId of ["external-session", "a", "session-2", "x".repeat(40)]) {
      const token = externalSessionToken(acpSessionId);
      expect(parseExternalSessionToken(token)).toBe(acpSessionId);
      const last = ALPHABET.indexOf(token.at(-1)!);
      const group = last - (last % 4);
      for (const alias of ALPHABET.slice(group, group + 4)) {
        if (alias === token.at(-1)) continue;
        expect(parseExternalSessionToken(`${token.slice(0, -1)}${alias}`)).toBeNull();
      }
    }
  });
});
