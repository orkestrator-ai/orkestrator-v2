import path from "node:path";
import { parseSync, visitorKeys, type Node } from "oxc-parser";
import type { SourceIndex } from "./repository-index";

/**
 * Project-class inheritance chains (the "Splitting large classes" rule in the
 * root AGENTS.md): split a large class by responsibility into collaborators,
 * not into `extends` layers. The repository check runs in the guard stage
 * (`mise run guards`); `tests/unit/inheritance-chains.test.ts` holds the
 * resolver fixtures.
 */

const SCANNED_ROOTS = ["apps", "bridges", "packages"];

/**
 * Generated code, build output and test support are not product classes. A
 * fake extending another fake in `testing/` is not the shape this check exists
 * to stop. Directories whose name starts with `.` are skipped too.
 */
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  "node_modules",
  "generated",
  "dist",
  "testing",
  "test",
  "tests",
  "__tests__",
]);

/**
 * Layered `extends` chains that predate this guard. Each one was a single class
 * that `refactor(core): split large modules` (#417) cut into files by size, held
 * together by `abstract` forward declarations, and each has since been taken
 * apart into collaborators. The list is empty and must stay empty; it is kept
 * so a chain a long-lived branch still carries fails here as new.
 *
 * Entries were pinned exactly, base first. A chain that gains a layer fails as
 * new; a chain that loses one fails as stale. The last entry, the
 * `StorageService` chain, went with todo 0009 (see
 * `docs/architecture/storage.md`, "Code layout"): the
 * service is now a facade over per-store repositories sharing one
 * `StorageContext`. A branch that still carries that entry drops it on rebase
 * rather than restoring it.
 */
export const PINNED_CHAINS: ReadonlyArray<{
  classes: readonly string[];
  plan: string;
  reason: string;
}> = [];

/**
 * Deliberate one-level inheritance between project classes: a specialised
 * error a caller can still catch as its parent, or a subclass that overrides
 * one hook of a reusable base. Anything here is `[base, subclass]`. Error
 * subclasses of the built-in `Error` are not listed - they are not
 * project-class inheritance.
 */
export const INTENTIONAL_SUBCLASSES: ReadonlyArray<{
  classes: readonly [string, string];
  reason: string;
}> = [
  {
    classes: ["RichRenderDeterministicError", "MermaidDeterministicError"],
    reason:
      "Error refinement: a Mermaid syntax failure is a deterministic render failure the scheduler caches.",
  },
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
  /** Repository-relative. */
  file: string;
  name: string;
  /** The superclass as written, resolved below. `undefined` for a root. */
  superName?: string;
}

interface ParsedFile {
  classes: ClassDecl[];
  /** Local binding -> where it was imported from. */
  imports: Map<string, { imported: string; source: string }>;
  exports: Map<string, { local: string } | { imported: string; source: string }>;
  exportAll: string[];
}

