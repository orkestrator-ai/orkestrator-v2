import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CONTRACTS_DIRECTORY,
  readReleaseIndex,
  readReleaseSnapshot,
} from "../../../scripts/contract-snapshots";
import {
  CONTRACT_CHECK_COMMAND,
  LOCKFILE_DIRECTORIES,
  VERSIONED_MANIFESTS,
  setVersion,
  targetVersion,
  withVersion,
} from "../../../scripts/set-version";

const CONTRACT_MANIFEST = {
  schemaVersion: 1,
  generatedBy: "test",
  counts: { commands: 2, defined: 0, untyped: 2 },
  untypedByDomain: { nodes: 1, system: 1 },
  domains: {},
  commands: {
    get_status: { domain: "system", untyped: true, read: true },
    list_nodes: { domain: "nodes", untyped: true, read: false },
  },
  events: {},
};

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
  const contracts = path.join(root, CONTRACTS_DIRECTORY);
  mkdirSync(contracts, { recursive: true });
  writeFileSync(path.join(contracts, "manifest.json"), JSON.stringify(CONTRACT_MANIFEST));
  const calls: Array<{ command: string[]; cwd: string }> = [];
  const logs: string[] = [];
  return {
    root,
    contracts,
    calls,
    logs,
    run: (command: string[], cwd: string) => {
      calls.push({ command, cwd });
    },
    log: (message: string) => {
      logs.push(message);
    },
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
  test("checks the contract, installs each lockfile, verifies each frozen, then checks drift", () => {
    const runtime = fixture();
    setVersion(["2.23.0"], runtime);
    expect(runtime.calls).toEqual([
      { command: CONTRACT_CHECK_COMMAND, cwd: runtime.root },
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
  test.each([0, 1, 2, 3, 4, 5])(
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
      // A stale contract manifest (step 0) fails before any manifest is written.
      if (step === 0) {
        expect(
          JSON.parse(readFileSync(path.join(runtime.root, "package.json"), "utf8")).version,
        ).toBe("2.22.0");
      }
      expect(existsSync(path.join(runtime.contracts, "releases/2.23.0.json"))).toBe(false);
      setVersion(["2.23.0"], runtime);
      expect(runtime.calls).toHaveLength(6);
      expect(readReleaseSnapshot(runtime.contracts, "2.23.0").version).toBe("2.23.0");
    },
  );
  test("writes the release's contract snapshot from the committed manifest", () => {
    const runtime = fixture();
    setVersion(["2.23.0-beta"], runtime);
    const snapshot = readReleaseSnapshot(runtime.contracts, "2.23.0-beta");
    expect(snapshot).toMatchObject({ channel: "beta", preContract: false, readClassified: true });
    expect(snapshot.commands).toEqual({
      get_status: { domain: "system", untyped: true, read: true },
      list_nodes: { domain: "nodes", untyped: true, read: false },
    });
    expect(readReleaseIndex(runtime.contracts).releases).toEqual([
      { version: "2.23.0-beta", channel: "beta", publishedAt: null },
    ]);
    expect(runtime.logs.some((line) => line.includes("releases/2.23.0-beta.json"))).toBe(true);
    // Retrying the same target rewrites nothing.
    const before = readFileSync(path.join(runtime.contracts, "releases/2.23.0-beta.json"), "utf8");
    setVersion(["2.23.0-beta"], runtime);
    expect(readFileSync(path.join(runtime.contracts, "releases/2.23.0-beta.json"), "utf8")).toBe(
      before,
    );
  });
  test("the next release shares unchanged domain blobs and records publication times", () => {
    const runtime = fixture();
    setVersion(["2.23.0"], runtime);
    const manifest = structuredClone(CONTRACT_MANIFEST) as typeof CONTRACT_MANIFEST & {
      commands: Record<string, unknown>;
    };
    manifest.commands.list_peers = { domain: "nodes", untyped: true, read: true };
    writeFileSync(path.join(runtime.contracts, "manifest.json"), JSON.stringify(manifest));
    setVersion(["2.24.0"], {
      ...runtime,
      listPublishedReleases: () => [
        { version: "2.22.0", tag: "v2.22.0", publishedAt: "2026-10-01T00:00:00Z" },
        { version: "2.23.0", tag: "v2.23.0", publishedAt: "2026-10-20T00:00:00Z" },
      ],
    });
    const first = JSON.parse(
      readFileSync(path.join(runtime.contracts, "releases/2.23.0.json"), "utf8"),
    ) as { domains: Record<string, { file: string }> };
    const second = JSON.parse(
      readFileSync(path.join(runtime.contracts, "releases/2.24.0.json"), "utf8"),
    ) as { domains: Record<string, { file: string }> };
    expect(second.domains.system!.file).toBe(first.domains.system!.file);
    expect(second.domains.nodes!.file).not.toBe(first.domains.nodes!.file);
    // Storage grows with the one changed domain.
    expect(readdirSync(path.join(runtime.contracts, "domains"))).toHaveLength(3);
    expect(readReleaseIndex(runtime.contracts).releases).toEqual([
      { version: "2.23.0", channel: "stable", publishedAt: "2026-10-20T00:00:00Z" },
      { version: "2.24.0", channel: "stable", publishedAt: null },
    ]);
    // A published release with no snapshot is reported, not added to the index.
    expect(runtime.logs.some((line) => line.includes("without a snapshot: 2.22.0"))).toBe(true);
  });
  test("an unavailable gh leaves publication times as they were", () => {
    const runtime = fixture();
    setVersion(["2.23.0"], { ...runtime, listPublishedReleases: () => null });
    expect(readReleaseIndex(runtime.contracts).releases).toEqual([
      { version: "2.23.0", channel: "stable", publishedAt: null },
    ]);
    expect(runtime.logs.some((line) => line.includes("Could not list GitHub releases"))).toBe(true);
  });
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
