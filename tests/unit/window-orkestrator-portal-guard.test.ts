import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { BASELINE_PATH, parseBaseline } from "../source-guards/baseline";
import { scanSource } from "../source-guards/scan";
import {
  WINDOW_ORKESTRATOR_PORTAL_ROOTS,
  windowOrkestratorPortal,
} from "../source-guards/window-orkestrator-portal";

const guard = windowOrkestratorPortal;
const file = "apps/web/src/components/Thing.tsx";

function lines(source: string, candidate = file): number[] {
  return scanSource({ path: candidate, source, isBunTest: false }, [guard]).map(
    (finding) => finding.line,
  );
}

describe("window-orkestrator-portal (plan item 5004)", () => {
  test("flags every read of the portal global, optional, computed or destructured", () => {
    const source = [
      "const a = window.orkestratorPortal?.invoke('list_nodes');",
      "if (!window.orkestratorPortal) throw new Error();",
      'const b = window["orkestratorPortal"];',
      "const c = globalThis.orkestratorPortal;",
      "const { orkestratorPortal } = window;",
      "const d = (self as Window).orkestratorPortal!.listen('x', () => {});",
    ].join("\n");
    expect(lines(source)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("ignores the other page globals, types, comments, injected windows and strings", () => {
    const source = [
      "// window.orkestratorPortal is the old portal channel",
      "const a = window.orkestratorWorkspaceTarget?.nodeId;",
      'type Portal = NonNullable<Window["orkestratorPortal"]>;',
      "targetWindow.orkestratorPortal = createBrowserGatewayApi({ baseUrl });",
      "const b = 'window.orkestratorPortal';",
      "const c = window.orkestrator;",
    ].join("\n");
    expect(lines(source)).toEqual([]);
  });

  test("applies to every renderer source", () => {
    const applies = (candidate: string) =>
      guard.appliesTo({ path: candidate, source: "", isBunTest: false });
    expect(guard.productionRoots).toEqual(WINDOW_ORKESTRATOR_PORTAL_ROOTS);
    expect(applies("apps/web/src/lib/portal/command-scope.ts")).toBe(true);
    expect(applies("apps/web/src/lib/portal/page-portal.ts")).toBe(true);
    expect(applies("apps/web/src/components/projects/LeafModeCoordinatorGate.tsx")).toBe(true);
    expect(applies("apps/desktop/electron/preload-api.ts")).toBe(false);
  });

  // The guard stage (`mise run guards`) holds the repository to this
  // baseline, so an empty baseline means no renderer file reads the global.
  test("no renderer file is tolerated reading the portal global", () => {
    const baseline = parseBaseline(readFileSync(BASELINE_PATH, "utf8"));
    expect(baseline["window-orkestrator-portal"]).toEqual({});
  });
});
