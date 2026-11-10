import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PROBE_CREATOR_PATTERN,
  isTemporaryDataDir,
  probeCreator,
} from "./container-host-reachability-creator.js";

describe("probeCreator", () => {
  test("names the runtime flavor and whether the data directory is temporary", () => {
    expect(probeCreator("agent-test", "/scratch/run-1/data", ["/scratch"])).toBe(
      "agent-test/temporary",
    );
    expect(probeCreator("production", "/home/user/.config/orkestrator-v2", ["/scratch"])).toBe(
      "production/persistent",
    );
    expect(probeCreator("development", "/scratch", ["/scratch"])).toBe("development/persistent");
  });

  test("is content-free: one of a fixed set of values, never a path", () => {
    for (const flavor of ["production", "development", "agent-test"] as const) {
      for (const dataDir of [join(tmpdir(), "secret-user", "data"), "/home/secret-user/data"]) {
        const value = probeCreator(flavor, dataDir);
        expect(value).toMatch(PROBE_CREATOR_PATTERN);
        expect(value).not.toContain("secret-user");
      }
    }
  });

  test("the system temporary directory counts by default", () => {
    expect(isTemporaryDataDir(join(tmpdir(), "orkestrator-spec-x", "data"))).toBe(true);
  });

  test("a sibling that only shares the prefix is not inside the root", () => {
    expect(isTemporaryDataDir("/scratch-other/data", ["/scratch"])).toBe(false);
    expect(isTemporaryDataDir("/scratch/../home/data", ["/scratch"])).toBe(false);
  });

  test("compares real paths, so a link into the temporary root is seen through", () => {
    const outside = mkdtempSync(join(tmpdir(), "probe-creator-"));
    try {
      const root = join(outside, "real-root");
      const link = join(outside, "linked-root");
      mkdirSync(join(root, "data"), { recursive: true });
      symlinkSync(root, link);
      // The data directory is named through the link, the root by its real path.
      expect(isTemporaryDataDir(join(link, "data"), [root])).toBe(true);
      // And the other way round.
      expect(isTemporaryDataDir(join(root, "data"), [link])).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
