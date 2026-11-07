/**
 * The old portal-channel names, as a thin adapter over the command scope
 * (plan item 5004). Deleted with realms in plan item 6002.
 *
 * There is no portal/workspace split any more: a portal call is a call on
 * the window's command scope (`./command-scope`), and only a workspace realm
 * document reaches it over the page's portal channel (`./page-portal`). New
 * code imports those modules directly.
 */

export {
  commandScopeInvoke as portalInvoke,
  commandScopeListen as portalListen,
  commandScopeListenAuthoritative as portalListenAuthoritative,
} from "./command-scope";
export { workspaceTarget, type WorkspaceTarget } from "./page-portal";
