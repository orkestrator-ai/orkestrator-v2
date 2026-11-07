import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { isTypeOnlyImport, unwrap, type AnyNode } from "./ast";

/**
 * Renderer module resolution for the production-source guards: which
 * repository module an import in `apps/web/src` names, and what the import
 * declarations of a file are.
 *
 * A module id is the repository-relative path without its extension or a
 * trailing `/index`, so `@/stores`, `@/stores/index`, `./stores` (from
 * `apps/web/src/App.tsx`) and the file `apps/web/src/stores/index.ts` are all
 * `apps/web/src/stores`.
 */

export const WEB_SOURCE_ROOT = "apps/web/src";

const SCRIPT_EXTENSION = /\.[cm]?[jt]sx?$/;

function normalizeModuleId(target: string): string {
  const withoutExtension = target.replace(SCRIPT_EXTENSION, "");
  return withoutExtension.endsWith("/index")
    ? withoutExtension.slice(0, -"/index".length)
    : withoutExtension;
}

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

/** The module id of a repository-relative source file. */
export function moduleIdOfFile(file: string): string {
  return normalizeModuleId(file);
}

/**
 * The module id `specifier` names when imported from `fromFile`, or `null`
 * for a package import. `@/` is the renderer's alias for `apps/web/src/`.
 */
export function resolveWebModule(fromFile: string, specifier: string): string | null {
  if (specifier.startsWith("@/"))
    return normalizeModuleId(`${WEB_SOURCE_ROOT}/${specifier.slice(2)}`);
  if (specifier === "." || specifier === ".." || /^\.\.?\//.test(specifier)) {
    return normalizeModuleId(
      path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier)),
    );
  }
  return null;
}

export interface ModuleSpecifier {
  /** The exported name read from the other module (`default`, or `*` for a namespace). */
  imported: string;
  /** The local binding (an import) or the exported name (a re-export). */
  local: string;
  typeOnly: boolean;
}

export interface ModuleReference {
  kind: "import" | "export-from" | "export-all" | "dynamic";
  specifier: string;
  /** The whole statement is type-only (`import type`, `export type … from`). */
  typeOnly: boolean;
  specifiers: ModuleSpecifier[];
  start: number;
}

function specifierName(node: AnyNode | null | undefined): string {
  if (!node) return "default";
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal") return String(node.value);
  return "default";
}

/** `import { type X }`: oxc's specifier span starts at the `type` keyword. */
function specifierIsTypeOnly(node: AnyNode, source: string): boolean {
  return (
    node.importKind === "type" ||
    node.exportKind === "type" ||
    /^type\s/.test(source.slice(node.start, node.end)) ||
    isTypeOnlyImport(node, source)
  );
}

function statementIsTypeOnly(node: AnyNode, source: string, keyword: "import" | "export"): boolean {
  if (node.importKind === "type" || node.exportKind === "type") return true;
  if (keyword === "import") return isTypeOnlyImport(node, source);
  return /^export\s+type\b/.test(source.slice(node.start, node.end));
}

/** The import and re-export statements of a module, plus `import("…")` with a literal. */
export function moduleReferences(program: AnyNode, source: string): ModuleReference[] {
  const references: ModuleReference[] = [];
  for (const statement of program.body ?? []) {
    if (statement.type === "ImportDeclaration") {
      references.push({
        kind: "import",
        specifier: statement.source.value,
        typeOnly: statementIsTypeOnly(statement, source, "import"),
        specifiers: (statement.specifiers ?? []).map((specifier: AnyNode) => ({
          imported:
            specifier.type === "ImportNamespaceSpecifier"
              ? "*"
              : specifier.type === "ImportDefaultSpecifier"
                ? "default"
                : specifierName(specifier.imported),
          local: specifier.local.name,
          typeOnly: specifierIsTypeOnly(specifier, source),
        })),
        start: statement.start,
      });
    } else if (statement.type === "ExportNamedDeclaration" && statement.source) {
      references.push({
        kind: "export-from",
        specifier: statement.source.value,
        typeOnly: statementIsTypeOnly(statement, source, "export"),
        specifiers: (statement.specifiers ?? []).map((specifier: AnyNode) => ({
          imported: specifierName(specifier.local),
          local: specifierName(specifier.exported),
          typeOnly: specifierIsTypeOnly(specifier, source),
        })),
        start: statement.start,
      });
    } else if (statement.type === "ExportAllDeclaration") {
      references.push({
        kind: "export-all",
        specifier: statement.source.value,
        typeOnly: statementIsTypeOnly(statement, source, "export"),
        specifiers: statement.exported
          ? [{ imported: "*", local: specifierName(statement.exported), typeOnly: false }]
          : [],
        start: statement.start,
      });
    }
  }
  return references;
}

/** `import("…")` calls whose argument is a string literal, anywhere in the file. */
export function dynamicImportOf(node: AnyNode): ModuleReference | null {
  if (node.type !== "ImportExpression") return null;
  const argument = unwrap(node.source);
  if (argument.type !== "Literal" || typeof argument.value !== "string") return null;
  return {
    kind: "dynamic",
    specifier: argument.value,
    typeOnly: false,
    specifiers: [],
    start: node.start,
  };
}

/**
 * Whether a reference brings in a runtime value: not `import type`, and not
 * an import whose every named specifier is `type`. A side-effect import
 * (`import "x"`) runs the module, so it counts.
 */
export function bringsValues(reference: ModuleReference): boolean {
  if (reference.typeOnly) return false;
  if (reference.specifiers.length === 0) return true;
  return reference.specifiers.some((specifier) => !specifier.typeOnly);
}
