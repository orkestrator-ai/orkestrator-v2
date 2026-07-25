import { afterEach, describe, expect, test } from "bun:test";
import {
  CODEX_MAX_CONCURRENT_THREADS_ENV,
  DEFAULT_CODEX_MAX_CONCURRENT_THREADS,
  MAX_CODEX_CONCURRENT_THREADS,
  codexAppServerConfigOverrides,
  resolveCodexMaxConcurrentThreads,
} from "./codex-config.js";

const originalConfiguredLimit = process.env[CODEX_MAX_CONCURRENT_THREADS_ENV];

afterEach(() => {
  if (originalConfiguredLimit === undefined) {
    delete process.env[CODEX_MAX_CONCURRENT_THREADS_ENV];
  } else {
    process.env[CODEX_MAX_CONCURRENT_THREADS_ENV] = originalConfiguredLimit;
  }
});

describe("Codex app-server configuration", () => {
  test("defaults the concurrent spawned-thread limit to five", () => {
    expect(resolveCodexMaxConcurrentThreads(undefined)).toBe(5);
    expect(codexAppServerConfigOverrides({})).toEqual({
      "features.goals": "true",
      "agents.max_concurrent_threads_per_session": "5",
      "features.multi_agent_v2.max_concurrent_threads_per_session": "6",
    });
  });

  test("makes the child limit authoritative in legacy and root-inclusive V2 config", () => {
    expect(codexAppServerConfigOverrides({
      [CODEX_MAX_CONCURRENT_THREADS_ENV]: "8",
    })).toEqual({
      "features.goals": "true",
      "agents.max_concurrent_threads_per_session": "8",
      "features.multi_agent_v2.max_concurrent_threads_per_session": "9",
    });
  });

  test("uses process.env when no explicit environment is supplied", () => {
    process.env[CODEX_MAX_CONCURRENT_THREADS_ENV] = " 12 ";

    expect(codexAppServerConfigOverrides()).toMatchObject({
      "agents.max_concurrent_threads_per_session": "12",
      "features.multi_agent_v2.max_concurrent_threads_per_session": "13",
    });
  });

  test("accepts whitespace and the largest safely convertible child limit", () => {
    expect(resolveCodexMaxConcurrentThreads(" \t7\n")).toBe(7);
    expect(resolveCodexMaxConcurrentThreads(String(MAX_CODEX_CONCURRENT_THREADS)))
      .toBe(MAX_CODEX_CONCURRENT_THREADS);
    expect(codexAppServerConfigOverrides({
      [CODEX_MAX_CONCURRENT_THREADS_ENV]: String(MAX_CODEX_CONCURRENT_THREADS),
    })).toMatchObject({
      "agents.max_concurrent_threads_per_session": String(
        MAX_CODEX_CONCURRENT_THREADS,
      ),
      "features.multi_agent_v2.max_concurrent_threads_per_session": String(
        Number.MAX_SAFE_INTEGER,
      ),
    });
  });

  test("falls back for values Codex would reject", () => {
    for (const value of [
      "",
      "   ",
      "0",
      "-1",
      "2.5",
      "many",
      "Infinity",
      String(Number.MAX_SAFE_INTEGER),
      String(Number.MAX_SAFE_INTEGER + 1),
    ]) {
      expect(resolveCodexMaxConcurrentThreads(value)).toBe(
        DEFAULT_CODEX_MAX_CONCURRENT_THREADS,
      );
    }
  });
});
