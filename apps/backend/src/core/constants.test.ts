import { describe, expect, test } from "bun:test";
import backendPackage from "../../package.json" with { type: "json" };
import {
  AGENT_NETWORK_DOMAINS_BY_PLATFORM,
  DEFAULT_CODEX_MAX_CONCURRENT_THREADS,
  MAX_CODEX_CONCURRENT_THREADS,
  requiredAgentNetworkDomains,
  resolveCodexMaxConcurrentThreads,
} from "./constants.js";

describe("APP_VERSION", () => {
  test.each([
    ["absent", undefined, backendPackage.version],
    ["empty", "", backendPackage.version],
    ["whitespace", " \t\n ", backendPackage.version],
    ["explicit override", "9.8.7-test+build.1", "9.8.7-test+build.1"],
    ["trimmed override", " 9.8.7-test ", "9.8.7-test"],
    ["shell metacharacters", '"$(untrusted-command)"', "0.0.0"],
    ["embedded whitespace", "9.8.7 test", "0.0.0"],
    ["overlong override", "1".repeat(65), "0.0.0"],
  ])("resolves a %s environment value on import", async (_label, raw, expected) => {
    // A fresh process exercises the exported constant without reusing Bun's
    // module cache or mutating the test worker's environment. Set the value
    // after startup so automatic .env loading cannot replace the absent case.
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
          delete process.env.ORKESTRATOR_VERSION;
          const raw = ${JSON.stringify(raw) ?? "undefined"};
          if (raw !== undefined) process.env.ORKESTRATOR_VERSION = raw;
          const { APP_VERSION } = await import(${JSON.stringify(import.meta.dir + "/constants.ts")});
          process.stdout.write(APP_VERSION);
        `,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toBe(expected!);
  });
});

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
  test("returns nothing when no platform with its own hosts is enabled", () => {
    // Claude's API host is already a default.
    expect(requiredAgentNetworkDomains(["claude"])).toEqual([]);
    expect(requiredAgentNetworkDomains([])).toEqual([]);
  });

  test("OpenCode gets only its own providers' host", () => {
    // OpenCode Zen and Go, its zero-login default providers; any other
    // provider's host is the user's to add.
    expect(requiredAgentNetworkDomains(["claude", "opencode"])).toEqual(["opencode.ai"]);
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
    // Codex signed in with ChatGPT needs ChatGPT's backend and OpenAI's auth host.
    expect(requiredAgentNetworkDomains(["codex"])).toEqual(["chatgpt.com", "auth.openai.com"]);
    expect(requiredAgentNetworkDomains(["claude"])).not.toContain("chatgpt.com");
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
