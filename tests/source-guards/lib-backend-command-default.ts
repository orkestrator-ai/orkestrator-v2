import path from "node:path";
import { parseSync } from "oxc-parser";
import { memberName, unwrap, walk, type AnyNode } from "./ast";
import type { GuardVisitor, ScannedFile, SourceGuard, SubjectFinding } from "./guard";
import { isTestSource } from "./paths";
import {
  WEB_SOURCE_ROOT,
  moduleReferences,
  repositoryModules,
  resolveWebModule,
  type ReadModule,
} from "./web-modules";

/**
 * Uses of a `lib/backend` command-bound named export inside a converted
 * store's or service's module (plan item 3002, report §7.4).
 *
 * Every `lib/backend/<x>.ts` exports `createXApi(client)` and keeps its named
 * exports as that factory over the window's command scope:
 * `export const { getX, … } = createXApi(commandBackendClient)`. In a module
 * that holds per-node state (it defines a scoped store, service or slot), a
 * named export is code that has not said which node it means, so it silently
 * reaches the command node. The count is per `lib/backend` file and per
 * module, and it only falls.
 *
 * The shim names are read from the `lib/backend` sources (an exported `const`
 * whose initializer is a call taking `commandBackendClient` or
 * `portalBackendClient`), and an import is followed through the `@/lib/backend`
 * barrel or any other re-export to the file that binds it. A factory, a type
 * or a helper that sends nothing is not counted, nor is the command-scope
 * fallback handed to `backendApiForScope`. Test files, test-support modules
 * and `src/test/**` are not counted.
 */

export const LIB_BACKEND_ROOTS = [WEB_SOURCE_ROOT] as const;

/** Module id prefix of the `lib/backend` files (the barrel is `lib/backend` itself). */
export const LIB_BACKEND_PREFIX = `${WEB_SOURCE_ROOT}/lib/backend/`;

/** The clients whose bindings are the shim. */
const SHIM_CLIENTS: ReadonlySet<string> = new Set(["commandBackendClient", "portalBackendClient"]);

