import { describe, expect, test } from "bun:test";
import {
  GATEWAY_DESIGN_FRAME_CONTENT_SECURITY_POLICY,
  GATEWAY_LOGIN_CONTENT_SECURITY_POLICY,
  GATEWAY_RENDERER_CONTENT_SECURITY_POLICY,
  RENDERER_CONTENT_SECURITY_POLICY,
} from "./renderer-content-security-policy.js";

function directive(policy: string, name: string): string[] {
  const found = policy
    .split(";")
    .map((entry) => entry.trim().split(/\s+/))
    .find(([directiveName]) => directiveName === name);
  if (!found) throw new Error(`The policy has no ${name} directive`);
  return found.slice(1);
}

describe("renderer Content Security Policy", () => {
  test("never lets script run from anywhere but the renderer's own files", () => {
    expect(directive(RENDERER_CONTENT_SECURITY_POLICY, "script-src")).toEqual(["'self'"]);
    expect(RENDERER_CONTENT_SECURITY_POLICY).not.toContain("unsafe-eval");
    expect(directive(RENDERER_CONTENT_SECURITY_POLICY, "object-src")).toEqual(["'none'"]);
    expect(directive(RENDERER_CONTENT_SECURITY_POLICY, "base-uri")).toEqual(["'self'"]);
  });

  test("names no IPv6 host, which Chromium reports as invalid and ignores", () => {
    expect(RENDERER_CONTENT_SECURITY_POLICY).not.toContain("[");
  });

  test("the gateway header adds what a meta tag cannot carry and nothing else", () => {
    expect(RENDERER_CONTENT_SECURITY_POLICY).not.toContain("frame-ancestors");
    expect(GATEWAY_RENDERER_CONTENT_SECURITY_POLICY).toBe(
      `${RENDERER_CONTENT_SECURITY_POLICY}; frame-ancestors 'self'`,
    );
  });

  test("fits a double-quoted HTML attribute", () => {
    expect(RENDERER_CONTENT_SECURITY_POLICY).not.toMatch(/["<>&]/);
  });

  test("the login page runs no script and posts only to the gateway", () => {
    expect(directive(GATEWAY_LOGIN_CONTENT_SECURITY_POLICY, "default-src")).toEqual(["'none'"]);
    expect(directive(GATEWAY_LOGIN_CONTENT_SECURITY_POLICY, "form-action")).toEqual(["'self'"]);
  });

  test("the design frame document stays sandboxed without same-origin", () => {
    expect(directive(GATEWAY_DESIGN_FRAME_CONTENT_SECURITY_POLICY, "sandbox")).toEqual([
      "allow-scripts",
    ]);
  });
});
