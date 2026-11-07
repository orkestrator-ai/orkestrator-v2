import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { BASELINE_PATH, compareWithBaseline, parseBaseline } from "../source-guards/baseline";
import { baselineKey, emptyFindings, scanRepository, scanSource } from "../source-guards/scan";
import { repositoryModules } from "../source-guards/web-modules";
import {
  WORKSPACE_EXEMPT_MODULES,
  WORKSPACE_ROOT_MODULES,
  WORKSPACE_WINDOW_LEVEL_EXPORTS,
  commandBoundSubject,
  createWorkspaceCommandBoundCallGuard,
  workspaceCommandBoundCall,
  workspaceGraph,
} from "../source-guards/workspace-command-bound-call";

const ROOT = path.resolve(import.meta.dir, "../..");

/**
 * An in-memory renderer: a workspace root that imports a component, which
 * imports the `@/lib/backend` barrel, one `lib/backend` file, a tmux-style
 * client and a window-level module.
 */
const modules: Record<string, { file: string; source: string }> = {
  "apps/web/src/lib/backend": {
    file: "apps/web/src/lib/backend.ts",
    source: 'export * from "./backend/kanban";',
  },
  "apps/web/src/lib/backend/kanban": {
    file: "apps/web/src/lib/backend/kanban.ts",
    source: [
      "export function createKanbanApi(client) { return { listTasks: () => client.invokeRaw('l') }; }",
      "export const { listTasks } = createKanbanApi(commandBackendClient);",
    ].join("\n"),
  },
  "apps/web/src/lib/tmux-client": {
    file: "apps/web/src/lib/tmux-client.ts",
    source: [
      "export function createTmuxClient(client) { return { start: () => client.invokeRaw('s') }; }",
      "export const { start } = createTmuxClient(commandBackendClient, listen);",
    ].join("\n"),
  },
  "apps/web/src/components/Workspace": {
    file: "apps/web/src/components/Workspace.tsx",
    source: [
      'import { Board } from "./Board";',
      'import { Settings } from "@/components/WindowSettings";',
      'const Lazy = () => import("@/components/LazyPanel");',
      'import type { Typed } from "@/components/TypedOnly";',
    ].join("\n"),
  },
  "apps/web/src/components/Board": {
    file: "apps/web/src/components/Board.tsx",
    source: [
      'import { listTasks } from "@/lib/backend";',
      'import * as backend from "@/lib/backend";',
      'import { start } from "@/lib/tmux-client";',
      'import { backendApiForScope } from "@/lib/backend/client";',
      'import { createKanbanApi } from "@/lib/backend/kanban";',
      "await listTasks();",
      "await backend.listTasks();",
      "await start();",
      "await backendApiForScope(scope, createKanbanApi, { listTasks }).listTasks();",
    ].join("\n"),
  },
  "apps/web/src/components/LazyPanel": {
    file: "apps/web/src/components/LazyPanel.tsx",
    source: 'import { listTasks } from "@/lib/backend";\nlistTasks();',
  },
  "apps/web/src/components/WindowSettings": {
    file: "apps/web/src/components/WindowSettings.tsx",
    source:
      'import { Deep } from "./Deep";\nimport { listTasks } from "@/lib/backend";\nlistTasks();',
  },
  "apps/web/src/components/Deep": {
    file: "apps/web/src/components/Deep.tsx",
    source: 'import { listTasks } from "@/lib/backend";\nlistTasks();',
  },
  "apps/web/src/components/TypedOnly": {
    file: "apps/web/src/components/TypedOnly.tsx",
    source: 'import { listTasks } from "@/lib/backend";\nlistTasks();',
  },
  "apps/web/src/components/Outside": {
    file: "apps/web/src/components/Outside.tsx",
    source: 'import { listTasks } from "@/lib/backend";\nlistTasks();',
  },
};
const readModule = (moduleId: string) => modules[moduleId] ?? null;
const exempt = { "apps/web/src/components/WindowSettings": "the window's settings" };
const roots = ["apps/web/src/components/Workspace"];
const guard = createWorkspaceCommandBoundCallGuard({ readModule, roots, exempt });

function found(moduleId: string): Array<[number, string | undefined]> {
  const { file, source } = modules[moduleId]!;
  return scanSource({ path: file, source, isBunTest: false }, [guard]).map(({ line, subject }) => [
    line,
    subject,
  ]);
}

