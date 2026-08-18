import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");

/**
 * Scope: the backend and the bridges, where `refactor(core): split large
 * modules` turned single files into many mutually importing ones. The renderer
 * is deliberately excluded - its component graph has a different shape and
 * pinning it here would bury the signal this test exists for.
 */
const SCANNED_ROOTS = [
  "apps/backend/src",
  "bridges/acp-bridge/src",
  "bridges/claude-bridge/src",
  "bridges/codex-bridge/src",
];

/**
 * The backend and the bridges are acyclic, and this test exists to keep them
 * that way.
 *
 * A cycle is not cosmetic: every module in one is evaluated with some of its
 * imports still in the temporal dead zone, so a single new top-level read of an
 * imported binding turns into a `ReferenceError` whose reproduction depends on
 * which module the process happens to import first. That already happened once
 * here - `commands-runtime-state` still loads the git-status scanners through
 * `await import(...)` for exactly this reason, pinned by
 * `commands-runtime-state-load-order.test.ts`.
 *
 * If this list is ever non-empty again, each entry needs a reason. Prefer
 * moving the shared symbol into a leaf both sides can depend on; where the
 * back-edge is a notification rather than a dependency (see
 * `setMergeCleanupScheduler`), invert it so the owner registers itself.
 */
const KNOWN_CYCLES: ReadonlyArray<{ cycle: readonly string[]; reason: string }> = [];

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === "node_modules" || entry === "generated") continue;
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
      out.push(full);
    }
  };
  const start = join(repoRoot, root);
  if (existsSync(start)) walk(start);
  return out;
}

function resolveSpec(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec)
    .replace(/\.js$/, "")
    .replace(/\.tsx?$/, "");
  for (const ext of [".ts", ".tsx"]) if (existsSync(base + ext)) return base + ext;
  return null;
}

/**
 * Value-level edges only. `import type` and `export type` are erased by the
 * compiler, so they cannot produce an initialization cycle at runtime.
 */
function valueImports(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const deps: string[] = [];
  for (const match of text.matchAll(
    /^\s*(?:import|export)\s+(?![\s\S]{0,10}?\btype\s)[^;]*?from\s+"(\.[^"]+)"/gm,
  )) {
    const dep = resolveSpec(file, match[1]);
    if (dep) deps.push(dep);
  }
  for (const match of text.matchAll(
    /^\s*(?:import|export)\s+\*\s+(?:as\s+\w+\s+)?from\s+"(\.[^"]+)"/gm,
  )) {
    const dep = resolveSpec(file, match[1]);
    if (dep) deps.push(dep);
  }
  return deps;
}

function findCycles(): string[][] {
  const files = SCANNED_ROOTS.flatMap(sourceFiles);
  const graph = new Map<string, string[]>();
  for (const file of files) graph.set(file, valueImports(file));

  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const visit = (node: string) => {
    state.set(node, 1);
    stack.push(node);
    for (const dep of graph.get(node) ?? []) {
      if (!graph.has(dep)) continue;
      const seen = state.get(dep) ?? 0;
      if (seen === 1) {
        // Normalize to the sorted set of members so the same cycle reported
        // from a different entry point compares equal.
        const members = stack.slice(stack.indexOf(dep));
        cycles.push([...new Set(members.map((m) => relative(repoRoot, m)))].sort());
      } else if (seen === 0) {
        visit(dep);
      }
    }
    stack.pop();
    state.set(node, 2);
  };
  for (const node of graph.keys()) if ((state.get(node) ?? 0) === 0) visit(node);

  const unique = new Map<string, string[]>();
  for (const cycle of cycles) unique.set(cycle.join(" <-> "), cycle);
  return [...unique.values()].sort((a, b) => a.join().localeCompare(b.join()));
}

describe("backend and bridge module import cycles", () => {
  test("the backend and bridge module graphs are acyclic", () => {
    // Stated separately from the allow-list check so the guarantee does not
    // quietly become vacuous if an entry is ever added to KNOWN_CYCLES.
    expect(findCycles()).toEqual([]);
  });

  test("no runtime import cycle exists outside the recorded set", () => {
    const found = findCycles().map((cycle) => cycle.join(" <-> "));
    const allowed = new Set(KNOWN_CYCLES.map((entry) => [...entry.cycle].sort().join(" <-> ")));

    const introduced = found.filter((cycle) => !allowed.has(cycle));
    expect(introduced).toEqual([]);
  });

  test("every recorded cycle still exists", () => {
    // A stale entry is as bad as a missing one: it lets the next real cycle
    // hide behind an allowance that no longer describes anything.
    const found = new Set(findCycles().map((cycle) => cycle.join(" <-> ")));
    const stale = KNOWN_CYCLES.map((entry) => [...entry.cycle].sort().join(" <-> ")).filter(
      (cycle) => !found.has(cycle),
    );

    expect(stale).toEqual([]);
  });

  test("every recorded cycle carries a reason", () => {
    for (const entry of KNOWN_CYCLES) {
      expect(entry.reason.length).toBeGreaterThan(40);
    }
  });
});
