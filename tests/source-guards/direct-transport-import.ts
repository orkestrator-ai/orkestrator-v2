import type { AnyNode } from "./ast";
import type { GuardVisitor, ScannedFile, SourceGuard } from "./guard";
import {
  WEB_SOURCE_ROOT,
  bringsValues,
  dynamicImportOf,
  moduleReferences,
  resolveWebModule,
  type ModuleReference,
} from "./web-modules";

/**
 * Renderer code that reaches a backend transport by importing it, instead of
 * through a node scope (plan item 2012, report §7.6).
 *
 * The transports are the command-scope wrappers (`invoke` in
 * `lib/native/backend`, `listen` in `lib/native/events`, `listenAuthoritative`
 * in `lib/native/authoritative-events`) and the browser node transport
 * (`lib/native/node-transport`, `createNodeTransport`). Each value import,
 * re-export or `import()` of one is counted per file; type-only imports reach
 * nothing and are not. Existing importers sit in the baseline, which only
 * falls. The host global's transport members (`window.orkestrator.invoke`,
 * `listen`, `node(nodeId)`, ...) are the `window-orkestrator-direct` guard's,
 * which allows none.
 */

export const DIRECT_TRANSPORT_ROOTS = [WEB_SOURCE_ROOT] as const;

/** Module ids (see `web-modules.ts`) of the transports. */
export const TRANSPORT_MODULES: ReadonlySet<string> = new Set([
  "apps/web/src/lib/native/backend",
  "apps/web/src/lib/native/events",
  "apps/web/src/lib/native/authoritative-events",
  "apps/web/src/lib/native/node-transport",
]);

/**
 * Where importing a transport is the point: the scopes and their clients
 * (`lib/node-scope`), the typed command clients that are reached through a
 * scope (`lib/backend`), the host adapter layer that defines the transports
 * and builds them on one another (`lib/native`), and the in-tree test helpers.
 */
export const DIRECT_TRANSPORT_EXEMPT_PREFIXES = [
  "apps/web/src/lib/node-scope/",
  "apps/web/src/lib/backend/",
  "apps/web/src/lib/native/",
  "apps/web/src/test/",
] as const;

export function appliesToTransportImporter(file: Pick<ScannedFile, "path">): boolean {
  return (
    DIRECT_TRANSPORT_ROOTS.some((root) => file.path.startsWith(`${root}/`)) &&
    !DIRECT_TRANSPORT_EXEMPT_PREFIXES.some((prefix) => file.path.startsWith(prefix))
  );
}

function namesTransport(file: ScannedFile, reference: ModuleReference): boolean {
  const target = resolveWebModule(file.path, reference.specifier);
  return target !== null && TRANSPORT_MODULES.has(target) && bringsValues(reference);
}

function visitTransportImports(program: AnyNode, file: ScannedFile): GuardVisitor {
  const findings: number[] = [];
  for (const reference of moduleReferences(program, file.source))
    if (namesTransport(file, reference)) findings.push(reference.start);
  return {
    handlers: {
      ImportExpression(node) {
        const reference = dynamicImportOf(node);
        if (reference && namesTransport(file, reference)) findings.push(reference.start);
      },
    },
    finish: () => [...new Set(findings)].sort((left, right) => left - right),
  };
}

export const directTransportImport: SourceGuard = {
  id: "direct-transport-import",
  advice:
    "Reach a backend through a node scope, not by importing a transport. In a component: " +
    "useNodeScope() then scope.client.invokeRaw/listenRaw, or a scoped store or service that " +
    "holds the scope. In plain code: take the NodeScope (or its NodeClient) as a parameter. " +
    "The typed clients in lib/backend are the shared command layer; call those. Only " +
    "lib/node-scope, lib/backend and lib/native import @/lib/native/{backend,events," +
    "authoritative-events,node-transport}.",
  productionRoots: DIRECT_TRANSPORT_ROOTS,
  appliesTo: appliesToTransportImporter,
  mayOffend: (source) =>
    /native\/(?:backend|events|authoritative-events|node-transport)\b/.test(source),
  visit: visitTransportImports,
};
