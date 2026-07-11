import { describe, expect, test } from "bun:test";
import {
  GATEWAY_COOKIE_MAX_BYTES,
  GatewayTokenValidationError,
  gatewayTokenCookieHeader,
  getGatewayTokenValidationError,
  normalizeGatewayToken,
} from "./gateway-token";

describe("gateway token validation", () => {
  test("normalizes valid boundary-length tokens", () => {
    expect(normalizeGatewayToken(`  ${"a".repeat(16)}  `)).toBe("a".repeat(16));
    expect(normalizeGatewayToken("z".repeat(1024))).toBe("z".repeat(1024));
  });

  test("rejects tokens outside the character limits", () => {
    expect(getGatewayTokenValidationError("a".repeat(15))).toContain("at least 16");
    expect(getGatewayTokenValidationError("a".repeat(1025))).toContain("1024 characters or fewer");
  });

  test("rejects malformed Unicode before cookie encoding", () => {
    const malformed = "\ud800".repeat(16);
    expect(getGatewayTokenValidationError(malformed)).toContain("invalid Unicode");
    expect(() => normalizeGatewayToken(malformed)).toThrow(GatewayTokenValidationError);
  });

  test("rejects values whose encoded cookie exceeds the browser limit", () => {
    const multibyteToken = "😀".repeat(512);
    expect(multibyteToken.length).toBe(1024);
    expect(getGatewayTokenValidationError(multibyteToken)).toContain("too large");
  });

  test("creates a bounded HttpOnly strict cookie for accepted values", () => {
    const header = gatewayTokenCookieHeader("valid token value 123");
    expect(header).toContain("orkestrator_gateway_auth=valid%20token%20value%20123");
    expect(header).toContain("HttpOnly; SameSite=Strict; Path=/");
    expect(new TextEncoder().encode(header).byteLength).toBeLessThanOrEqual(GATEWAY_COOKIE_MAX_BYTES);
  });
});
