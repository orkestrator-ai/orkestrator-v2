import { isMember, memberName, propertyKey, unwrap, walk, type AnyNode } from "./ast";
import type { GuardVisitor, ScannedFile, SourceGuard } from "./guard";

/**
 * Renderer code that reads the host API straight off the page global
 * (`window.orkestrator`) instead of through a node scope (plan item 2010,
 * report §6.4 and §7.6).
 *
 * Every read is counted, so the baseline lists what is left: window-shell
 * calls (clipboard, window, process, shell, bug report, keyboard shortcuts,
 * presence checks) and desktop-only APIs (connections, web client,
 * permissions), which stay until they get a shell or
 * host-scoped API of their own. Transport calls (`invoke`, `listen`, the
 * stream readiness and connection, `node(nodeId)`) must go through the scope
 * client and have no baseline: `transportAccesses` must find none.
 */

/** The renderer's production sources. */
export const WINDOW_ORKESTRATOR_ROOTS = ["apps/web/src"] as const;

/**
 * Where reading the host is the point: the scope's host adapters (the command
 * client and the desktop node client wrap `window.orkestrator`), and the
 * in-tree test helpers, which install fakes on it.
 */
const EXEMPT_PREFIXES = ["apps/web/src/lib/node-scope/", "apps/web/src/test/"] as const;

/** The transport half of the host API: what a `NodeClient` replaces. */
export const TRANSPORT_MEMBERS: ReadonlySet<string> = new Set([
  "invoke",
  "listen",
  "eventStreamReady",
  "eventStreamConnection",
  "node",
  "nodes",
]);

const GLOBALS = ["window", "globalThis", "self"] as const;

function isHostGlobal(node: AnyNode): boolean {
  return GLOBALS.some((global) => isMember(node, global, "orkestrator"));
}

/** `const { orkestrator } = window`, which reads the global without a member expression. */
function destructuresHost(declarator: AnyNode): boolean {
  const init = declarator.init ? unwrap(declarator.init) : null;
  if (!init || init.type !== "Identifier" || !(GLOBALS as readonly string[]).includes(init.name))
    return false;
  if (declarator.id?.type !== "ObjectPattern") return false;
  return declarator.id.properties.some(
    (property: AnyNode) => property.type === "Property" && propertyKey(property) === "orkestrator",
  );
}

function visitHostReads(): GuardVisitor {
  const findings: number[] = [];
  return {
    handlers: {
      MemberExpression(node) {
        if (isHostGlobal(node)) findings.push(node.start);
      },
      VariableDeclarator(node) {
        if (destructuresHost(node)) findings.push(node.start);
      },
    },
    finish: () => [...new Set(findings)].sort((left, right) => left - right),
  };
}

/**
 * Source offsets of `window.orkestrator.<transport member>` reads
 * (`window.orkestrator?.listen`, `window.orkestrator.invoke(...)`, ...).
 */
export function transportAccesses(program: AnyNode): number[] {
  const offsets: number[] = [];
  walk(program, (node) => {
    if (node.type !== "MemberExpression") return;
    const name = memberName(node);
    if (name && TRANSPORT_MEMBERS.has(name) && isHostGlobal(unwrap(node.object)))
      offsets.push(node.start);
  });
  return offsets;
}

export function appliesToRendererSource(file: Pick<ScannedFile, "path">): boolean {
  return (
    WINDOW_ORKESTRATOR_ROOTS.some((root) => file.path.startsWith(`${root}/`)) &&
    !EXEMPT_PREFIXES.some((prefix) => file.path.startsWith(prefix))
  );
}

export const windowOrkestratorDirect: SourceGuard = {
  id: "window-orkestrator-direct",
  advice:
    "Renderer code reads the host API through a node scope, not window.orkestrator. " +
    "Commands and events: invoke/listen from @/lib/native/backend and @/lib/native/events " +
    "(command scope), commandClient() from @/lib/node-scope/app-window-scope, or the scope " +
    "you hold (scope.client, invokeInScope). Clipboard, window and process calls: the " +
    "@/lib/native/{clipboard,window,process} wrappers. A new desktop-only API belongs in " +
    "lib/native or lib/node-scope, never read off the global in a component.",
  productionRoots: WINDOW_ORKESTRATOR_ROOTS,
  appliesTo: appliesToRendererSource,
  mayOffend: (source) =>
    source.includes("orkestrator") &&
    (/\b(?:window|globalThis|self)\s*(?:\?\.|\.)\s*orkestrator\b/.test(source) ||
      /\b(?:window|globalThis|self)\s*(?:\?\.)?\[\s*["'`]orkestrator["'`]\s*\]/.test(source) ||
      /\borkestrator\b[^}]*\}\s*=\s*(?:window|globalThis|self)\b/.test(source)),
  visit: () => visitHostReads(),
};
