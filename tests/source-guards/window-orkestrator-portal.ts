import { isMember, propertyKey, unwrap, type AnyNode } from "./ast";
import type { GuardVisitor, ScannedFile, SourceGuard } from "./guard";

/**
 * Renderer code that reads the portal global, `window.orkestratorPortal`
 * (plan item 5004, report §5.1): the portal APIs are calls on the command
 * scope (`apps/web/src/lib/portal/command-scope.ts`), so no renderer code
 * reads the global. Its last reader, the page adapter of the separate
 * workspace documents, went with them (plan item 6002); the desktop preload
 * stops installing it in plan item 6003. There is no baseline: any read is a
 * finding.
 */

/** The renderer's production sources. */
export const WINDOW_ORKESTRATOR_PORTAL_ROOTS = ["apps/web/src"] as const;

const GLOBALS = ["window", "globalThis", "self"] as const;
const PORTAL = "orkestratorPortal";

function isPortalGlobal(node: AnyNode): boolean {
  return GLOBALS.some((global) => isMember(node, global, PORTAL));
}

/** `const { orkestratorPortal } = window`, which reads the global without a member expression. */
function destructuresPortal(declarator: AnyNode): boolean {
  const init = declarator.init ? unwrap(declarator.init) : null;
  if (!init || init.type !== "Identifier" || !(GLOBALS as readonly string[]).includes(init.name))
    return false;
  if (declarator.id?.type !== "ObjectPattern") return false;
  return declarator.id.properties.some(
    (property: AnyNode) => property.type === "Property" && propertyKey(property) === PORTAL,
  );
}

function visitPortalReads(): GuardVisitor {
  const findings: number[] = [];
  return {
    handlers: {
      MemberExpression(node) {
        if (isPortalGlobal(node)) findings.push(node.start);
      },
      VariableDeclarator(node) {
        if (destructuresPortal(node)) findings.push(node.start);
      },
    },
    finish: () => [...new Set(findings)].sort((left, right) => left - right),
  };
}

export function appliesToPortalReader(file: Pick<ScannedFile, "path">): boolean {
  return WINDOW_ORKESTRATOR_PORTAL_ROOTS.some((root) => file.path.startsWith(`${root}/`));
}

export const windowOrkestratorPortal: SourceGuard = {
  id: "window-orkestrator-portal",
  advice:
    "The portal APIs are calls on the command scope: commandScopeInvoke, commandScopeListen " +
    "and commandScopeBackendClient from @/lib/portal/command-scope. Nothing in the renderer " +
    "reads window.orkestratorPortal.",
  productionRoots: WINDOW_ORKESTRATOR_PORTAL_ROOTS,
  appliesTo: appliesToPortalReader,
  mayOffend: (source) => source.includes(PORTAL),
  visit: () => visitPortalReads(),
};
