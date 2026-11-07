import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseSync } from "oxc-parser";
import { memberName, propertyKey, unwrap, type AnyNode } from "./ast";
import type { GuardVisitor, ScannedFile, SourceGuard, SubjectFinding } from "./guard";
import { isTestSource } from "./paths";
import { WEB_SOURCE_ROOT, moduleIdOfFile, moduleReferences, resolveWebModule } from "./web-modules";

/**
 * Static calls on a converted store's hook (`useXStore.getState()`,
 * `setState`, `subscribe`, `getInitialState`), the deprecated command-scope
 * shim of plan item 3001 (report §7.3). Each one is code that has not said
 * which node it means, so it silently reaches the command node. The count is
 * per store and per file, and it only falls.
 *
 * The store is found from the import, never from the identifier's spelling:
 * an aliased import counts, a re-export through a barrel (`@/stores`) or any
 * other module is followed to the store module, and an unrelated binding that
 * happens to share the hook's name does not count. Only converted stores
 * (`SHIMMED_STORES`) are counted; a store enters the guard when its plan item
 * converts it. Test files and test-support modules are not counted.
 */

export interface ShimmedStore {
  /** The def's name (`defineScopedStore(name, …)`); the subject of its baseline entries. */
  store: string;
  /** Module id of the store module (see `web-modules.ts`). */
  module: string;
  /** The exported hook that carries the deprecated statics (`scopedStoreHook(def)`). */
  hook: string;
}

/**
 * The converted stores. A store item that converts a store adds one entry
 * here, in the same change as its `scopedStoreHook` (a repository test fails
 * on a `scopedStoreHook` export that is not listed).
 */