/** A module that defines per-node state: a converted store, service or slot. */
const CONVERTED_MODULE = /\bdefineScoped(?:Store|Service|Slot)\s*(?:<|\()/;

/** Where defining scoped state is the point, or where the shim itself lives. */
const EXEMPT_PREFIXES = [
  `${WEB_SOURCE_ROOT}/test/`,
  `${WEB_SOURCE_ROOT}/lib/node-scope/`,
  `${WEB_SOURCE_ROOT}/lib/backend/`,
] as const;

const EXEMPT_FILES: ReadonlySet<string> = new Set([
  // Defines `defineScopedSlot` itself.
  `${WEB_SOURCE_ROOT}/lib/node-scope-slots.ts`,
  `${WEB_SOURCE_ROOT}/lib/backend.ts`,
]);

interface ModuleExports {
  /** The command-bound names this module binds itself. */
  shims: Set<string>;
  /** Exported name → the module and name it re-exports. */
  named: Map<string, { module: string; imported: string }>;
  star: string[];
}

/** A call's arguments include one of the shim clients. */
function takesShimClient(init: AnyNode | null | undefined): boolean {
  const call = init ? unwrap(init) : null;
  if (call?.type !== "CallExpression") return false;
  return (call.arguments ?? []).some(
    (argument: AnyNode) => argument.type === "Identifier" && SHIM_CLIENTS.has(argument.name),
  );
}

function boundNames(id: AnyNode): string[] {
  if (id.type === "Identifier") return [id.name];
  if (id.type !== "ObjectPattern") return [];
  const names: string[] = [];
  for (const property of id.properties ?? []) {
    const value = property.type === "Property" ? unwrap(property.value) : null;
    if (value?.type === "Identifier") names.push(value.name);
  }
  return names;
}

function exportsOf(file: string, source: string): ModuleExports {
  const { program } = parseSync(file, source, { preserveParens: false, astType: "js" });
  const root = program as unknown as AnyNode;
  const shims = new Set<string>();
  const named = new Map<string, { module: string; imported: string }>();
  const star: string[] = [];
  for (const statement of root.body ?? []) {
    const declaration = statement.type === "ExportNamedDeclaration" ? statement.declaration : null;
    if (declaration?.type !== "VariableDeclaration") continue;
    for (const declarator of declaration.declarations ?? [])
      if (takesShimClient(declarator.init))
        for (const name of boundNames(declarator.id)) shims.add(name);
  }
  for (const reference of moduleReferences(root, source)) {
    if (reference.typeOnly) continue;
    const module = resolveWebModule(file, reference.specifier);
    if (!module) continue;
    if (reference.kind === "export-all" && reference.specifiers.length === 0) star.push(module);
    if (reference.kind !== "export-from") continue;
    for (const specifier of reference.specifiers)
      if (!specifier.typeOnly) named.set(specifier.local, { module, imported: specifier.imported });
  }
  return { shims, named, star };
}

/** The subject of a `lib/backend` file's shim: its base name; other modules have none. */
export function libBackendSubject(moduleId: string): string | null {
  return moduleId.startsWith(LIB_BACKEND_PREFIX) ? moduleId.slice(LIB_BACKEND_PREFIX.length) : null;
}

/** Follows an exported name to the `lib/backend` file whose shim binds it. */
export class LibBackendShimResolver {
  private readonly cache = new Map<string, { source: string; exports: ModuleExports }>();

  /**
   * `subjectOf` names the module whose shim binds a name (`null`: not
   * counted). The default counts the `lib/backend` files only; the
   * workspace guard (plan item 4007) also counts other renderer modules'
   * command-bound exports.
   */
  constructor(
    private readonly readModule: ReadModule,
    private readonly subjectOf: (moduleId: string) => string | null = libBackendSubject,
  ) {}

  /** The `lib/backend` file (its base name) whose shim `exported` is, or `null`. */
  shimOf(moduleId: string, exported: string, seen: Set<string> = new Set()): string | null {
    const key = `${moduleId}#${exported}`;
    if (seen.has(key) || seen.size > 32) return null;
    seen.add(key);
    const exports = this.exports(moduleId);
    if (!exports) return null;
    if (exports.shims.has(exported)) return this.subjectOf(moduleId);
    const named = exports.named.get(exported);
    if (named) return this.shimOf(named.module, named.imported, seen);
    for (const target of exports.star) {
      const found = this.shimOf(target, exported, seen);
      if (found) return found;
    }
    return null;
  }

  private exports(moduleId: string): ModuleExports | null {
    const found = this.readModule(moduleId);
    if (found === null) return null;
    const cached = this.cache.get(moduleId);
    if (cached && cached.source === found.source) return cached.exports;
    const exports = exportsOf(found.file, found.source);
    this.cache.set(moduleId, { source: found.source, exports });
    return exports;
  }
}

/** Imports, and type positions (`typeof getX` sends nothing). */
const SKIPPED_SUBTREES: ReadonlySet<string> = new Set([
  "ImportDeclaration",
  "TSTypeAnnotation",
  "TSTypeAliasDeclaration",
  "TSInterfaceDeclaration",
  "TSTypeParameterInstantiation",
  "TSTypeQuery",
]);

/**
 * `backendApiForScope(scope, createXApi, { getX })`: the named export is the
 * command scope's answer, chosen only when `scope` is the command scope, so
 * it says which node it means.
 */
function insideScopedFallback(node: AnyNode, ancestors: readonly AnyNode[]): boolean {
  for (const ancestor of ancestors) {
    if (ancestor.type !== "CallExpression") continue;
    const callee = unwrap(ancestor.callee);
    const fallback = ancestor.arguments?.[2];
    if (
      callee.type === "Identifier" &&
      callee.name === "backendApiForScope" &&
      fallback &&
      node.start >= fallback.start &&
      node.end <= fallback.end
    )
      return true;
  }
  return false;
}

type Binding =
  { kind: "named"; module: string; imported: string } | { kind: "namespace"; module: string };

/** An identifier in a position that names no binding (a member or key name). */
function isNameOnly(node: AnyNode, parent: AnyNode | undefined): boolean {
  if (!parent) return false;
  if (parent.type === "MemberExpression") return parent.property === node && !parent.computed;
  // A shorthand property's value is its own node, so its key never counts.
  if (parent.type === "Property") return parent.key === node && !parent.computed;
  if (
    parent.type === "MethodDefinition" ||
    parent.type === "PropertyDefinition" ||
    parent.type === "AccessorProperty"
  )
    return parent.key === node && !parent.computed;
  return false;
}

export function visitShimUses(
  program: AnyNode,
  file: ScannedFile,
  resolver: LibBackendShimResolver,
  /** A command-bound name that is right where it is (the workspace guard's window-level calls). */
  allowed: (subject: string, name: string) => boolean = () => false,
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
  const findings: SubjectFinding[] = [];
  if (bindings.size === 0) return { handlers: {}, finish: () => findings };
  walk(program, (node, ancestors) => {
    const parent = ancestors[ancestors.length - 1];
    if (ancestors.some((ancestor) => SKIPPED_SUBTREES.has(ancestor.type))) return;
    if (insideScopedFallback(node, ancestors)) return;
    if (node.type === "Identifier" && !isNameOnly(node, parent)) {
      const binding = bindings.get(node.name);
      if (binding?.kind !== "named") return;
      const subject = resolver.shimOf(binding.module, binding.imported);
      if (subject && !allowed(subject, binding.imported))
        findings.push({ offset: node.start, subject });
      return;
    }
    if (node.type === "MemberExpression" && !node.computed) {
      const namespace = unwrap(node.object);
      const name = memberName(node);
      if (namespace.type !== "Identifier" || !name) return;
      const binding = bindings.get(namespace.name);
      if (binding?.kind !== "namespace") return;
      const subject = resolver.shimOf(binding.module, name);
      if (subject && !allowed(subject, name)) findings.push({ offset: node.start, subject });
    }
  });
  return { handlers: {}, finish: () => findings };
}

export function appliesToConvertedModule(file: Pick<ScannedFile, "path">): boolean {
  return (
    LIB_BACKEND_ROOTS.some((root) => file.path.startsWith(`${root}/`)) &&
    !EXEMPT_PREFIXES.some((prefix) => file.path.startsWith(prefix)) &&
    !EXEMPT_FILES.has(file.path) &&
    !isTestSource(file.path)
  );
}

export interface LibBackendCommandDefaultOptions {
  readModule?: ReadModule;
}

export function createLibBackendCommandDefaultGuard(
  options: LibBackendCommandDefaultOptions = {},
): SourceGuard {
  const readModule =
    options.readModule ?? repositoryModules(path.resolve(import.meta.dir, "../.."));
  return {
    id: "lib-backend-command-default",
    advice:
      "A lib/backend named export is the command-scope shim: it does not say which node it " +
      "means. In a scoped store or service, build the file's functions for the scope's node: " +
      "createXApi(scope.client), or scopeBackendClient(scope) / backendApiForScope from " +
      "@/lib/backend/client to keep the scope's prefetched cache. See " +
      "docs/development/node-scopes.md.",
    productionRoots: LIB_BACKEND_ROOTS,
    appliesTo: appliesToConvertedModule,
    mayOffend: (source) => CONVERTED_MODULE.test(source),
    visit: (() => {
      const resolver = new LibBackendShimResolver(readModule);
      return (program: AnyNode, file: ScannedFile) => visitShimUses(program, file, resolver);
    })(),
  };
}

export const libBackendCommandDefault: SourceGuard = createLibBackendCommandDefaultGuard();
