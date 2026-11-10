import path from "node:path";
import { parseSync } from "oxc-parser";
import { walk, type AnyNode } from "./ast";
import type { ScannedFile, SourceGuard } from "./guard";
import {
  LIB_BACKEND_PREFIX,
  LibBackendShimResolver,
  visitShimUses,
} from "./lib-backend-command-default";
import { isTestSource } from "./paths";
import {
  WEB_SOURCE_ROOT,
  bringsValues,
  dynamicImportOf,
  moduleIdOfFile,
  moduleReferences,
  repositoryModules,
  resolveWebModule,
  type ReadModule,
} from "./web-modules";

/**
 * Command-bound calls inside a node's workspace (plan item 4007, report §7.6).
 *
 * The workspace is what a node's content renders: `WorkspaceContent` (an
 * environment's `TerminalContainer` and a project's `ProjectWorkspace`), the
 * node's toolbar and files panel (`NodeWorkspaceLayout`), and the panels an
 * in-tree node mounts beside them. An in-tree leaf renders the same modules
 * inside its own `NodeScopeProvider`, so a command-bound export there sends
 * the leaf's command to the command node.
 *
 * The guard follows the value imports (static, re-exports and `import()`)
 * from those roots, and in every module it reaches counts each use of a
 * command-bound export: a `lib/backend` named export (plan item 3002's shim)
 * or any other renderer module's export bound to `commandBackendClient` or
 * `portalBackendClient` (`lib/claude-tmux-client`). The count is per subject
 * and module, `[kanban] apps/web/src/components/x.tsx`, and it only falls.
 *
 * Not followed and not counted: the clients themselves (`lib/backend/**`,
 * `lib/node-scope/**`), `src/test/**`, test sources, and the window-level and
 * command-only modules in `WORKSPACE_EXEMPT_MODULES`, each with its reason.
 * What a workspace module reaches only through an exempt module is the
 * window's too.
 */

export const WORKSPACE_GUARD_ROOTS = [WEB_SOURCE_ROOT] as const;

/** Where a node's workspace starts (module ids, see `web-modules.ts`). */
export const WORKSPACE_ROOT_MODULES: readonly string[] = [
  // The central region: environments (`TerminalContainer`) and projects (`ProjectWorkspace`).
  `${WEB_SOURCE_ROOT}/components/layout/WorkspaceContent`,
  // Another node's toolbar and files panel, in the window's tree.
  `${WEB_SOURCE_ROOT}/components/layout/NodeWorkspaceLayout`,
  // The panels `InTreeWorkspace` mounts inside the node's scope.
  `${WEB_SOURCE_ROOT}/components/layout/OpenFileDialog`,
  `${WEB_SOURCE_ROOT}/components/agent-mail/AgentMailPanel`,
];

/** The scope machinery and the typed clients: the calls they make are the point. */
const NOT_FOLLOWED_PREFIXES: readonly string[] = [
  `${WEB_SOURCE_ROOT}/test/`,
  `${WEB_SOURCE_ROOT}/lib/node-scope/`,
  LIB_BACKEND_PREFIX,
];

const NOT_FOLLOWED_MODULES: ReadonlySet<string> = new Set([
  `${WEB_SOURCE_ROOT}/lib/backend`,
  `${WEB_SOURCE_ROOT}/lib/node-scope-slots`,
]);

/**
 * Window-level and command-only modules the workspace imports. Their calls
 * are the window's (or the command node's by design), so the guard neither
 * counts them nor follows their imports. Module id → why.
 */
export const WORKSPACE_EXEMPT_MODULES: Readonly<Record<string, string>> = {
  [`${WEB_SOURCE_ROOT}/components/settings/agent/refresh-model-catalog`]:
    "Global Settings' model catalogue refresh, for the window's settings; the workspace " +
    "imports only its MODEL_CATALOG_REFRESHED_EVENT name.",
  [`${WEB_SOURCE_ROOT}/stores/nativeNoticeDismissalStore`]:
    "A window store (unscoped zustand): which notices this client dismissed is the client's " +
    "own state, kept with its other client state on the command node. Scoping it is a store " +
    "conversion, not a call site.",
};

/**
 * Command-bound exports that are the window's wherever they are called,
 * `subject` → name → why. A use of one is not counted.
 */
export const WORKSPACE_WINDOW_LEVEL_EXPORTS: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  "config-integrations": {
    openInBrowser:
      "Opens a link on the machine the window runs on (the desktop shell, the browser tab, " +
      "or the command node that hosts this client), never on the workspace's node.",
  },
};

function windowLevel(
  exports: Readonly<Record<string, Readonly<Record<string, string>>>>,
): (subject: string, name: string) => boolean {
  return (subject, name) => Object.hasOwn(exports[subject] ?? {}, name);
}

