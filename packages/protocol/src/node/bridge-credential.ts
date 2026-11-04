/**
 * The credential that authorises calls to a bridge (security report H4).
 *
 * A bridge shares its uid with the agent it runs, so anything the bridge keeps
 * in a file, in its startup environment or on an open descriptor the agent can
 * read too. So the bridge keeps no secret at all: the backend gives it the
 * SHA-256 of the token ({@link bridgeTokenVerifierEnv}) and holds the token
 * itself. An agent that reads the verifier cannot answer an approval with it,
 * because a 256-bit preimage cannot be recovered.
 *
 * The token still crosses the bridge's memory on each request, so a bridge that
 * takes a verifier also marks itself non-dumpable: the kernel then gives
 * `/proc/<pid>/{environ,mem,fd}` to root and refuses a same-uid ptrace. What
 * that leaves is in
 * docs/todo/containers-and-environments/4980-agent-uid-process-control.md.
 *
 * A plain token env var stays accepted for a bridge started by a backend that
 * predates the verifier, and for test harnesses.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";
import { createLogger } from "../logger.js";

export const BRIDGE_TOKEN_PREFIX = "okb_";
export const AGENT_TOOLS_TOKEN_PREFIX = "oka_";

const PR_SET_DUMPABLE = 4;
const VERIFIER_PATTERN = /^[0-9a-f]{64}$/;

const log = createLogger("bridge.lifecycle");

/** A new bridge token. Prefixed so log redaction can recognise one by its shape. */
export function mintBridgeToken(): string {
  return `${BRIDGE_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/** A new agent-tools token, which the agent itself holds. Prefixed for the same reason. */
export function mintAgentToolsToken(): string {
  return `${AGENT_TOOLS_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/** What a bridge is given in place of `token`. Reveals nothing about it. */
export function bridgeTokenVerifier(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** The variable carrying the verifier for the bridge whose token env is `tokenEnv`. */
export function bridgeTokenVerifierEnv(tokenEnv: string): string {
  return `${tokenEnv}_SHA256`;
}

export interface BridgeCredential {
  /** Constant-time check of a presented token. */
  matches(candidate: string | undefined): boolean;
  /**
   * The token, when this process was handed one rather than a verifier. Only
   * test harnesses read it: a bridge started by a current backend has none.
   */
  readonly plainToken: string | undefined;
}

function credentialFromVerifier(
  verifier: string,
  plainToken: string | undefined,
): BridgeCredential {
  const expected = Buffer.from(verifier, "hex");
  return {
    plainToken,
    matches(candidate) {
      if (!candidate) return false;
      return timingSafeEqual(expected, createHash("sha256").update(candidate).digest());
    },
  };
}

/** A credential over a known token: a plain token env var, a fallback or a test's. */
export function bridgeCredentialFromToken(token: string): BridgeCredential {
  return credentialFromVerifier(bridgeTokenVerifier(token), token);
}

/**
 * Keep same-uid processes out of this one, including the agent it spawns: while
 * a process is non-dumpable `/proc/<pid>/{environ,mem,fd}` belong to root and
 * ptrace is refused. `exec` resets the flag, so children are unaffected.
 *
 * Linux under Bun only, and best-effort: failing costs a boundary rather than
 * the bridge, so it is logged and the bridge starts anyway.
 */
export function markProcessNonDumpable(): boolean {
  if (process.platform !== "linux" || !process.versions.bun) return false;
  try {
    // Reached through createRequire because bridges bundle for `--target=node`,
    // and typed here because their tsconfigs do not load Bun's definitions.
    const { dlopen, FFIType } = createRequire(import.meta.url)("bun:ffi") as {
      dlopen(
        path: string,
        symbols: Record<string, { args: unknown[]; returns: unknown }>,
      ): {
        symbols: { prctl(...args: [number, bigint, bigint, bigint, bigint]): number };
        close(): void;
      };
      FFIType: { i32: unknown; u64: unknown };
    };
    const libc = dlopen("libc.so.6", {
      prctl: {
        args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64],
        returns: FFIType.i32,
      },
    });
    try {
      if (libc.symbols.prctl(PR_SET_DUMPABLE, 0n, 0n, 0n, 0n) === 0) return true;
    } finally {
      libc.close();
    }
    log.warn("credential.not-hardened", { reason: "prctl-refused" });
  } catch {
    log.warn("credential.not-hardened", { reason: "ffi-unavailable" });
  }
  return false;
}

/**
 * Read this bridge's credential from the environment once and remove it, so
 * nothing the bridge spawns inherits it. A verifier wins over a plain token, a
 * malformed verifier is a token nobody holds, and with neither the bridge fails
 * closed the same way.
 */
export function loadBridgeCredential(
  tokenEnv: string,
  options: { env?: NodeJS.ProcessEnv; harden?: () => unknown } = {},
): BridgeCredential {
  const env = options.env ?? process.env;
  const verifierEnv = bridgeTokenVerifierEnv(tokenEnv);
  const verifier = env[verifierEnv]?.trim();
  const token = env[tokenEnv]?.trim();
  delete env[verifierEnv];
  delete env[tokenEnv];
  if (verifier) {
    (options.harden ?? markProcessNonDumpable)();
    return VERIFIER_PATTERN.test(verifier)
      ? credentialFromVerifier(verifier, undefined)
      : bridgeCredentialFromToken(mintBridgeToken());
  }
  return bridgeCredentialFromToken(token || mintBridgeToken());
}
