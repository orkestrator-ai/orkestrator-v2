import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { CONTROL_MCP_CONFIRM_TOKEN_TTL_MS } from "@orkestrator/protocol/control-mcp";
import { canonicalJson, type PublicActionName } from "@orkestrator/protocol/public-api";

/**
 * Confirm tokens for risky Control MCP actions, with no server state.
 *
 * The first call without a token is refused with `confirmation-required` and
 * a token; the second call with the identical input and that token runs. The
 * token is HMAC(secret, credential, action, request ID, input fingerprint, expiry), so a
 * changed input or request ID, an expired token or another credential's token is refused.
 * The secret lives only in this process: a backend restart invalidates every
 * outstanding token, which at a two-minute lifetime costs one repeated
 * question at most.
 */

const TOKEN_PATTERN = /^ct1\.([0-9a-z]{1,12})\.([A-Za-z0-9_-]{43})$/;

export type ConfirmTokenCheck = "valid" | "missing" | "malformed" | "expired" | "mismatch";

export function confirmFingerprint(
  action: PublicActionName,
  input: unknown,
  requestId?: string,
): string {
  return createHash("sha256").update(canonicalJson({ action, input, requestId })).digest("hex");
}

export class ConfirmTokens {
  constructor(
    private readonly secret: Buffer = randomBytes(32),
    private readonly now: () => number = Date.now,
  ) {}

  private mac(credentialId: string, fingerprint: string, expiresAt: number): string {
    return createHmac("sha256", this.secret)
      .update(credentialId)
      .update("\0")
      .update(fingerprint)
      .update("\0")
      .update(String(expiresAt))
      .digest("base64url");
  }

  issue(
    credentialId: string,
    action: PublicActionName,
    input: unknown,
    requestId?: string,
  ): { token: string; expiresAt: string } {
    const expiresAt = this.now() + CONTROL_MCP_CONFIRM_TOKEN_TTL_MS;
    const mac = this.mac(credentialId, confirmFingerprint(action, input, requestId), expiresAt);
    return {
      token: `ct1.${expiresAt.toString(36)}.${mac}`,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  check(
    token: unknown,
    credentialId: string,
    action: PublicActionName,
    input: unknown,
    requestId?: string,
  ): ConfirmTokenCheck {
    if (token === undefined || token === null || token === "") return "missing";
    const match = typeof token === "string" ? TOKEN_PATTERN.exec(token) : null;
    if (!match) return "malformed";
    const expiresAt = Number.parseInt(match[1]!, 36);
    if (!Number.isSafeInteger(expiresAt)) return "malformed";
    const expected = Buffer.from(
      this.mac(credentialId, confirmFingerprint(action, input, requestId), expiresAt),
    );
    const presented = Buffer.from(match[2]!);
    // Compare before the expiry check, so a forged token never learns whether
    // only its timestamp was wrong.
    if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) {
      return "mismatch";
    }
    return expiresAt <= this.now() ? "expired" : "valid";
  }
}
