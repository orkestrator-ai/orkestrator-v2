/**
 * The backend's and the web's model files take their shared types from the
 * protocol (plan item 7010, report §11.2 "Definitions").
 *
 * `apps/backend/src/core/models.ts` and `apps/web/src/types/index.ts` (with
 * the modules it re-exports) each export model types. A name both export
 * must be the same protocol type: both files re-export the same symbol of the
 * same `@orkestrator/protocol` module (directly, through an import, or as an
 * alias `export type X = Y` of one). Re-exporting one symbol makes the two
 * types identical by construction, which no structural comparison could
 * promise. Two lists name the exceptions:
 *
 * - {@link HOMONYMS}: names that deliberately mean different records on the
 *   two sides (each side's meaning stated). The test checks both still
 *   collide, so a resolved homonym leaves the list.
 * - {@link PENDING}: shared names whose protocol schema is not yet the
 *   model's definition, with the item that converges them. A pending name
 *   that has converged (or no longer collides) fails the test until it is
 *   removed, so the list only shrinks. 7010's "Done when" is this list empty.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const BACKEND_MODELS = "apps/backend/src/core/models.ts";
const WEB_TYPES = "apps/web/src/types/index.ts";

/** Where an exported type comes from. */
type Origin =
  | { readonly kind: "protocol"; readonly module: string; readonly symbol: string }
  | { readonly kind: "local" };

/** Names both files export for different records, by design. */
const HOMONYMS: Readonly<Record<string, { backend: string; web: string }>> = {
  Environment: {
    backend:
      "the stored environment record, backend-private (pids, lifecycle record, teardown intents); its wire forms are the protocol's ClientEnvironment and EnvironmentDetail",
    web: "the protocol's ClientEnvironment without containerLifecycle, plus the detail read's initialPromptAttachments",
  },
  AppConfig: {
    backend: "the protocol's StoredAppConfig: the stored settings, credentials included",
    web: "the protocol's AppConfig (credentials redacted), with the redacted fields and the Codex thread limit optional",
  },
};

/** Shared names not converged yet, and the item that converges each. */
const PENDING: Readonly<Record<string, string>> = {
  ClaudeModelCatalogEntry:
    "7009 (agent-servers): the schema types `supportedEffortLevels` and `source` as strings, the models as literal unions",
  ClaudeModelCatalogSnapshot: "7009 (agent-servers): as ClaudeModelCatalogEntry",
  PersistedBuildPipeline:
    "7007 (pipelines): the backend re-exports BuildPipelineRecord; the web's type is generic over its snapshot",
  PersistedNativeAgentSession:
    "7010 follow-up (native-sessions): 7001's result schema is a tolerant reader (every field optional, providers as strings); the web's type is a narrower view",
  PersistedPromptQueue:
    "7010 follow-up (native-sessions): tolerant result schema; the web's type is generic over its messages",
  PersistedComposeDraft:
    "7010 follow-up (native-sessions): tolerant result schema; the web's type is generic over its value",
  PersistedFileDraft: "7010 follow-up (native-sessions): tolerant result schema",
  PersistedAgentHandoff:
    "7010 follow-up (native-sessions): tolerant result schema; the web's type is generic over its snapshot",
  PersistedPaneLayout:
    "7010 follow-up (native-sessions): tolerant result schema; the web declares it in `types/paneLayout.ts`",
  Session: "7010 follow-up (native-sessions): tolerant result schema (every field optional)",
  SessionType:
    "7010 follow-up (native-sessions): the schema reads `sessionType` as a string, the models as a literal union",
  SessionStatus: "7010 follow-up (native-sessions): as SessionType",
};

interface ExportedTypes {
  readonly names: Map<string, Origin>;
}

function readSource(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

function names(list: string): Array<{ local: string; exported: string }> {
  return list
    .split(",")
    .map((part) => part.trim().replace(/^type\s+/u, ""))
    .filter((part) => part.length > 0)
    .map((part) => {
      const [local, exported] = part.split(/\s+as\s+/u);
      return { local: local!.trim(), exported: (exported ?? local!).trim() };
    });
}

/** Imported names that come from the protocol: local name → origin. */
function protocolImports(source: string): Map<string, Origin> {
  const imports = new Map<string, Origin>();
  for (const match of source.matchAll(
    /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"(@orkestrator\/protocol\/[^"]+)";/gu,
  )) {
    for (const { local, exported } of names(match[1]!)) {
      // `import { A as B }`: `exported` is the local binding B, `local` the symbol A.
      imports.set(exported, { kind: "protocol", module: match[2]!, symbol: local });
    }
  }
  return imports;
}

