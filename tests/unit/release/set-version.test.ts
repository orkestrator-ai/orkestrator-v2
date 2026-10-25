import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  LOCKFILE_DIRECTORIES,
  VERSIONED_MANIFESTS,
  setVersion,
  targetVersion,
  withVersion,
} from "../../../scripts/set-version";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "set-version-"));
  roots.push(root);
  for (const file of VERSIONED_MANIFESTS) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), '{\n  "version": "2.22.0",\n  "other": true\n}\n');
  }
  const calls: Array<{ command: string[]; cwd: string }> = [];
  return {
    root,
    calls,
    run: (command: string[], cwd: string) => {
      calls.push({ command, cwd });
    },
    log: () => undefined,
  };
}

describe("version bump", () => {
  test("documented manifest inventory agrees with the script", () => {
    const instructions = readFileSync(path.resolve(import.meta.dir, "../../../AGENTS.md"), "utf8");
    const section = instructions
      .split("## Application Version Bumps")[1]!
      .split("## Public CLI contract")[0]!;
    const documented = Array.from(
      section.matchAll(/^- `([^`]+package\.json|package\.json)`$/gm),
      (match) => match[1],
    );
    expect(documented.sort()).toEqual([...VERSIONED_MANIFESTS].sort());
  });
  test.each(["2.23.0", "v2.23.0-beta.2", "2.23.0-alpha.10"])("accepts %s", (version) => {
    expect(targetVersion(version, "2.22.0")).toBe(version.replace(/^v/, ""));
  });
  test.each([undefined, "", "2.21.0", "2.23", "2.23.0-rc.1", "2.23.0-alpha.foo"])(
    "rejects %s",
    (version) => {
      expect(() => targetVersion(version, "2.22.0")).toThrow();
    },
  );
  test("rewrites only the top-level version and preserves other bytes", () => {
    const input = '{\n  "version": "2.22.0",\n  "nested": { "version": "1.0.0" }\n}\n';
    expect(withVersion(input, "2.23.0")).toBe(input.replace('"2.22.0"', '"2.23.0"'));
    expect(() => withVersion('{"nested":{"version":"1.0.0"}}', "2.23.0")).toThrow(
      "top-level version",
    );
  });
  test("validates every manifest before writing any", () => {
    const runtime = fixture();
    writeFileSync(path.join(runtime.root, VERSIONED_MANIFESTS.at(-1)!), "{}\n");
    expect(() => setVersion(["2.23.0"], runtime)).toThrow("top-level version");
    expect(JSON.parse(readFileSync(path.join(runtime.root, "package.json"), "utf8")).version).toBe(
      "2.22.0",
    );
    expect(runtime.calls).toEqual([]);
  });
  test("installs each lockfile, verifies each frozen, then checks drift", () => {
    const runtime = fixture();
    setVersion(["2.23.0"], runtime);
    expect(runtime.calls).toEqual([
      ...LOCKFILE_DIRECTORIES.map((dir) => ({
        command: ["bun", "install"],
        cwd: path.join(runtime.root, dir),
      })),
      ...LOCKFILE_DIRECTORIES.map((dir) => ({
        command: ["bun", "install", "--frozen-lockfile"],
        cwd: path.join(runtime.root, dir),
      })),
      {
        command: ["bun", "test", "./tests/unit/version-drift.test.ts", "--parallel=1"],
        cwd: runtime.root,
      },
    ]);
    for (const file of VERSIONED_MANIFESTS)
      expect(JSON.parse(readFileSync(path.join(runtime.root, file), "utf8")).version).toBe(
        "2.23.0",
      );
  });
  test.each([0, 1, 2, 3, 4])(
    "step %s failure propagates and the same target can be retried",
    (step) => {
      const runtime = fixture();
      let calls = 0;
      expect(() =>
        setVersion(["2.23.0"], {
          ...runtime,
          run: () => {
            if (calls++ === step) throw new Error("step failed");
          },
        }),
      ).toThrow("step failed");
      expect(calls).toBe(step + 1);
      setVersion(["2.23.0"], runtime);
      expect(runtime.calls).toHaveLength(5);
    },
  );
  test("same-target retry refuses inconsistent manifests", () => {
    const runtime = fixture();
    writeFileSync(path.join(runtime.root, VERSIONED_MANIFESTS[1]), '{\n  "version": "2.21.0"\n}\n');
    expect(() => setVersion(["2.22.0"], runtime)).toThrow("every manifest");
    expect(runtime.calls).toEqual([]);
  });
  test("rejects extra arguments before writing", () => {
    const runtime = fixture();
    expect(() => setVersion(["2.23.0", "extra"], runtime)).toThrow("usage");
    expect(runtime.calls).toEqual([]);
  });
});