export const SHIMMED_STORES: readonly ShimmedStore[] = [
  {
    store: "claude-options",
    module: "apps/web/src/stores/claudeOptionsStore",
    hook: "useClaudeOptionsStore",
  },
  {
    store: "config",
    module: "apps/web/src/stores/configStore",
    hook: "useConfigStore",
  },
  {
    store: "environment",
    module: "apps/web/src/stores/environmentStore",
    hook: "useEnvironmentStore",
  },
  {
    store: "project",
    module: "apps/web/src/stores/projectStore",
    hook: "useProjectStore",
  },
  // Plan item 3007: the files panel's per-node state (its chrome is a window store).
  {
    store: "files-panel",
    module: "apps/web/src/stores/filesPanelStore",
    hook: "useFilesPanelStore",
  },
  {
    store: "project-pull-requests",
    module: "apps/web/src/stores/projectPullRequestsStore",
    hook: "useProjectPullRequestsStore",
  },
  // Plan item 3003: the light per-node stores (batch A).
  {
    store: "agent-activity",
    module: "apps/web/src/stores/agentActivityStore",
    hook: "useAgentActivityStore",
  },
  {
    store: "agent-model-catalog",
    module: "apps/web/src/stores/agentModelCatalogStore",
    hook: "useAgentModelCatalogStore",
  },
  {
    store: "environment-diff",
    module: "apps/web/src/stores/environmentDiffStore",
    hook: "useEnvironmentDiffStore",
  },
  {
    store: "multi-review",
    module: "apps/web/src/stores/multiReviewStore",
    hook: "useMultiReviewStore",
  },
  {
    store: "pr-monitor",
    module: "apps/web/src/stores/prMonitorStore",
    hook: "usePrMonitorStore",
  },
  {
    store: "tab-launch",
    module: "apps/web/src/stores/tabLaunchStore",
    hook: "useTabLaunchStore",
  },
  {
    store: "worktree-snapshot",
    module: "apps/web/src/stores/worktreeSnapshotStore",
    hook: "useWorktreeSnapshotStore",
  },
  // Plan item 3011: the pipeline, Kanban, feature plan, coordinator and graph stores.
  {
    store: "build-pipeline",
    module: "apps/web/src/stores/buildPipelineStore",
    hook: "useBuildPipelineStore",
  },
  {
    store: "kanban",
    module: "apps/web/src/stores/kanbanStore",
    hook: "useKanbanStore",
  },
  {
    store: "feature-plan",
    module: "apps/web/src/stores/featurePlanStore",
    hook: "useFeaturePlanStore",
  },
  {
    store: "coordinator-activity",
    module: "apps/web/src/stores/coordinatorActivityStore",
    hook: "useCoordinatorActivityStore",
  },
  {
    store: "coordinator-launch-override",
    module: "apps/web/src/stores/coordinatorLaunchOverrideStore",
    hook: "useCoordinatorLaunchOverrideStore",
  },
  {
    store: "coordinator-pane-layout",
    module: "apps/web/src/stores/coordinatorPaneLayoutStore",
    hook: "useCoordinatorPaneLayoutStore",
  },
  {
    store: "graph-designer",
    module: "apps/web/src/stores/graphDesignerStore",
    hook: "useGraphDesignerStore",
  },
  {
    store: "graph-run",
    module: "apps/web/src/stores/graphRunStore",
    hook: "useGraphRunStore",
  },
  {
    store: "graph-describe",
    module: "apps/web/src/stores/graphDescribeStore",
    hook: "useGraphDescribeStore",
  },
  // Plan item 3009: the agent and transcript stores.
  {
    store: "native-agent-projection",
    module: "apps/web/src/stores/nativeAgentProjectionStore",
    hook: "useNativeAgentProjectionStore",
  },
  {
    store: "native-compose",
    module: "apps/web/src/stores/nativeComposeStore",
    hook: "useNativeComposeStore",
  },
  {
    store: "prompt-draft",
    module: "apps/web/src/stores/promptDraftStore",
    hook: "usePromptDraftStore",
  },
  // Plan item 3012: the workflow stores (batch B).
  {
    store: "design",
    module: "apps/web/src/stores/designStore",
    hook: "useDesignStore",
  },
  {
    store: "change-projection",
    module: "apps/web/src/stores/changeProjectionStore",
    hook: "useChangeProjectionStore",
  },
  {
    store: "file-dirty",
    module: "apps/web/src/stores/fileDirtyStore",
    hook: "useFileDirtyStore",
  },
  {
    store: "github-issues",
    module: "apps/web/src/stores/githubIssuesStore",
    hook: "useGitHubIssuesStore",
  },
  {
    store: "preview-service",
    module: "apps/web/src/stores/previewServiceStore",
    hook: "usePreviewServiceStore",
  },
  {
    store: "pull-requests",
    module: "apps/web/src/stores/pullRequestsStore",
    hook: "usePullRequestsStore",
  },
  {
    store: "web-annotation",
    module: "apps/web/src/stores/webAnnotationStore",
    hook: "useWebAnnotationStore",
  },
  {
    store: "web-annotation-preferences",
    module: "apps/web/src/stores/webAnnotationPreferencesStore",
    hook: "useWebAnnotationPreferencesStore",
  },
];

/** The statics a zustand hook carries, which the shim keeps as deprecated. */
export const SHIM_MEMBERS: ReadonlySet<string> = new Set([
  "getState",
  "setState",
  "subscribe",
  "getInitialState",
]);

export const SCOPED_STORE_SHIM_ROOTS = [WEB_SOURCE_ROOT] as const;

/** In-tree test helpers, which `isTestSource` does not recognise by path. */
const EXEMPT_PREFIXES = ["apps/web/src/test/"] as const;

/** A module's file (repository-relative) and source by module id, or `null` when there is none. */
export type ReadModule = (moduleId: string) => { file: string; source: string } | null;

const MODULE_FILE_SUFFIXES = [".ts", ".tsx", "/index.ts", "/index.tsx"] as const;

/** Reads renderer modules from a repository checkout. */
export function repositoryModules(root: string): ReadModule {
  return (moduleId) => {
    if (!moduleId.startsWith(`${WEB_SOURCE_ROOT}/`)) return null;
    for (const suffix of MODULE_FILE_SUFFIXES) {
      const file = `${moduleId}${suffix}`;
      const absolute = path.join(root, file);
      if (existsSync(absolute)) return { file, source: readFileSync(absolute, "utf8") };
    }
    return null;
  };
}

