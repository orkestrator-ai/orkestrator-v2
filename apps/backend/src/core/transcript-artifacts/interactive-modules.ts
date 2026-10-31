/**
 * ES-module support for interactive artifacts.
 *
 * An inline `<script type="module">` may `import` only pinned manifest
 * dependencies by bare specifier (`import * as d3 from "d3"`,
 * `import { Chart } from "chart.js"`), and only dependencies the artifact
 * declares in `dependencyIds`. Each module script is bundled on its own with
 * `Bun.build` under one fixed, application-owned configuration
 * (`MODULE_BUNDLER_CONFIG`) and a resolver plugin that:
 *
 * - resolves the entry to the authored text (held in memory; nothing is read
 *   from or written to disk);
 * - resolves a declared dependency's specifier to that dependency's
 *   application-owned `moduleShim`, which re-exports the global defined by the
 *   pinned bundle the preparer injects verbatim as a classic script;
 * - rejects every other specifier (relative, absolute, URL, `node:`, `bun:`,
 *   `require`, dynamic `import()`) with `unresolved_import`.
 *
 * Compilation parses and prints; it never evaluates authored code. The only
 * bundler feature that runs code at build time is Bun macros (`import … with
 * { type: "macro" }`), which resolve from disk and bypass plugins; they are
 * disabled with `macros: false` and that is verified once per process before
 * any authored source is bundled (fail closed). Plugin callbacks only return
 * strings. `env: "disable"` and a fixed `define` keep backend environment
 * variables out of the output.
 *
 * Output is deterministic for identical input under one Bun version; prepared
 * documents are stored, never recomputed, so an upgrade only affects new
 * preparations (`moduleBundlerIdentity()` records which bundler produced them).
 */
import type { ArtifactDependency } from "./dependency-manifest.js";
import { ARTIFACT_DEPENDENCY_MANIFEST } from "./dependency-manifest.js";

export const MODULE_BUNDLER_VERSION = "artifact-module-bundler:v1";
/** Module scripts bundled per document; bounds bundler work per preparation. */
export const MAX_MODULE_SCRIPTS = 16;

const ENTRY_SPECIFIER = "orkestrator-artifact-module:inline-module.js";
const ENTRY_NAMESPACE = "artifact-module";
const ENTRY_PATH = "inline-module.js";
const DEPENDENCY_NAMESPACE = "artifact-dependency";
const REJECTED = "Rejected import: ";

/**
 * The fixed bundler configuration. Nothing here is derived from authored
 * content or metadata; the resolver plugin is the only plugin.
 */
export const MODULE_BUNDLER_CONFIG = Object.freeze({
  target: "browser",
  format: "esm",
  minify: false,
  sourcemap: "none",
  splitting: false,
  packages: "bundle",
  external: [] as string[],
  // Fail on non-literal `import()`/`require()` instead of leaving them to runtime.
  allowUnresolved: [] as string[],
  // Never inline backend environment variables; pin the one define Bun adds.
  env: "disable",
  define: { "process.env.NODE_ENV": '"production"' },
  conditions: [] as string[],
  bytecode: false,
  // Undocumented in bun-types but honoured by Bun.build ("Macros are disabled").
  macros: false,
  throw: false,
} as const);

export function moduleBundlerIdentity(): string {
  return `${MODULE_BUNDLER_VERSION} bun@${Bun.version}`;
}

/** Every importable specifier and the manifest entry it belongs to. */
export function moduleSpecifierTable(): ReadonlyMap<string, ArtifactDependency> {
  const table = new Map<string, ArtifactDependency>();
  for (const dependency of ARTIFACT_DEPENDENCY_MANIFEST)
    for (const specifier of dependency.moduleSpecifiers) table.set(specifier, dependency);
  return table;
}

export interface ModuleImportProblem {
  code: "unresolved_import" | "undeclared_dependency";
  message: string;
  suggestion: string;
}

