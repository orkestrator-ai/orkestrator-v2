import { describe, expect, test } from "bun:test";
import {
  AGENT_NETWORK_DOMAINS_BY_PLATFORM,
  DEFAULT_CODEX_MAX_CONCURRENT_THREADS,
  MAX_CODEX_CONCURRENT_THREADS,
  requiredAgentNetworkDomains,
  resolveCodexMaxConcurrentThreads,
} from "./constants.js";

describe("resolveCodexMaxConcurrentThreads", () => {
  test.each([
    ["missing", undefined],
    ["numeric string", "8"],
    ["zero", 0],
    ["negative", -1],
    ["fraction", 1.5],
    ["NaN", Number.NaN],
    ["infinity", Number.POSITIVE_INFINITY],
    ["root-slot overflow", Number.MAX_SAFE_INTEGER],
    ["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
  ])("falls back for %s values", (_label, value) => {
    expect(resolveCodexMaxConcurrentThreads(value)).toBe(DEFAULT_CODEX_MAX_CONCURRENT_THREADS);
  });

  test.each([
    ["minimum", 1],
    ["maximum child limit", MAX_CODEX_CONCURRENT_THREADS],
  ])("preserves the %s valid value", (_label, value) => {
    expect(resolveCodexMaxConcurrentThreads(value)).toBe(value);
  });
});

describe("requiredAgentNetworkDomains", () => {
  test("returns nothing when no ACP platform is enabled", () => {
    expect(requiredAgentNetworkDomains(["claude", "codex", "opencode"])).toEqual([]);
    expect(requiredAgentNetworkDomains([])).toEqual([]);
  });

  test("treats an unknown selection as opening nothing", () => {
    // A missing selection must fail closed: widening the firewall is the
    // dangerous direction, and the caller can always enable a platform.
    expect(requiredAgentNetworkDomains(undefined)).toEqual([]);
    expect(requiredAgentNetworkDomains(["gemini"])).toEqual([]);
  });

  test("returns only the hosts belonging to each enabled platform", () => {
    expect(requiredAgentNetworkDomains(["cursor"])).toEqual([
      ...AGENT_NETWORK_DOMAINS_BY_PLATFORM.cursor,
    ]);
    expect(requiredAgentNetworkDomains(["grok"])).toEqual([
      ...AGENT_NETWORK_DOMAINS_BY_PLATFORM.grok,
    ]);
    expect(requiredAgentNetworkDomains(["pi"])).toEqual([...AGENT_NETWORK_DOMAINS_BY_PLATFORM.pi]);
    expect(requiredAgentNetworkDomains(["cursor"])).not.toContain("auth.x.ai");
    expect(requiredAgentNetworkDomains(["grok"])).not.toContain("cursor.com");
    expect(requiredAgentNetworkDomains(["pi"])).toContain("radius.pi.dev");
    expect(requiredAgentNetworkDomains(["pi"])).toContain("api.anthropic.com");
    expect(requiredAgentNetworkDomains(["pi"])).not.toContain("auth.x.ai");
  });

  test("combines enabled platforms without overlap", () => {
    const combined = requiredAgentNetworkDomains(["cursor", "grok", "pi"]);
    expect(new Set(combined).size).toBe(combined.length);
    expect(combined).toContain("api2.cursor.sh");
    expect(combined).toContain("cli-chat-proxy.grok.com");
    expect(combined).toContain("radius.pi.dev");
  });

  test("publishes frozen per-platform host lists", () => {
    expect(Object.isFrozen(AGENT_NETWORK_DOMAINS_BY_PLATFORM)).toBe(true);
    expect(Object.isFrozen(AGENT_NETWORK_DOMAINS_BY_PLATFORM.cursor)).toBe(true);
    expect(Object.isFrozen(AGENT_NETWORK_DOMAINS_BY_PLATFORM.grok)).toBe(true);
    expect(Object.isFrozen(AGENT_NETWORK_DOMAINS_BY_PLATFORM.pi)).toBe(true);
  });
});