function followed(moduleId: string, exempt: Readonly<Record<string, string>>): boolean {
  return (
    moduleId.startsWith(`${WEB_SOURCE_ROOT}/`) &&
    !NOT_FOLLOWED_MODULES.has(moduleId) &&
    !NOT_FOLLOWED_PREFIXES.some((prefix) => moduleId.startsWith(prefix)) &&
    !Object.hasOwn(exempt, moduleId)
  );
}

/** The value imports of one module, as module ids. */
function valueImportsOf(file: string, source: string): string[] {
  const { program } = parseSync(file, source, { preserveParens: false, astType: "js" });
  const root = program as unknown as AnyNode;
  const references = moduleReferences(root, source);
  if (source.includes("import("))
    walk(root, (node) => {
      const reference = dynamicImportOf(node);
      if (reference) references.push(reference);
    });
  const targets: string[] = [];
  for (const reference of references) {
    if (!bringsValues(reference)) continue;
    const target = resolveWebModule(file, reference.specifier);
    if (target) targets.push(target);
  }
  return targets;
}

/** Every module the roots reach through followed value imports (roots included). */
export function workspaceGraph(
  readModule: ReadModule,
  roots: readonly string[] = WORKSPACE_ROOT_MODULES,
  exempt: Readonly<Record<string, string>> = WORKSPACE_EXEMPT_MODULES,
): Set<string> {
  const seen = new Set<string>();
  const queue = roots.filter((root) => followed(root, exempt));
  while (queue.length > 0) {
    const moduleId = queue.pop()!;
    if (seen.has(moduleId)) continue;
    const found = readModule(moduleId);
    if (!found || isTestSource(found.file)) continue;
    seen.add(moduleId);
    for (const target of valueImportsOf(found.file, found.source))
      if (!seen.has(target) && followed(target, exempt)) queue.push(target);
  }
  return seen;
}

/** A command-bound export's subject: the `lib/backend` file, or the module under `src/`. */
export function commandBoundSubject(moduleId: string): string | null {
  if (moduleId.startsWith(LIB_BACKEND_PREFIX)) return moduleId.slice(LIB_BACKEND_PREFIX.length);
  return moduleId.startsWith(`${WEB_SOURCE_ROOT}/`)
    ? moduleId.slice(WEB_SOURCE_ROOT.length + 1)
    : null;
}

export interface WorkspaceCommandBoundCallOptions {
  readModule?: ReadModule;
  roots?: readonly string[];
  exempt?: Readonly<Record<string, string>>;
  windowLevelExports?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** The workspace graph, when the caller has already computed it from the same modules. */
  graph?: ReadonlySet<string>;
}

export function createWorkspaceCommandBoundCallGuard(
  options: WorkspaceCommandBoundCallOptions = {},
): SourceGuard {
  const readModule =
    options.readModule ?? repositoryModules(path.resolve(import.meta.dir, "../.."));
  const roots = options.roots ?? WORKSPACE_ROOT_MODULES;
  const exempt = options.exempt ?? WORKSPACE_EXEMPT_MODULES;
  let graph: ReadonlySet<string> | null = options.graph ?? null;
  const inGraph = (file: Pick<ScannedFile, "path">) =>
    (graph ??= workspaceGraph(readModule, roots, exempt)).has(moduleIdOfFile(file.path));
  const resolver = new LibBackendShimResolver(readModule, commandBoundSubject);
  const allowed = windowLevel(options.windowLevelExports ?? WORKSPACE_WINDOW_LEVEL_EXPORTS);
  return {
    id: "workspace-command-bound-call",
    advice:
      "This module renders inside a node's workspace, and a command-bound export reaches the " +
      "command node whichever node the workspace shows. Call the workspace's node: " +
      "backendForScope(scope) (@/lib/backend/scope-backend) or backendApiForScope(scope, " +
      "createXApi, backend), with the scope from useNodeScope() / useShimNodeScope(); " +
      "claudeTmuxClientFor(scope) for tmux. A window-level module goes in " +
      "WORKSPACE_EXEMPT_MODULES with its reason. See docs/development/node-scopes.md.",
    productionRoots: WORKSPACE_GUARD_ROOTS,
    appliesTo: (file) =>
      file.path.startsWith(`${WEB_SOURCE_ROOT}/`) && !isTestSource(file.path) && inGraph(file),
    // Only a module that imports another renderer module can use a command-bound export.
    mayOffend: (source) => source.includes("@/") || source.includes("./"),
    visit: (program: AnyNode, file: ScannedFile) => visitShimUses(program, file, resolver, allowed),
  };
}

export const workspaceCommandBoundCall: SourceGuard = createWorkspaceCommandBoundCallGuard();
