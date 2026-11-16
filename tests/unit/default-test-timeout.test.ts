import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_TEST_TIMEOUT_MS } from "../default-test-timeout";

const testsDir = join(import.meta.dir, "..");

describe("default test timeout preload", () => {
  // Every package's tests start from one of these two preloads, so the hang
  // watchdog only covers the whole repository while both import it.
  test.each(["setup.ts", "setup-node.ts"])("%s installs the shared hang watchdog", (name) => {
    expect(readFileSync(join(testsDir, name), "utf8")).toContain(
      'import "./default-test-timeout";',
    );
  });

  test("is far above Bun's five-second default so a loaded host cannot fail a healthy test", () => {
    expect(DEFAULT_TEST_TIMEOUT_MS).toBe(60_000);
  });
});
