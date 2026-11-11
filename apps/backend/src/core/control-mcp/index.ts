// The control-mcp domain's public surface: the only module other backend code
// imports. Re-export by name (never `export *`) so the surface stays
// reviewable.
//
// One leaf module is a named exception in `.oxlintrc.json`, because routing
// its value importers through this file would close a runtime import cycle
// (this file reaches most of the backend through `server.ts`):
// `commands-servers.ts` and `scheduled-jobs/executor.ts` import
// `coordinatorRoleCapabilities` from `tools.js` directly. It is still
// re-exported here.
export type { CreateControlMcpCredentialInput } from "./credentials.js";
export {
  ControlMcpServer,
  controlMcpPortOverride,
  type ControlMcpEndpointState,
  type ControlMcpInfo,
  type ControlMcpSettings,
  type CoordinatorControlConnection,
} from "./server.js";
export { coordinatorRoleCapabilities, type CoordinatorControlScope } from "./tools.js";
