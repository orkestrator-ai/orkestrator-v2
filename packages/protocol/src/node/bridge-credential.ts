/**
 * The credential that authorises calls to a bridge (security report H4).
 *
 * A bridge shares its uid with the agent it runs, so anything the bridge keeps
 * in a file, in its startup environment or on an open descriptor the agent can
 * read too. So the bridge keeps no secret at all: the backend gives it the
 * SHA-256 of the token ({@link bridgeTokenVerifierEnv}) and holds the token
 * itself. An agent that reads the verifier cannot answer an approval with it,
 * because a 256-bit preimage cannot be recovered. A backend that also gives it
 * an authority key (`<TOKEN_ENV>_AUTHORITY_KEY`) makes every request that
 * changes an agent's authority carry a signature too (`bridge-authority.ts`),
 * so a token caught in flight answers nothing.
 *
 * The token still crosses the bridge's memory on each request, so a bridge that
 * takes a verifier also marks itself non-dumpable: the kernel then gives
 * `/proc/<pid>/{environ,mem,fd}` to root and refuses a same-uid ptrace. What
 * the agent's uid can still do is in docs/architecture/agent-approvals.md.
 *
 * A plain token env var stays accepted for a bridge started by a backend that
 * predates the verifier, and for test harnesses.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";
import { createLogger } from "../logger.js";
import { loadBridgeAuthority, type BridgeAuthority } from "./bridge-authority.js";

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
  /**
   * The signatures this bridge requires on what changes an agent's authority
   * (`bridge-authority.ts`). Unenforced when the backend gave it no key.
   */
  readonly authority: BridgeAuthority;
}

function credentialFromVerifier(
  verifier: string,
  plainToken: string | undefined,
  authority: BridgeAuthority = UNENFORCED_AUTHORITY,
): BridgeCredential {
  const expected = Buffer.from(verifier, "hex");
  return {
    plainToken,
    authority,
    matches(candidate) {
      if (!candidate) return false;
      return timingSafeEqual(expected, createHash("sha256").update(candidate).digest());
    },
  };
}

const UNENFORCED_AUTHORITY = loadBridgeAuthority("", { env: {} });

/** A credential over a known token: a plain token env var, a fallback or a test's. */
export function bridgeCredentialFromToken(
  token: string,
  authority: BridgeAuthority = UNENFORCED_AUTHORITY,
): BridgeCredential {
  return credentialFromVerifier(bridgeTokenVerifier(token), token, authority);
}

/**
 * Keep same-uid processes out of this one, including the agent it spawns: while
 * a process is non-dumpable `/proc/<pid>/{environ,mem,fd}` belong to root and
 * ptrace is refused. `exec` resets the flag, so children are unaffected.
 *
 * Linux under Bun only, and best-effort: failing costs a boundary rather than
 * the bridge, so it is logged and the bridge starts anyway.
 */
export function markProcessNonDumpable(
  loadFfi = () => createRequire(import.meta.url)("bun:ffi"),
): boolean {
  if (process.platform !== "linux" || !process.versions.bun) return false;
  try {
    // Reached through createRequire because bridges bundle for `--target=node`,
    // and typed here because their tsconfigs do not load Bun's definitions.
    const { dlopen, FFIType } = loadFfi() as {
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
  const authority = loadBridgeAuthority(tokenEnv, { env });
  if (verifier) {
    (options.harden ?? markProcessNonDumpable)();
    return VERIFIER_PATTERN.test(verifier)
      ? credentialFromVerifier(verifier, undefined, authority)
      : bridgeCredentialFromToken(mintBridgeToken(), authority);
  }
  return bridgeCredentialFromToken(token || mintBridgeToken(), authority);
}
