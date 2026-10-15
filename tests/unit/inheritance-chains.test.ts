import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parseSync, visitorKeys, type Node } from "oxc-parser";

const repoRoot = resolve(import.meta.dir, "../..");

const SCANNED_ROOTS = ["apps", "bridges", "packages"];

/**
 * Generated code, build output and test support are not product classes. A
 * fake extending another fake in `testing/` is not the shape this test exists
 * to stop.
 */
const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  "generated",
  "dist",
  "testing",
  "test",
  "tests",
  "__tests__",
]);

const PLAN_04 = "docs/2026-10-14/04-remaining-inheritance-chains-and-guard.md";

/**
 * Layered `extends` chains that predate this guard. Each one is a single class
 * that `refactor(core): split large modules` (#417) cut into files by size, held
 * together by `abstract` forward declarations. They are being taken apart into
 * collaborators, and this list must only ever shrink.
 *
 * Entries are pinned exactly, base first. A chain that gains a layer fails as
 * new; a chain that loses one fails as stale, so whoever shortens it updates the
 * entry in the same change.
 *
 * Coordination: plans 01 (storage), 02 (native agent service) and 04 are being
 * done in parallel, and each removes its own entry below. Whichever merges
 * second rebases onto the first and updates this list (drop the merged entry,
 * keep the rest) rather than restoring it. Plan 03 (claude-bridge
 * `sendPrompt`) splits one function, not a class chain, so it has no entry.
 * The web annotation chain was removed by plan 04 step 2.
 */
const PINNED_CHAINS: ReadonlyArray<{ classes: readonly string[]; plan: string; reason: string }> = [
  {
    classes: [
      "StorageBase",
      "StorageProjects",
      "StorageConfig",
      "StorageSessions",
      "StorageReviews",
      "StorageNative",
      "StoragePrompts",
      "StorageBuildPipelines",
      "StorageDrafts",
      "StorageAgentMail",
      "StorageKanban",
      "StoragePreviewServices",
      "StoragePublicOperations",
      "StorageService",
    ],
    plan: "docs/2026-10-14/01-storage-json-file-store-and-repositories.md",
    reason:
      "StorageService split by size into 14 layers; plan 01 replaces it with a JSON file store and per-domain repositories.",
  },
  {
    classes: [
      "NativeAgentServiceBase",
      "NativeAgentServiceDispatch",
      "NativeAgentServiceProjection",
      "NativeAgentServicePrompt",
      "NativeAgentServiceReconciliation",
      "NativeAgentServiceProvider",
    ],
    plan: "docs/2026-10-14/02-native-agent-service-collaborators.md",
    reason:
      "NativeAgentService (exported as NativeAgentServiceProvider) split into six layers; plan 02 turns them into collaborators.",
  },
  {
    classes: [
      "GatewayBase",
      "GatewayEvents",
      "GatewayAuth",
      "GatewayHandlers",
      "GatewayProxy",
      "OrkestratorGateway",
    ],
    plan: PLAN_04,
    reason:
      "OrkestratorGateway split into events, auth, handlers and proxy layers; plan 04 moves them onto a GatewayContext.",
  },
  {
    classes: [
      "AppServerRuntimeBase",
      "AppServerRuntimeLifecycle",
      "AppServerRuntimeSessions",
      "AppServerRuntimePrompt",
      "AppServerRuntimeTail",
      "AppServerRuntime",
    ],
    plan: PLAN_04,
    reason:
      "Codex AppServerRuntime split into lifecycle, sessions, prompt and tail layers; plan 04 moves them onto a CodexRuntimeContext.",
  },
];

/**
 * Deliberate one-level inheritance between project classes: a specialised
 * error a caller can still catch as its parent, or a subclass that overrides
 * one hook of a reusable base. Anything here is `[base, subclass]`. Error
 * subclasses of the built-in `Error` are not listed - they are not
 * project-class inheritance.
 */