/** Product sources under the scanned roots, as the index lists them. */
function isProductSource(file: string): boolean {
  if (!SCANNED_ROOTS.some((root) => file.startsWith(`${root}/`))) return false;
  const segments = file.split("/");
  const name = segments.pop()!;
  if (segments.some((segment) => SKIPPED_DIRECTORIES.has(segment) || segment.startsWith(".")))
    return false;
  if (!/\.(?:m|c)?tsx?$/.test(name)) return false;
  return !/\.(?:test|spec)\.tsx?$/.test(name) && !name.endsWith(".d.ts");
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
  if (errors.length > 0) throw new Error(`${file}: ${errors[0]!.message}`);
  const classes: ClassDecl[] = [];
  const imports = new Map<string, { imported: string; source: string }>();
  const exports: ParsedFile["exports"] = new Map();
  const exportAll: string[] = [];
  const visit = (node: Node): void => {
    if (node.type === "ExportNamedDeclaration") {
      if (node.declaration?.type === "ClassDeclaration" && node.declaration.id) {
        exports.set(node.declaration.id.name, { local: node.declaration.id.name });
      }
      for (const specifier of node.specifiers) {
        const exported =
          specifier.exported.type === "Identifier"
            ? specifier.exported.name
            : specifier.exported.value;
        const local =
          specifier.local.type === "Identifier" ? specifier.local.name : specifier.local.value;
        exports.set(
          exported,
          node.source ? { imported: local, source: node.source.value } : { local },
        );
      }
    }
    if (node.type === "ExportAllDeclaration" && !node.exported) {
      exportAll.push(node.source.value);
    }
    if (node.type === "ExportDefaultDeclaration") {
      const declaration = node.declaration;
      if (declaration.type === "Identifier") {
        exports.set("default", { local: declaration.name });
      } else if (declaration.type === "ClassDeclaration") {
        exports.set("default", { local: declaration.id?.name ?? "default" });
        if (!declaration.id) {
          classes.push({
            file,
            name: "default",
            superName:
              declaration.superClass?.type === "Identifier"
                ? declaration.superClass.name
                : undefined,
          });
        }
      }
    }
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
  return { classes, imports, exports, exportAll };
}

function resolveModule(fromFile: string, spec: string, exists: (file: string) => boolean) {
  const basePath = spec.startsWith(".")
    ? path.posix.join(path.posix.dirname(fromFile), spec)
    : spec.startsWith("@/") && fromFile.startsWith("apps/web/")
      ? `apps/web/src/${spec.slice(2)}`
      : null;
  if (!basePath) return null;
  const base = basePath.replace(/\.(?:m|c)?[jt]sx?$/, "");
  for (const candidate of [".ts", ".tsx", "/index.ts", "/index.tsx"]) {
    if (exists(base + candidate)) return base + candidate;
  }
  return null;
}

function key(decl: ClassDecl): string {
  return `${decl.file}#${decl.name}`;
}

export interface InheritanceChain {
  /** Base first. */
  names: string[];
  /** Repository-relative file of the last class. */
  leafFile: string;
}

/**
 * Every root-to-leaf path of project-class inheritance, base first. A class
 * with two subclasses yields two paths.
 *
 * Only files that contain the word `class` can declare one, so only those are
 * parsed up front; a barrel on a superclass's export path is parsed when an
 * import resolves through it.
 */
export function findChains(index: SourceIndex): InheritanceChain[] {
  const sources = new Set(index.files.filter(isProductSource));
  const parsed = new Map<string, ParsedFile | undefined>();
  const listed = new Set(index.files);
  const exists = (file: string) => listed.has(file) && index.read(file) !== null;
  const parsedFile = (file: string): ParsedFile | undefined => {
    if (parsed.has(file)) return parsed.get(file);
    const source = sources.has(file) ? index.read(file) : null;
    // Barrels without classes still carry the superclass's export path.
    const result =
      source !== null && /\b(?:class|export)\b/.test(source) ? parseFile(file, source) : undefined;
    parsed.set(file, result);
    return result;
  };
  const all: ClassDecl[] = [];
  for (const file of sources) {
    const source = index.read(file);
    if (source === null || !/\bclass\b/.test(source)) continue;
    all.push(...(parsedFile(file)?.classes ?? []));
  }

  const byName = new Map<string, ClassDecl[]>();
  for (const decl of all) byName.set(decl.name, [...(byName.get(decl.name) ?? []), decl]);

  const resolveExport = (
    target: string,
    name: string,
    seen = new Set<string>(),
  ): ClassDecl | undefined => {
    const exportKey = `${target}#${name}`;
    if (seen.has(exportKey)) return undefined;
    seen.add(exportKey);
    const file = parsedFile(target);
    if (!file) return undefined;
    const binding = file.exports.get(name);
    if (binding) {
      if ("local" in binding) {
        const local = file.classes.find((decl) => decl.name === binding.local);
        if (local) return local;
        const imported = file.imports.get(binding.local);
        const source = imported && resolveModule(target, imported.source, exists);
        return source && imported ? resolveExport(source, imported.imported, seen) : undefined;
      }
      const source = resolveModule(target, binding.source, exists);
      return source ? resolveExport(source, binding.imported, seen) : undefined;
    }
    if (name !== "default") {
      for (const spec of file.exportAll) {
        const source = resolveModule(target, spec, exists);
        const declaration = source ? resolveExport(source, name, seen) : undefined;
        if (declaration) return declaration;
      }
    }
    return undefined;
  };

  const resolveSuper = (decl: ClassDecl): ClassDecl | undefined => {
    if (!decl.superName) return undefined;
    const file = parsedFile(decl.file)!;
    const local = file.classes.find((other) => other.name === decl.superName);
    if (local) return local;
    // Not declared here and not imported: a global such as `Error` or `Map`.
    const binding = file.imports.get(decl.superName);
    if (!binding) return undefined;
    const target = resolveModule(decl.file, binding.source, exists);
    if (target) return resolveExport(target, binding.imported);
    if (!binding.source.startsWith("@orkestrator/")) return undefined;
    // Workspace package exports: fall back to the unique declaration.
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
  for (const decl of all) {
    const parent = resolveSuper(decl);
    if (!parent) continue;
    parentOf.set(key(decl), parent);
    hasChild.add(key(parent));
  }

  const chains: InheritanceChain[] = [];
  for (const decl of all) {
    if (!parentOf.has(key(decl)) || hasChild.has(key(decl))) continue;
    const names = [decl.name];
    for (let current = parentOf.get(key(decl)); current; current = parentOf.get(key(current))) {
      names.unshift(current.name);
    }
    chains.push({ names, leafFile: decl.file });
  }
  return chains.sort((a, b) => a.names.join().localeCompare(b.names.join()));
}

export const chainKey = (classes: readonly string[]) => classes.join(" -> ");

/** What the repository's chains break: chains outside the recorded sets, and stale entries. */
export function checkInheritanceChains(found: readonly InheritanceChain[]): string[] {
  const allowed = [...PINNED_CHAINS, ...INTENTIONAL_SUBCLASSES];
  const allowedKeys = new Set(allowed.map((entry) => chainKey(entry.classes)));
  const foundKeys = new Set(found.map((chain) => chainKey(chain.names)));
  const introduced = found
    .filter((chain) => !allowedKeys.has(chainKey(chain.names)))
    .map((chain) => {
      const related = PINNED_CHAINS.find((entry) =>
        entry.classes.some((name) => chain.names.includes(name)),
      );
      const note = related ? ` (changed from pinned ${chainKey(related.classes)})` : "";
      return `new chain: ${chainKey(chain.names)} in ${chain.leafFile}${note}`;
    });
  // A stale entry is as bad as a missing one: it lets the next chain hide
  // behind an allowance that no longer describes anything.
  const stale = allowed
    .map((entry) => chainKey(entry.classes))
    .filter((chain) => !foundKeys.has(chain))
    .map((chain) => `recorded chain no longer exists: ${chain}`);
  return [...introduced, ...stale];
}
