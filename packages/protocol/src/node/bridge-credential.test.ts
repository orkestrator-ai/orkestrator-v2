import { describe, expect, mock, test } from "bun:test";
import {
  AGENT_TOOLS_TOKEN_PREFIX,
  BRIDGE_TOKEN_PREFIX,
  bridgeCredentialFromToken,
  bridgeTokenVerifier,
  loadBridgeCredential,
  mintAgentToolsToken,
  mintBridgeToken,
} from "./bridge-credential";

const TOKEN_ENV = "TEST_BRIDGE_TOKEN";
const VERIFIER_ENV = "TEST_BRIDGE_TOKEN_SHA256";

describe("bridge credential", () => {
  test("a bridge given a verifier accepts the token, and nothing it can read is the token", () => {
    const token = mintBridgeToken();
    const verifier = bridgeTokenVerifier(token);
    const harden = mock(() => true);
    const env: NodeJS.ProcessEnv = { [VERIFIER_ENV]: verifier };

    const credential = loadBridgeCredential(TOKEN_ENV, { env, harden });

    expect(credential.matches(token)).toBe(true);
    // What a holder of the agent's uid can reach: the verifier, and nothing else.
    expect(credential.matches(verifier)).toBe(false);
    expect(credential.matches(undefined)).toBe(false);
    expect(credential.matches("")).toBe(false);
    expect(credential.plainToken).toBeUndefined();
    expect(env).toEqual({});
    expect(harden).toHaveBeenCalledTimes(1);
  });

  test("a plain token still works for a bridge an older backend started", () => {
    const harden = mock(() => true);
    const env: NodeJS.ProcessEnv = { [TOKEN_ENV]: " legacy-token " };

    const credential = loadBridgeCredential(TOKEN_ENV, { env, harden });

    expect(credential.matches("legacy-token")).toBe(true);
    expect(credential.matches("other")).toBe(false);
    expect(credential.plainToken).toBe("legacy-token");
    expect(env).toEqual({});
    expect(harden).not.toHaveBeenCalled();
  });

  test("a verifier wins over a plain token", () => {
    const token = mintBridgeToken();
    const credential = loadBridgeCredential(TOKEN_ENV, {
      env: { [TOKEN_ENV]: "plain", [VERIFIER_ENV]: bridgeTokenVerifier(token) },
      harden: () => true,
    });

    expect(credential.matches(token)).toBe(true);
    expect(credential.matches("plain")).toBe(false);
  });

  test("a malformed verifier or no credential fails closed", () => {
    const malformed = loadBridgeCredential(TOKEN_ENV, {
      env: { [VERIFIER_ENV]: "not-a-hash" },
      harden: () => true,
    });
    expect(malformed.matches("not-a-hash")).toBe(false);
    expect(malformed.matches("")).toBe(false);

    const none = loadBridgeCredential(TOKEN_ENV, { env: {}, harden: () => true });
    expect(none.matches("anything")).toBe(false);
  });

  test("minted tokens carry a recognisable prefix and 32 random bytes", () => {
    expect(mintBridgeToken()).toMatch(new RegExp(`^${BRIDGE_TOKEN_PREFIX}[A-Za-z0-9_-]{43}$`));
    expect(mintAgentToolsToken()).toMatch(
      new RegExp(`^${AGENT_TOOLS_TOKEN_PREFIX}[A-Za-z0-9_-]{43}$`),
    );
    expect(mintBridgeToken()).not.toBe(mintBridgeToken());
  });

  test("the from-token credential compares a whole token, not a prefix of it", () => {
    const credential = bridgeCredentialFromToken("abcdef");
    expect(credential.matches("abcdef")).toBe(true);
    expect(credential.matches("abc")).toBe(false);
    expect(credential.matches("abcdefg")).toBe(false);
  });
});
