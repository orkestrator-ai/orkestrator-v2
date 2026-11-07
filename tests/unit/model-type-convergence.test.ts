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
 * promise. A side may instead declare a view derived from the other side's
 * protocol type (`export type X<T> = Omit<P, "value"> & { value: T }`, where
 * `P` is the symbol the other side re-exports): the plan's "narrower or
 * derived view type". Two lists name the exceptions:
 *
 * - {@link HOMONYMS}: names that deliberately mean different records on the
 *   two sides (each side's meaning stated). The test checks both still
 *   collide, so a resolved homonym leaves the list.
 * - {@link PENDING}: shared names whose protocol schema is not yet the
 *   model's definition, with the item that converges them. A pending name
 *   that has converged (or no longer collides) fails the test until it is
 *   removed, so the list only shrinks. 7010's "Done when" is this list empty
 *   (it is, since 2026-11-07).
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const BACKEND_MODELS = "apps/backend/src/core/models.ts";
const WEB_TYPES = "apps/web/src/types/index.ts";

/** Where an exported type comes from. */
interface ProtocolOrigin {
  readonly kind: "protocol";
  readonly module: string;
  readonly symbol: string;
}
type Origin =
  ProtocolOrigin | { readonly kind: "local"; readonly derivedFrom: readonly ProtocolOrigin[] };

const LOCAL: Origin = { kind: "local", derivedFrom: [] };

/** Names both files export for different records, by design. */
const HOMONYMS: Readonly<Record<string, { backend: string; web: string }>> = {
  Environment: {
    backend:
      "the stored environment record, backend-private: the protocol's ClientEnvironment (extended, ports kept narrower) plus pids, the durable lifecycle record, activity sources and teardown intents; its wire forms are ClientEnvironment and EnvironmentDetail",
    web: "the protocol's ClientEnvironment without containerLifecycle, plus the detail read's initialPromptAttachments",
  },
  AppConfig: {
    backend: "the protocol's StoredAppConfig: the stored settings, credentials included",
    web: "the protocol's AppConfig (credentials redacted), with the redacted fields and the Codex thread limit optional",
  },
};

/**
 * Shared names not converged yet, and the item that converges each. Empty
 * since 7010 converged the catalogues, the workflow envelopes and the native
 * session and prompt queue records; a new entry needs an owner and a reason.
 */
const PENDING: Readonly<Record<string, string>> = {};

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
          : LOCAL,
      );
    }
  }
  // export type { A, B as C };  (re-exporting imports)
  for (const match of source.matchAll(/export\s+type\s+\{([^}]*)\};/gu)) {
    for (const { local, exported } of names(match[1]!)) {
      result.set(exported, imports.get(local) ?? LOCAL);
    }
  }
  // export type X = Y;  (an alias of an imported protocol type) or any other type
  for (const match of source.matchAll(
    /export\s+type\s+([A-Za-z_]\w*)(<[^>]*>)?\s*=\s*([^;]*);/gu,
  )) {
    const rhs = match[3]!.trim();
    const aliased =
      match[2] === undefined && /^[A-Za-z_]\w*$/u.test(rhs) ? imports.get(rhs) : undefined;
    const derivedFrom = [...rhs.matchAll(/[A-Za-z_]\w*/gu)]
      .map((identifier) => imports.get(identifier[0]))
      .filter((origin): origin is ProtocolOrigin => origin?.kind === "protocol");
    result.set(match[1]!, aliased ?? { kind: "local", derivedFrom });
  }
  // export interface X
  for (const match of source.matchAll(/export\s+interface\s+([A-Za-z_]\w*)/gu)) {
    result.set(match[1]!, LOCAL);
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

/** Every type name the protocol's contract domain modules export (their models and results). */
function protocolDomainTypeNames(): Set<string> {
  const names = new Set<string>();
  const domains = join(ROOT, "packages/protocol/src/contract/domains");
  const files = readdirSync(domains, { recursive: true, encoding: "utf8" }).filter(
    (file) => file.endsWith(".ts") && !file.endsWith(".test.ts"),
  );
  for (const file of files) {
    const source = readFileSync(join(domains, file), "utf8");
    for (const match of source.matchAll(/export\s+(?:type|interface)\s+([A-Za-z_]\w*)/gu)) {
      names.add(match[1]!);
    }
  }
  return names;
}

function sameSymbol(a: ProtocolOrigin, b: ProtocolOrigin): boolean {
  return a.module === b.module && a.symbol === b.symbol;
}

function sameProtocolType(a: Origin | undefined, b: Origin | undefined): boolean {
  return a?.kind === "protocol" && b?.kind === "protocol" && sameSymbol(a, b);
}

/** One side is a protocol type and the other a view declared from that same type. */
function derivedView(a: Origin | undefined, b: Origin | undefined): boolean {
  const derives = (protocol: Origin | undefined, view: Origin | undefined) =>
    protocol?.kind === "protocol" &&
    view?.kind === "local" &&
    view.derivedFrom.some((origin) => sameSymbol(origin, protocol));
  return derives(a, b) || derives(b, a);
}

function converged(name: string, backend: Map<string, Origin>, web: Map<string, Origin>): boolean {
  return (
    sameProtocolType(backend.get(name), web.get(name)) ||
    derivedView(backend.get(name), web.get(name))
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

  test("every name both files export is the same protocol type (or a view of it), a documented homonym, or pending", () => {
    const offenders = shared.filter(
      (name) =>
        !converged(name, backend, web) &&
        HOMONYMS[name] === undefined &&
        PENDING[name] === undefined,
    );
    expect(offenders).toEqual([]);
  });

  test("the exception lists hold only names that still need them", () => {
    const stale = [...Object.keys(HOMONYMS), ...Object.keys(PENDING)].filter(
      (name) => !shared.includes(name) || converged(name, backend, web),
    );
    expect(stale).toEqual([]);
  });

  test("neither file declares its own copy of a type a protocol domain defines", () => {
    // A locally declared type (not a re-export, alias or view of a protocol
    // type) under a name a contract domain exports is a second definition of
    // a wire model: 7010's "Done when". The documented homonyms are the
    // exception (the backend's stored `Environment` extends the protocol's
    // `ClientEnvironment`).
    const protocolNames = protocolDomainTypeNames();
    expect(protocolNames.has("ClientEnvironment")).toBe(true);
    const copies = [
      ...[...backend].map(([name, origin]) => ({ side: "backend", name, origin })),
      ...[...web].map(([name, origin]) => ({ side: "web", name, origin })),
    ]
      .filter(
        ({ name, origin }) =>
          origin.kind === "local" &&
          origin.derivedFrom.length === 0 &&
          protocolNames.has(name) &&
          HOMONYMS[name] === undefined,
      )
      .map(({ side, name }) => `${side}: ${name}`);
    expect(copies).toEqual([]);
  });

  test("the converged names include the environment, settings, catalogue and session models", () => {
    for (const name of [
      "PortMapping",
      "InitialPromptImageAttachment",
      "RepositoryConfig",
      "DefaultAgent",
      "ClaudeMode",
      "ClaudeNativeBackend",
      "EnvironmentStatus",
      "Session",
      "PersistedFileDraft",
      "PersistedPaneLayout",
      "ClaudeModelCatalogEntry",
      "ClaudeModelCatalogSnapshot",
      "PersistedNativeAgentSession",
    ]) {
      expect(sameProtocolType(backend.get(name), web.get(name))).toBe(true);
    }
    // The web's generic drafts and envelopes are views of the protocol records.
    for (const name of [
      "PersistedComposeDraft",
      "PersistedAgentHandoff",
      "PersistedBuildPipeline",
      "PersistedPromptQueue",
    ]) {
      expect(derivedView(backend.get(name), web.get(name))).toBe(true);
    }
  });
});