const SPECIFIER_HINT = () =>
  `Import only pinned dependencies by bare specifier (${Array.from(moduleSpecifierTable().keys())
    .map((specifier) => `"${specifier}"`)
    .join(", ")}) and inline everything else in the module script`;

function describeSpecifier(path: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path) || path.startsWith("//")) return "a URL import";
  if (/^(node|bun):/i.test(path)) return "a runtime built-in";
  if (path.startsWith(".") || path.startsWith("/")) return "a file path";
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return "a URL import";
  return "not in the pinned manifest";
}

/**
 * Checks the imports `Bun.Transpiler.scanImports` found in one module script
 * against the manifest and the declared dependency list.
 */
export function checkModuleImports(
  imports: ReadonlyArray<{ kind: string; path: string }>,
  declared: readonly ArtifactDependency[],
): ModuleImportProblem[] {
  const table = moduleSpecifierTable();
  const problems: ModuleImportProblem[] = [];
  for (const entry of imports) {
    const shown = entry.path.slice(0, 80);
    if (entry.kind === "dynamic-import") {
      problems.push({
        code: "unresolved_import",
        message: `Dynamic import() of "${shown}" cannot be resolved offline`,
        suggestion: "Use a static import declaration at the top of the module script",
      });
      continue;
    }
    if (entry.kind !== "import-statement") {
      problems.push({
        code: "unresolved_import",
        message: `${entry.kind} of "${shown}" cannot be resolved offline`,
        suggestion: "Use a static import declaration of a pinned dependency",
      });
      continue;
    }
    const dependency = table.get(entry.path);
    if (!dependency) {
      problems.push({
        code: "unresolved_import",
        message: `Import of "${shown}" cannot be resolved offline (${describeSpecifier(entry.path)})`,
        suggestion: SPECIFIER_HINT(),
      });
    } else if (!declared.includes(dependency)) {
      problems.push({
        code: "undeclared_dependency",
        message: `Import of "${shown}" needs the dependency ${dependency.id}`,
        suggestion: `Add "${dependency.id}" to dependencyIds`,
      });
    }
  }
  return problems;
}

export interface ModuleBundleDiagnostic {
  code: "unresolved_import" | "module_bundle_failed";
  message: string;
  line?: number;
  column?: number;
}

export type ModuleBundleResult =
  { ok: true; code: string } | { ok: false; diagnostics: ModuleBundleDiagnostic[] };

export class ModuleBundlerUnavailableError extends Error {
  constructor(reason: string) {
    super(`The module bundler is unavailable: ${reason}`);
    this.name = "ModuleBundlerUnavailableError";
  }
}

type BuildLog = { message?: string; level?: string; position?: { line?: number; column?: number } };

function runBuild(source: string, declared: readonly ArtifactDependency[]) {
  const declaredBySpecifier = new Map<string, ArtifactDependency>();
  for (const dependency of declared)
    for (const specifier of dependency.moduleSpecifiers)
      declaredBySpecifier.set(specifier, dependency);
  const plugin: Bun.BunPlugin = {
    name: "orkestrator-artifact-module-resolver",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === "entry-point-build" && args.path === ENTRY_SPECIFIER)
          return { path: ENTRY_PATH, namespace: ENTRY_NAMESPACE };
        const dependency =
          args.kind === "import-statement" && args.importer === ENTRY_PATH
            ? declaredBySpecifier.get(args.path)
            : undefined;
        if (dependency) return { path: dependency.id, namespace: DEPENDENCY_NAMESPACE };
        throw new Error(`${REJECTED}${args.kind} of "${args.path.slice(0, 80)}"`);
      });
      build.onLoad({ filter: /.*/, namespace: ENTRY_NAMESPACE }, () => ({
        contents: source,
        loader: "js",
      }));
      build.onLoad({ filter: /.*/, namespace: DEPENDENCY_NAMESPACE }, (args) => {
        const dependency = declared.find((entry) => entry.id === args.path);
        if (!dependency) throw new Error(`${REJECTED}${args.path.slice(0, 80)}`);
        return { contents: dependency.moduleShim, loader: "js" };
      });
      // Nothing resolves to disk; refuse it outright if anything ever tried.
      build.onLoad({ filter: /.*/, namespace: "file" }, (args) => {
        throw new Error(`${REJECTED}${args.path.slice(0, 80)}`);
      });
    },
  };
  return Bun.build({
    ...MODULE_BUNDLER_CONFIG,
    external: [],
    allowUnresolved: [],
    conditions: [],
    define: { ...MODULE_BUNDLER_CONFIG.define },
    entrypoints: [ENTRY_SPECIFIER],
    plugins: [plugin],
  } as Bun.BuildConfig);
}