const INTENTIONAL_SUBCLASSES: ReadonlyArray<{
  classes: readonly [string, string];
  reason: string;
}> = [
  {
    classes: ["ProviderUnavailableError", "ProviderUnreachableError"],
    reason: "Error refinement: callers treat an unreachable provider as unavailable.",
  },
  {
    classes: ["ProviderUnavailableError", "ProviderDispatchPreparationError"],
    reason: "Error refinement: a dispatch that could not be prepared is an unavailable provider.",
  },
  {
    classes: ["ProviderUnavailableError", "AmbiguousPromptDispatchError"],
    reason: "Error refinement: an ambiguous dispatch is reported as provider unavailability.",
  },
  {
    classes: ["ProviderUnavailableError", "MissingProviderSessionError"],
    reason:
      "Error refinement: looped review's missing provider session is an unavailable provider.",
  },
  {
    classes: ["CommandFailedError", "GitRemoteTimeoutError"],
    reason: "Error refinement: a git remote timeout is a failed command with a timeout cause.",
  },
  {
    classes: ["AppServerUnavailableError", "AppServerOwnershipUnavailableError"],
    reason: "Error refinement: losing app-server ownership makes the app-server unavailable.",
  },
  {
    classes: ["DispatchJournalAdmissionError", "DispatchJournalCapacityError"],
    reason: "Error refinement: a full dispatch journal is one reason admission is refused.",
  },
  {
    classes: ["DispatchJournalAdmissionError", "DispatchJournalIntegrityError"],
    reason: "Error refinement: a corrupt dispatch journal is one reason admission is refused.",
  },
  {
    classes: ["BridgeRunDiagnostics", "CursorRunDiagnostics"],
    reason: "Shared bridge diagnostics base; Cursor overrides report() to add its own fields.",
  },
  {
    classes: ["SearchTextRenderer", "PeerMailSearchTextRenderer"],
    reason:
      "Marked renderer variant that overrides a few token handlers for peer-mail search text.",
  },
];

interface ClassDecl {
  file: string;
  name: string;
  /** The superclass as written, resolved below. `undefined` for a root. */
  superName?: string;
}

interface ParsedFile {
  classes: ClassDecl[];
  /** Local binding -> where it was imported from. */
  imports: Map<string, { imported: string; source: string }>;
}

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry) || entry.startsWith(".")) continue;
        walk(full);
        continue;
      }
      if (!/\.(?:m|c)?tsx?$/.test(entry)) continue;
      if (/\.(?:test|spec)\.tsx?$/.test(entry) || entry.endsWith(".d.ts")) continue;
      out.push(full);
    }
  };
  const start = join(repoRoot, root);
  if (existsSync(start)) walk(start);
  return out;
}

function forEachChild(node: Node, visit: (child: Node) => void): void {
  for (const key of visitorKeys[node.type] ?? []) {
    const value = (node as unknown as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      for (const child of value) if (child) visit(child as Node);
    } else if (value) {
      visit(value as Node);
    }
  }
}

function parseFile(file: string, source: string): ParsedFile {
  const { program, errors } = parseSync(file, source);
  // A file that does not parse must not pass the scan by yielding a partial tree.
  if (errors.length > 0) throw new Error(`${relative(repoRoot, file)}: ${errors[0]!.message}`);
  const classes: ClassDecl[] = [];
  const imports = new Map<string, { imported: string; source: string }>();
  const visit = (node: Node): void => {
    if (node.type === "ImportDeclaration") {
      for (const specifier of node.specifiers) {
        const imported =
          specifier.type === "ImportSpecifier"
            ? specifier.imported.type === "Identifier"
              ? specifier.imported.name
              : specifier.imported.value
            : specifier.type === "ImportDefaultSpecifier"
              ? "default"
              : "*";
        imports.set(specifier.local.name, { imported, source: node.source.value });
      }
      return;
    }
    if ((node.type === "ClassDeclaration" || node.type === "ClassExpression") && node.id) {
      const superClass = node.superClass;
      classes.push({
        file,
        name: node.id.name,
        // `extends React.Component` and other member expressions name an
        // external namespace; only bare identifiers can be project classes.
        superName: superClass?.type === "Identifier" ? superClass.name : undefined,
      });
    }
    forEachChild(node, visit);
  };
  visit(program);
  return { classes, imports };
}

function resolveRelative(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec).replace(/\.(?:m|c)?[jt]sx?$/, "");
  for (const candidate of [".ts", ".tsx", "/index.ts", "/index.tsx"]) {
    if (existsSync(base + candidate)) return base + candidate;
  }
  return null;
}

function key(decl: ClassDecl): string {
  return `${relative(repoRoot, decl.file)}#${decl.name}`;
}

/**
 * Every root-to-leaf path of project-class inheritance, base first. A class
 * with two subclasses yields two paths.
 */