/** Every type a model file exports, with where it comes from. */
function exportedTypes(path: string, seen = new Set<string>()): ExportedTypes {
  const result = new Map<string, Origin>();
  if (seen.has(path)) return { names: result };
  seen.add(path);
  const source = readSource(path);
  const imports = protocolImports(source);
  // export type { A, B as C } from "module";
  for (const match of source.matchAll(/export\s+type\s+\{([^}]*)\}\s+from\s+"([^"]+)";/gu)) {
    for (const { local, exported } of names(match[1]!)) {
      result.set(
        exported,
        match[2]!.startsWith("@orkestrator/protocol/")
          ? { kind: "protocol", module: match[2]!, symbol: local }
          : { kind: "local" },
      );
    }
  }
  // export type { A, B as C };  (re-exporting imports)
  for (const match of source.matchAll(/export\s+type\s+\{([^}]*)\};/gu)) {
    for (const { local, exported } of names(match[1]!)) {
      result.set(exported, imports.get(local) ?? { kind: "local" });
    }
  }
  // export type X = Y;  (an alias of an imported protocol type) or any other type
  for (const match of source.matchAll(
    /export\s+type\s+([A-Za-z_]\w*)(<[^=]*>)?\s*=\s*([^;]*);/gu,
  )) {
    const rhs = match[3]!.trim();
    const aliased =
      match[2] === undefined && /^[A-Za-z_]\w*$/u.test(rhs) ? imports.get(rhs) : undefined;
    result.set(match[1]!, aliased ?? { kind: "local" });
  }
  // export interface X
  for (const match of source.matchAll(/export\s+interface\s+([A-Za-z_]\w*)/gu)) {
    result.set(match[1]!, { kind: "local" });
  }
  // export * from "./relative.js";  (the web's pane layout types)
  for (const match of source.matchAll(/export\s+\*\s+from\s+"(\.[^"]+)";/gu)) {
    const target = resolve(dirname(join(ROOT, path)), match[1]!.replace(/\.js$/u, ".ts"));
    for (const [name, origin] of exportedTypes(target.slice(ROOT.length + 1), seen).names) {
      result.set(name, origin);
    }
  }
  return { names: result };
}

function sameProtocolType(a: Origin | undefined, b: Origin | undefined): boolean {
  return (
    a?.kind === "protocol" &&
    b?.kind === "protocol" &&
    a.module === b.module &&
    a.symbol === b.symbol
  );
}

describe("backend models and web types converge on protocol types", () => {
  const backend = exportedTypes(BACKEND_MODELS).names;
  const web = exportedTypes(WEB_TYPES).names;
  const shared = [...backend.keys()].filter((name) => web.has(name)).sort();

  test("the parser reads both files (a sanity floor)", () => {
    expect(backend.size).toBeGreaterThan(30);
    expect(web.size).toBeGreaterThan(30);
    expect(shared).toContain("Project");
    expect(backend.get("Project")).toEqual({
      kind: "protocol",
      module: "@orkestrator/protocol/contract/domains/projects",
      symbol: "Project",
    });
  });

  test("every name both files export is the same protocol type, a documented homonym, or pending", () => {
    const offenders = shared.filter(
      (name) =>
        !sameProtocolType(backend.get(name), web.get(name)) &&
        HOMONYMS[name] === undefined &&
        PENDING[name] === undefined,
    );
    expect(offenders).toEqual([]);
  });

  test("the exception lists hold only names that still need them", () => {
    const stale = [...Object.keys(HOMONYMS), ...Object.keys(PENDING)].filter(
      (name) => !shared.includes(name) || sameProtocolType(backend.get(name), web.get(name)),
    );
    expect(stale).toEqual([]);
  });

  test("the converged names include the environment and settings models", () => {
    for (const name of [
      "PortMapping",
      "InitialPromptImageAttachment",
      "RepositoryConfig",
      "DefaultAgent",
      "ClaudeMode",
      "ClaudeNativeBackend",
      "EnvironmentStatus",
    ]) {
      expect(sameProtocolType(backend.get(name), web.get(name))).toBe(true);
    }
  });
});
