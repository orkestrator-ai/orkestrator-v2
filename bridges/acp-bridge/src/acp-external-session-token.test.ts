import "./testing/unit-test-env.js";
import { describe, expect, test } from "bun:test";
import { externalSessionToken, parseExternalSessionToken } from "./acp-context.js";

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

describe("external session tokens", () => {
  test("round-trips the provider session id", () => {
    expect(parseExternalSessionToken(externalSessionToken("provider-session"))).toBe(
      "provider-session",
    );
  });

  test("refuses every other spelling of the signature's last character", () => {
    const token = externalSessionToken("provider-session");
    const last = token.at(-1)!;
    // The digest's last character carries two spare bits: three other
    // characters decode to the same bytes, and the rest to different ones.
    const others = [...BASE64URL].filter((character) => character !== last);
    expect(others).toHaveLength(63);
    for (const character of others) {
      expect(parseExternalSessionToken(`${token.slice(0, -1)}${character}`)).toBeNull();
    }
  });
});
