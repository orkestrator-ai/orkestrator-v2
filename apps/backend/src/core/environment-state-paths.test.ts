import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  ENVIRONMENT_STATE_ROOTS,
  environmentStateDirectories,
  environmentStateDirectory,
  environmentStateKey,
  isEnvironmentStateKey,
} from "./environment-state-paths.js";

describe("environment state paths", () => {
  // Pinned: bridges already wrote state under this scheme. Changing it would
  // strand every existing directory, because nothing else references them.
  test("keys state by the first 32 hex characters of sha256(environmentId)", () => {
    expect(environmentStateKey("e1")).toBe("8b5cc4df7eec7d32a7814eca4af047ae");
    expect(isEnvironmentStateKey(environmentStateKey("any-environment"))).toBe(true);
    expect(isEnvironmentStateKey("not-a-key")).toBe(false);
    expect(isEnvironmentStateKey("8B5CC4DF7EEC7D32A7814ECA4AF047AE")).toBe(false);
  });

  test("covers every bridge state root under the data directory", () => {
    expect([...ENVIRONMENT_STATE_ROOTS]).toEqual([
      "pi-bridge-sessions",
      "pi-bridge-state",
      "cursor-bridge-state",
      "acp-bridge-state",
    ]);
    const dataDir = path.join(path.sep, "data");
    expect(environmentStateDirectory(dataDir, "cursor-bridge-state", "e1")).toBe(
      path.join(dataDir, "cursor-bridge-state", "8b5cc4df7eec7d32a7814eca4af047ae"),
    );
    expect(environmentStateDirectories(dataDir, "e1")).toEqual(
      ENVIRONMENT_STATE_ROOTS.map((root) =>
        path.join(dataDir, root, "8b5cc4df7eec7d32a7814eca4af047ae"),
      ),
    );
  });
});