/** Where a module's exported name comes from, if it re-exports it. */
interface ModuleExports {
  /** Exported name → the module and name it re-exports. */
  named: Map<string, { module: string; imported: string }>;
  /** `export * from` targets. */
  star: string[];
}

function exportsOf(file: string, source: string): ModuleExports {
  const { program } = parseSync(file, source, { preserveParens: false, astType: "js" });
  const root = program as unknown as AnyNode;
  const named = new Map<string, { module: string; imported: string }>();
  const star: string[] = [];
  const imports = new Map<string, { module: string; imported: string }>();
  for (const reference of moduleReferences(root, source)) {
    if (reference.typeOnly) continue;
    const module = resolveWebModule(file, reference.specifier);
    if (!module) continue;
    if (reference.kind === "export-all" && reference.specifiers.length === 0) star.push(module);
    for (const specifier of reference.specifiers) {
      if (specifier.typeOnly) continue;
      const entry = { module, imported: specifier.imported };
      if (reference.kind === "import") imports.set(specifier.local, entry);
      else if (reference.kind === "export-from") named.set(specifier.local, entry);
    }
  }
  // `import { a as b } from "x"; export { b as c };`
  for (const statement of root.body ?? []) {
    if (statement.type !== "ExportNamedDeclaration" || statement.source) continue;
    for (const specifier of statement.specifiers ?? []) {
      const local = specifier.local?.name;
      const exported = specifier.exported?.name ?? specifier.exported?.value;
      const binding = local ? imports.get(local) : undefined;
      if (binding && typeof exported === "string") named.set(exported, binding);
    }
  }
  return { named, star };
}

/** Follows re-exports from a module's exported name to a converted store. */
export class ShimmedStoreResolver {
  private readonly byModule = new Map<string, Map<string, ShimmedStore>>();
  private readonly exportsCache = new Map<string, { source: string; exports: ModuleExports }>();

  constructor(
    stores: readonly ShimmedStore[],
    private readonly readModule: ReadModule,
  ) {
    for (const store of stores) {
      const hooks = this.byModule.get(store.module) ?? new Map<string, ShimmedStore>();
      hooks.set(store.hook, store);
      this.byModule.set(store.module, hooks);
    }
  }

  /** The store module's own binding of its hook, for counting a store's calls on itself. */
  ownHook(moduleId: string, local: string): ShimmedStore | null {
    return this.byModule.get(moduleId)?.get(local) ?? null;
  }

  storeOf(moduleId: string, exported: string, seen: Set<string> = new Set()): ShimmedStore | null {
    const direct = this.byModule.get(moduleId)?.get(exported);
    if (direct) return direct;
    const key = `${moduleId}#${exported}`;
    if (seen.has(key) || seen.size > 32) return null;
    seen.add(key);
    const exports = this.exports(moduleId);
    if (!exports) return null;
    const named = exports.named.get(exported);
    if (named) return this.storeOf(named.module, named.imported, seen);
    for (const target of exports.star) {
      const found = this.storeOf(target, exported, seen);
      if (found) return found;
    }
    return null;
  }

  private exports(moduleId: string): ModuleExports | null {
    const found = this.readModule(moduleId);
    if (found === null) return null;
    const cached = this.exportsCache.get(moduleId);
    if (cached && cached.source === found.source) return cached.exports;
    const exports = exportsOf(found.file, found.source);
    this.exportsCache.set(moduleId, { source: found.source, exports });
    return exports;
  }
}

type Binding =
  { kind: "named"; module: string; imported: string } | { kind: "namespace"; module: string };

interface Candidate {
  offset: number;
  module: string;
  exported: string;
}