/** Process-wide on purpose: a fact about this Bun (docs/architecture/backend-runtime.md). */
let macroCheck: Promise<void> | null = null;

/**
 * Proves, once per process, that this Bun honours `macros: false`: a macro
 * import must fail with "Macros are disabled" (the probe names no real module,
 * so nothing could run even if it were not). Any other outcome makes module
 * bundling unavailable rather than risk build-time code execution.
 */
export function verifyMacrosDisabled(): Promise<void> {
  macroCheck ??= (async () => {
    const result = await runBuild(
      'import { probe } from "orkestrator-macro-probe" with { type: "macro" };\nprobe();\n',
      [],
    );
    const messages = (result.logs as BuildLog[]).map((log) => String(log.message ?? log));
    if (result.success || !messages.some((message) => /macros are disabled/i.test(message)))
      throw new ModuleBundlerUnavailableError("macros could not be disabled");
  })();
  macroCheck.catch(() => {
    macroCheck = null;
  });
  return macroCheck;
}

/**
 * Bundles one module script. The caller has already parsed it and checked its
 * imports with `checkModuleImports`; the plugin enforces the same rules again.
 */
export async function bundleModuleScript(
  source: string,
  declared: readonly ArtifactDependency[],
): Promise<ModuleBundleResult> {
  await verifyMacrosDisabled();
  let result: Awaited<ReturnType<typeof runBuild>>;
  try {
    result = await runBuild(source, declared);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      diagnostics: [{ code: "module_bundle_failed", message: message.slice(0, 300) }],
    };
  }
  if (!result.success) {
    const diagnostics = (result.logs as BuildLog[])
      .filter((log) => log.level === undefined || log.level === "error")
      .slice(0, 8)
      .map((log): ModuleBundleDiagnostic => {
        const raw = String(log.message ?? log);
        const line = log.position?.line || undefined;
        const column = log.position?.column;
        const position = line ? { line, ...(column !== undefined ? { column } : {}) } : {};
        if (raw.includes(REJECTED))
          return {
            code: "unresolved_import",
            message: `${raw.slice(raw.indexOf(REJECTED) + REJECTED.length).slice(0, 200)} cannot be resolved offline`,
            ...position,
          };
        if (/macros are disabled/i.test(raw))
          return {
            code: "unresolved_import",
            message: "Macro imports are not allowed",
            ...position,
          };
        if (/not a string literal|will not be bundled/i.test(raw))
          return {
            code: "unresolved_import",
            message:
              "Dynamic import()/require() with a computed specifier cannot be resolved offline",
            ...position,
          };
        return { code: "module_bundle_failed", message: raw.slice(0, 300), ...position };
      });
    return {
      ok: false,
      diagnostics: diagnostics.length
        ? diagnostics
        : [{ code: "module_bundle_failed", message: "The module script could not be bundled" }],
    };
  }
  const outputs = result.outputs.filter((output) => output.kind === "entry-point");
  if (outputs.length !== 1 || result.outputs.length !== 1)
    return {
      ok: false,
      diagnostics: [
        { code: "module_bundle_failed", message: "Bundling produced unexpected output files" },
      ],
    };
  return { ok: true, code: await outputs[0]!.text() };
}
