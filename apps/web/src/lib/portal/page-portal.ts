/**
 * A workspace realm document's page globals (deleted with realms, plan items
 * 6002 and 6003).
 *
 * A realm document is its own window whose `window.orkestrator`, and so its
 * command scope, is a leaf. It reaches its window's real command node only
 * through the page's portal channel, `window.orkestratorPortal`, which the
 * desktop preload (`exposePortal`) and the browser gateway
 * (`workspaceTargetGatewayOptions`) install together with
 * `window.orkestratorWorkspaceTarget`, and only in realm documents.
 *
 * This is the one module that reads `window.orkestratorPortal` (the
 * `window-orkestrator-portal` source guard), and it reads it only in a page
 * that names a workspace target. An app window, and every node shown in its
 * own tree (plan item 4001), has no target, so nothing on that path touches
 * the portal global: it calls the command scope (`./command-scope`).
 */

export type WorkspaceTarget = NonNullable<Window["orkestratorWorkspaceTarget"]>;

/** The page's portal channel to its command node. */
export type PagePortal = NonNullable<Window["orkestratorPortal"]>;

/** The node a realm document's workspace is on, or `null` in any other page. */
export function workspaceTarget(): WorkspaceTarget | null {
  return (typeof window !== "undefined" && window.orkestratorWorkspaceTarget) || null;
}

/**
 * The realm document's portal channel, or `null` in any other page (the
 * portal global is not read there at all).
 */
export function pagePortal(): PagePortal | null {
  if (workspaceTarget() === null) return null;
  return window.orkestratorPortal ?? null;
}