describe("workspace-command-bound-call (plan item 4007)", () => {
  test("the graph follows value imports and import(), not types, exempt modules or clients", () => {
    expect([...workspaceGraph(readModule, roots, exempt)].sort()).toEqual([
      "apps/web/src/components/Board",
      "apps/web/src/components/LazyPanel",
      "apps/web/src/components/Workspace",
      "apps/web/src/lib/tmux-client",
    ]);
  });

  test("counts lib/backend named exports and other command-bound clients, not the scoped fallback", () => {
    expect(found("apps/web/src/components/Board")).toEqual([
      [6, "kanban"],
      [7, "kanban"],
      [8, "lib/tmux-client"],
    ]);
    expect(found("apps/web/src/components/LazyPanel")).toEqual([[2, "kanban"]]);
  });

  test("a window-level export is not counted", () => {
    const windowLevel = createWorkspaceCommandBoundCallGuard({
      readModule,
      roots,
      exempt,
      windowLevelExports: { kanban: { listTasks: "opens on the window's machine" } },
    });
    const { file, source } = modules["apps/web/src/components/Board"]!;
    expect(
      scanSource({ path: file, source, isBunTest: false }, [windowLevel]).map(
        ({ line, subject }) => [line, subject],
      ),
    ).toEqual([[8, "lib/tmux-client"]]);
    expect(WORKSPACE_WINDOW_LEVEL_EXPORTS["config-integrations"]?.openInBrowser).toBeTruthy();
  });

  test("ignores modules outside the workspace graph, exempt ones and what only they reach", () => {
    for (const moduleId of [
      "apps/web/src/components/Outside",
      "apps/web/src/components/WindowSettings",
      "apps/web/src/components/Deep",
      "apps/web/src/components/TypedOnly",
    ])
      expect(found(moduleId)).toEqual([]);
    expect(
      scanSource(
        {
          path: "apps/web/src/components/Board.test.tsx",
          source: modules["apps/web/src/components/Board"]!.source,
          isBunTest: true,
        },
        [guard],
      ),
    ).toEqual([]);
  });

  test("a new command-bound call in the workspace graph fails the ratchet", () => {
    const findings = emptyFindings();
    const { file, source } = modules["apps/web/src/components/LazyPanel"]!;
    for (const finding of scanSource({ path: file, source, isBunTest: false }, [guard]))
      (findings[finding.guard][baselineKey(finding)] ??= []).push(finding);
    const baseline = parseBaseline("{}");
    const { regressions } = compareWithBaseline(findings, baseline);
    expect(regressions.map((regression) => regression.file)).toEqual([
      "[kanban] apps/web/src/components/LazyPanel.tsx",
    ]);
  });

  test("subjects: the lib/backend file, or the module under src/", () => {
    expect(commandBoundSubject("apps/web/src/lib/backend/kanban")).toBe("kanban");
    expect(commandBoundSubject("apps/web/src/lib/claude-tmux-client")).toBe(
      "lib/claude-tmux-client",
    );
    expect(commandBoundSubject("packages/protocol/src/x")).toBeNull();
  });

  test("the real workspace graph starts at the workspace and every exemption is in it", () => {
    const graph = workspaceGraph(repositoryModules(ROOT), WORKSPACE_ROOT_MODULES, {});
    for (const root of WORKSPACE_ROOT_MODULES) expect(graph.has(root)).toBe(true);
    expect(graph.has("apps/web/src/components/terminal/TerminalContainer")).toBe(true);
    expect(graph.has("apps/web/src/components/projects/ProjectWorkspace")).toBe(true);
    // An exemption names a module the workspace really reaches, with a reason.
    for (const [moduleId, reason] of Object.entries(WORKSPACE_EXEMPT_MODULES)) {
      expect(graph.has(moduleId)).toBe(true);
      expect(reason.length).toBeGreaterThan(10);
    }
  });

  test("the committed baseline is the scan of the tree", () => {
    const findings = scanRepository(ROOT, [workspaceCommandBoundCall])[
      "workspace-command-bound-call"
    ];
    const counts = Object.fromEntries(
      Object.entries(findings).map(([key, list]) => [key, list.length]),
    );
    const committed = parseBaseline(readFileSync(BASELINE_PATH, "utf8"))[
      "workspace-command-bound-call"
    ];
    expect(counts).toEqual(committed);
  }, 30_000);
});
