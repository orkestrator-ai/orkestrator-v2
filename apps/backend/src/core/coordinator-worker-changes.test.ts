import { describe, expect, test } from "bun:test";
import {
  environmentChangeResourceKey,
  type ChangeFileRow,
} from "@orkestrator/protocol/change-resources";
import { gitScopeResourceKey } from "./change-tracking/git-scopes.js";
import {
  parseWorkerChangesOptions,
  readWorkerChanges,
  renderDiffBody,
  uncommittedChangeResourceKey,
} from "./coordinator-worker-changes.js";
import type { Environment } from "./models.js";

const BASE = "a".repeat(40);
const environment = {
  id: "env-1",
  name: "worker",
  environmentType: "containerized",
  status: "running",
  branch: "worker-branch",
  delegationBaseBranch: "main",
  delegationBaseCommit: BASE,
  createdFromCommit: BASE,
} as unknown as Environment;

function row(path: string, index: number, extra: Partial<ChangeFileRow> = {}): ChangeFileRow {
  return {
    rowId: `m:${index}`,
    pathId: path,
    oldPathDisplay: path,
    newPathDisplay: path,
    status: "modified",
    fileKind: "text",
    additions: { value: 2, quality: "complete", bound: null },
    deletions: { value: 1, quality: "complete", bound: null },
    bodyAvailability: "available",
    reasonKey: null,
    detail: null,
    ...extra,
  } as ChangeFileRow;
}

/** A fake of the `changes_*` commands: pages of `pageSize` rows per resource. */
function changes(resources: Record<string, ChangeFileRow[]>, diffLines = 3) {
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  const page = (key: string, offset: number, size: number) => {
    const rows = resources[key]!.slice(offset, offset + size);
    const next = offset + size < resources[key]!.length ? String(offset + size) : null;
    return { rows, nextCursor: next, totalRows: resources[key]!.length, snapshotToken: `t:${key}` };
  };
  const run = async (command: string, args: Record<string, unknown>) => {
    calls.push({ command, args });
    const key = args.resourceKey as string;
    switch (command) {
      case "changes_get_view":
        if (!resources[key])
          return {
            kind: "error",
            error: { code: "not-found", reasonKey: "changes.error.not-found" },
          };
        return {
          kind: "projection",
          projection: {
            revision: 7,
            state: "ready",
            observationState: "fresh",
            coverageState: "complete",
            reasonKeys: [],
            counters: {
              additions: { value: 2 * resources[key]!.length, quality: "complete", bound: null },
              deletions: { value: resources[key]!.length, quality: "complete", bound: null },
              changedFiles: resources[key]!.length,
            },
            filePage: page(key, 0, args.pageSize as number),
          },
        };
      case "changes_get_files":
        return { kind: "page", ...page(key, Number(args.cursor), args.pageSize as number) };
      case "changes_resolve_live_detail":
        expect(args.revision).toBe(7);
        return { kind: "identity", identity: { id: `diff:${args.rowId as string}` } };
      case "changes_get_diff":
        return {
          kind: "body",
          files: [
            {
              bodyAvailability: "available",
              truncated: false,
              hunks: [
                {
                  header: "@@ -1,1 +1,2 @@",
                  lines: Array.from({ length: diffLines }, (_, index) => ({
                    type: index === 0 ? "remove" : "add",
                    text: `line ${index} ${"x".repeat(40)}`,
                  })),
                },
              ],
            },
          ],
        };
      default:
        throw new Error(`unexpected ${command}`);
    }
  };
  return { run, calls };
}

const environmentKey = environmentChangeResourceKey("env-1");
const uncommittedKey = gitScopeResourceKey("uncommitted-net", "env-1");

test("the uncommitted key is change tracking's own", () => {
  expect(uncommittedChangeResourceKey("env-1")).toBe(uncommittedKey);
});

