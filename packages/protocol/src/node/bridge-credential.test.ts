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

test("real Linux hardening sets PR_GET_DUMPABLE to zero in an isolated child", () => {
  if (process.platform !== "linux") return;
  const child = Bun.spawnSync([
    process.execPath,
    "--eval",
    `
    import { markProcessNonDumpable } from ${JSON.stringify(import.meta.dir + "/bridge-credential.ts")};
    import { dlopen, FFIType } from 'bun:ffi';
    if (!markProcessNonDumpable()) process.exit(1);
    const lib = dlopen('libc.so.6', { prctl: { args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i32 } });
    process.exit(lib.symbols.prctl(3, 0n, 0n, 0n, 0n) === 0 ? 0 : 2);
  `,
  ]);
  expect(child.exitCode).toBe(0);
});

test.each(["throw", "refuse"])("hardening logs a bounded failure when FFI %s", async (failure) => {
  if (process.platform !== "linux") return;
  const { configureLogger, resetLogger } = await import("../logger");
  const { markProcessNonDumpable } = await import("./bridge-credential");
  const events: unknown[] = [];
  configureLogger({ sink: (output) => events.push(output.record) });
  try {
    expect(
      markProcessNonDumpable(() => {
        if (failure === "throw") throw new Error("unavailable");
        return { FFIType: {}, dlopen: () => ({ symbols: { prctl: () => -1 }, close() {} }) };
      }),
    ).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "credential.not-hardened",
        fields: { reason: failure === "throw" ? "ffi-unavailable" : "prctl-refused" },
      }),
    );
  } finally {
    resetLogger();
  }
});