function visitShimCalls(
  program: AnyNode,
  file: ScannedFile,
  resolver: ShimmedStoreResolver,
): GuardVisitor {
  const bindings = new Map<string, Binding>();
  for (const reference of moduleReferences(program, file.source)) {
    if (reference.kind !== "import" || reference.typeOnly) continue;
    const module = resolveWebModule(file.path, reference.specifier);
    if (!module) continue;
    for (const specifier of reference.specifiers) {
      if (specifier.typeOnly) continue;
      bindings.set(
        specifier.local,
        specifier.imported === "*"
          ? { kind: "namespace", module }
          : { kind: "named", module, imported: specifier.imported },
      );
    }
  }
  const ownModule = moduleIdOfFile(file.path);
  const candidates: Candidate[] = [];
  const own: SubjectFinding[] = [];

  /** The store `node` names: an imported hook, `ns.hook`, or the module's own hook. */
  const note = (offset: number, target: AnyNode): void => {
    const object = unwrap(target);
    if (object.type === "Identifier") {
      const binding = bindings.get(object.name);
      if (binding?.kind === "named") {
        candidates.push({ offset, module: binding.module, exported: binding.imported });
        return;
      }
      const self = binding ? null : resolver.ownHook(ownModule, object.name);
      if (self) own.push({ offset, subject: self.store });
      return;
    }
    if (object.type === "MemberExpression" && !object.computed) {
      const namespace = unwrap(object.object);
      const name = memberName(object);
      if (namespace.type !== "Identifier" || !name) return;
      const binding = bindings.get(namespace.name);
      if (binding?.kind === "namespace")
        candidates.push({ offset, module: binding.module, exported: name });
    }
  };

  return {
    handlers: {
      MemberExpression(node) {
        const name = memberName(node);
        if (name && SHIM_MEMBERS.has(name)) note(node.start, node.object);
      },
      // `const { getState } = useXStore;`
      VariableDeclarator(node) {
        if (node.id?.type !== "ObjectPattern" || !node.init) return;
        const shims = node.id.properties.filter(
          (property: AnyNode) =>
            property.type === "Property" && SHIM_MEMBERS.has(propertyKey(property) ?? ""),
        );
        for (const property of shims) note(property.start, node.init);
      },
    },
    finish: () => {
      const findings: SubjectFinding[] = [...own];
      for (const candidate of candidates) {
        const store = resolver.storeOf(candidate.module, candidate.exported);
        if (store) findings.push({ offset: candidate.offset, subject: store.store });
      }
      return findings.sort((left, right) => left.offset - right.offset);
    },
  };
}

export function appliesToShimCaller(file: Pick<ScannedFile, "path">): boolean {
  return (
    SCOPED_STORE_SHIM_ROOTS.some((root) => file.path.startsWith(`${root}/`)) &&
    !EXEMPT_PREFIXES.some((prefix) => file.path.startsWith(prefix)) &&
    !isTestSource(file.path)
  );
}

export interface ScopedStoreShimOptions {
  stores?: readonly ShimmedStore[];
  readModule?: ReadModule;
}

export function createScopedStoreShimGuard(options: ScopedStoreShimOptions = {}): SourceGuard {
  const stores = options.stores ?? SHIMMED_STORES;
  const readModule =
    options.readModule ?? repositoryModules(path.resolve(import.meta.dir, "../.."));
  return {
    id: "scoped-store-shim",
    advice:
      "A converted store's static getState/setState/subscribe is the deprecated command-scope " +
      "shim: it does not say which node it means. Name the scope instead: in a component, " +
      "const scope = useNodeScope() and then scope.store(def).getState(); in plain code, take " +
      "the NodeScope as a parameter. Reading state for rendering stays the hook " +
      "(useXStore(selector)). See docs/development/node-scopes.md.",
    productionRoots: SCOPED_STORE_SHIM_ROOTS,
    appliesTo: appliesToShimCaller,
    mayOffend: (source) =>
      stores.length > 0 && /\b(?:getState|setState|subscribe|getInitialState)\b/.test(source),
    // A resolver per scan pass would re-read the barrels for every file; one per
    // guard caches each module's exports until its source changes.
    visit: (() => {
      const resolver = new ShimmedStoreResolver(stores, readModule);
      return (program: AnyNode, file: ScannedFile) => visitShimCalls(program, file, resolver);
    })(),
  };
}

export const scopedStoreShim: SourceGuard = createScopedStoreShimGuard();