describe("get_worker_changes reader", () => {
  test("reports commits, files since base with uncommitted marks, and diffs", async () => {
    const { run } = changes({
      [environmentKey]: [
        row("src/a.ts", 0),
        row("src/b.ts", 1),
        row("img.png", 2, { fileKind: "binary" }),
      ],
      [uncommittedKey]: [row("src/b.ts", 0)],
    });
    const logs: string[][] = [];
    const commit = "b".repeat(40);
    const result = await readWorkerChanges(
      run,
      environment,
      parseWorkerChangesOptions({}),
      async (args) => {
        logs.push(args);
        return `${commit}\x1fFix a\x1fAda\x1f2026-10-31T00:00:00Z\x1e`;
      },
    );
    // The commit range is the worker's base to HEAD.
    expect(logs[0]).toContain(`${BASE}..HEAD`);
    expect(result).toMatchObject({
      branch: "worker-branch",
      base: { branch: "main", commit: BASE },
      commits: { items: [{ commit, subject: "Fix a" }], truncated: false },
      sinceBase: {
        available: true,
        totals: { changedFiles: 3 },
        files: [
          { path: "src/a.ts", status: "modified", additions: 2, deletions: 1, uncommitted: false },
          { path: "src/b.ts", uncommitted: true },
          { path: "img.png", kind: "binary" },
        ],
        truncated: false,
      },
      uncommitted: { files: [{ path: "src/b.ts" }], truncated: false },
      truncated: false,
    });
    const diffs = (result.diffs as { files: Array<Record<string, unknown>> }).files;
    expect(diffs[0]!.diff).toStartWith("@@ -1,1 +1,2 @@\n-line 0");
    expect(diffs[2]).toEqual({ path: "img.png", diff: null, reason: "binary-file" });
  });

  test("bounds files and diff bytes and says how to page and narrow", async () => {
    const rows = Array.from({ length: 450 }, (_, index) =>
      row(`dir${index % 2}/f${index}.ts`, index),
    );
    const { run, calls } = changes({ [environmentKey]: rows, [uncommittedKey]: [] }, 2_000);
    const result = await readWorkerChanges(
      run,
      environment,
      parseWorkerChangesOptions({ maxFiles: 5, maxDiffFiles: 3 }),
      async () => "",
    );
    const sinceBase = result.sinceBase as Record<string, unknown>;
    expect((sinceBase.files as unknown[]).length).toBe(5);
    expect(sinceBase).toMatchObject({ truncated: true, nextOffset: 5 });
    const diffs = result.diffs as {
      files: Array<{ diff: string; truncated?: boolean }>;
      bytes: number;
      omittedFiles: number;
      truncated: boolean;
    };
    // Three files rendered, each cut at 16 KiB; the other two are omitted.
    expect(diffs.files).toHaveLength(3);
    expect(diffs.files.every((file) => file.truncated === true)).toBe(true);
    expect(diffs.bytes).toBeLessThanOrEqual(3 * 16 * 1024);
    expect(diffs).toMatchObject({ omittedFiles: 2, truncated: true });
    expect(result.truncated).toBe(true);
    expect(result.narrow).toContain("offset");
    // Only enough pages were read to fill the answer.
    expect(calls.filter((call) => call.command === "changes_get_files")).toHaveLength(0);

    const paged = await readWorkerChanges(
      run,
      environment,
      // offset counts matching files: the 151st file under dir1 is f301.
      parseWorkerChangesOptions({ maxFiles: 2, offset: 150, paths: ["dir1"], includeDiff: false }),
      async () => "",
    );
    expect((paged.sinceBase as { files: Array<{ path: string }> }).files).toEqual([
      expect.objectContaining({ path: "dir1/f301.ts" }),
      expect.objectContaining({ path: "dir1/f303.ts" }),
    ]);
    expect(paged.diffs).toBeUndefined();
  });

  test("single-file mode renders one whole diff and a missing measurement is reported", async () => {
    const { run } = changes({ [environmentKey]: [row("a.ts", 0), row("b.ts", 1)] }, 50);
    const result = await readWorkerChanges(
      run,
      environment,
      parseWorkerChangesOptions({ file: "b.ts" }),
      null,
    );
    expect((result.sinceBase as { files: unknown[] }).files).toEqual([
      expect.objectContaining({ path: "b.ts" }),
    ]);
    const diffs = result.diffs as { files: Array<{ path: string; truncated?: boolean }> };
    expect(diffs.files).toEqual([expect.objectContaining({ path: "b.ts" })]);
    expect(diffs.files[0]!.truncated).toBeUndefined();
    // No uncommitted measurement and no Git runner (a stopped container).
    expect(result.uncommitted).toMatchObject({ available: false });
    expect(result.commits).toMatchObject({ items: [], unavailable: expect.any(String) });
  });

  test("commit lists are bounded and say how to see more", async () => {
    const { run } = changes({ [environmentKey]: [], [uncommittedKey]: [] });
    const lines = Array.from(
      { length: 3 },
      (_, index) => `${String(index).repeat(40)}\x1fs${index}\x1fa\x1f2026-10-31T00:00:00Z\x1e`,
    ).join("");
    const result = await readWorkerChanges(
      run,
      environment,
      parseWorkerChangesOptions({ maxCommits: 2 }),
      async (args) => {
        expect(args).toContain("--max-count=3");
        return lines;
      },
    );
    expect(result.commits).toMatchObject({ truncated: true, more: expect.any(String) });
    expect((result.commits as { items: unknown[] }).items).toHaveLength(2);
  });

  test("options refuse paths outside the worker and out-of-range bounds", () => {
    expect(() => parseWorkerChangesOptions({ paths: ["../x"] })).toThrow("inside the worker");
    expect(() => parseWorkerChangesOptions({ file: "/etc/passwd" })).toThrow("inside the worker");
    expect(() => parseWorkerChangesOptions({ file: "a", paths: ["b"] })).toThrow("not both");
    expect(() => parseWorkerChangesOptions({ maxFiles: 501 })).toThrow("maxFiles");
    expect(() => parseWorkerChangesOptions({ maxDiffBytes: 10 * 1024 * 1024 })).toThrow(
      "maxDiffBytes",
    );
  });

  test("renderDiffBody stops at the byte limit", () => {
    const rendered = renderDiffBody(
      {
        pathId: "a",
        oldPathDisplay: "a",
        newPathDisplay: "a",
        status: "modified",
        fileKind: "text",
        bodyAvailability: "available",
        reasonKey: null,
        truncated: false,
        hunks: [
          {
            header: "@@ -1 +1 @@",
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            lines: [
              { type: "remove", text: "old", oldLine: 1, newLine: null },
              { type: "add", text: "new", oldLine: null, newLine: 1 },
              { type: "no-newline", text: "", oldLine: null, newLine: null },
            ],
          },
        ],
      },
      20,
    );
    expect(rendered).toEqual({ text: "@@ -1 +1 @@\n-old", bytes: 17, truncated: true });
  });
});
