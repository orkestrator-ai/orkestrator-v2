import { describe, expect, test } from "bun:test";
import {
  CODEX_MAX_CONCURRENT_THREADS_ENV,
  codexAppServerConfigOverrides,
  resolveCodexMaxConcurrentThreads,
} from "./codex-config.js";

describe("Codex app-server configuration", () => {
  test("defaults the concurrent spawned-thread limit to five", () => {
    expect(resolveCodexMaxConcurrentThreads(undefined)).toBe(5);
    expect(codexAppServerConfigOverrides({})).toEqual({
      "features.goals": "true",
      "agents.max_concurrent_threads_per_session": "5",
    });
  });

  test("forwards a valid configured limit", () => {
    expect(codexAppServerConfigOverrides({
      [CODEX_MAX_CONCURRENT_THREADS_ENV]: "8",
    })).toMatchObject({
      "agents.max_concurrent_threads_per_session": "8",
    });
  });

  test("falls back for values Codex would reject", () => {
    for (const value of ["", "0", "-1", "2.5", "many"]) {
      expect(resolveCodexMaxConcurrentThreads(value)).toBe(5);
    }
  });
});