function findChains(): { names: string[]; leafFile: string }[] {
  const parsed = new Map<string, ParsedFile>();
  for (const file of SCANNED_ROOTS.flatMap(sourceFiles)) {
    const source = readFileSync(file, "utf8");
    if (!/\bclass\b/.test(source)) continue;
    parsed.set(file, parseFile(file, source));
  }

  const byName = new Map<string, ClassDecl[]>();
  for (const { classes } of parsed.values()) {
    for (const decl of classes) byName.set(decl.name, [...(byName.get(decl.name) ?? []), decl]);
  }

  const resolveSuper = (decl: ClassDecl): ClassDecl | undefined => {
    if (!decl.superName) return undefined;
    const file = parsed.get(decl.file)!;
    const local = file.classes.find((other) => other.name === decl.superName);
    if (local) return local;
    // Not declared here and not imported: a global such as `Error` or `Map`.
    const binding = file.imports.get(decl.superName);
    if (!binding) return undefined;
    const isProjectImport =
      binding.source.startsWith(".") || binding.source.startsWith("@orkestrator/");
    if (!isProjectImport) return undefined;
    if (binding.source.startsWith(".")) {
      const target = resolveRelative(decl.file, binding.source);
      const direct = target
        ? parsed.get(target)?.classes.find((other) => other.name === binding.imported)
        : undefined;
      if (direct) return direct;
    }
    // Workspace package or barrel re-export: fall back to the unique declaration.
    const candidates = byName.get(binding.imported) ?? [];
    if (candidates.length > 1) {
      throw new Error(
        `${key(decl)} extends ${binding.imported}, which is declared in ${candidates.length} files; ` +
          "teach resolveSuper to follow this import",
      );
    }
    return candidates[0];
  };

  const parentOf = new Map<string, ClassDecl>();
  const hasChild = new Set<string>();
  const all = [...parsed.values()].flatMap((file) => file.classes);
  for (const decl of all) {
    const parent = resolveSuper(decl);
    if (!parent) continue;
    parentOf.set(key(decl), parent);
    hasChild.add(key(parent));
  }

  const chains: { names: string[]; leafFile: string }[] = [];
  for (const decl of all) {
    if (!parentOf.has(key(decl)) || hasChild.has(key(decl))) continue;
    const names = [decl.name];
    for (let current = parentOf.get(key(decl)); current; current = parentOf.get(key(current))) {
      names.unshift(current.name);
    }
    chains.push({ names, leafFile: relative(repoRoot, decl.file) });
  }
  return chains.sort((a, b) => a.names.join().localeCompare(b.names.join()));
}

const chainKey = (classes: readonly string[]) => classes.join(" -> ");

describe("project-class inheritance chains", () => {
  const found = findChains();
  const foundKeys = new Set(found.map((chain) => chainKey(chain.names)));
  const allowed = [...PINNED_CHAINS, ...INTENTIONAL_SUBCLASSES];

  test("no inheritance chain exists outside the recorded sets", () => {
    // Split a large class by responsibility into collaborators, not into
    // `extends` layers. See "Splitting large classes" in the root AGENTS.md.
    const allowedKeys = new Set(allowed.map((entry) => chainKey(entry.classes)));
    const introduced = found
      .filter((chain) => !allowedKeys.has(chainKey(chain.names)))
      .map((chain) => {
        const related = PINNED_CHAINS.find((entry) =>
          entry.classes.some((name) => chain.names.includes(name)),
        );
        const note = related ? ` (changed from pinned ${chainKey(related.classes)})` : "";
        return `${chainKey(chain.names)} in ${chain.leafFile}${note}`;
      });
    expect(introduced).toEqual([]);
  });

  test("every recorded chain still exists", () => {
    // A stale entry is as bad as a missing one: it lets the next chain hide
    // behind an allowance that no longer describes anything.
    const stale = allowed
      .map((entry) => chainKey(entry.classes))
      .filter((chain) => !foundKeys.has(chain));
    expect(stale).toEqual([]);
  });

  test("pinned chains are layered and intentional subclasses are one level", () => {
    for (const entry of PINNED_CHAINS) expect(entry.classes.length).toBeGreaterThan(2);
    for (const entry of INTENTIONAL_SUBCLASSES) expect(entry.classes.length).toBe(2);
  });

  test("every recorded chain carries a reason and pinned chains link their plan", () => {
    for (const entry of allowed) expect(entry.reason.length).toBeGreaterThan(40);
    for (const entry of PINNED_CHAINS) expect(existsSync(join(repoRoot, entry.plan))).toBe(true);
  });
});
