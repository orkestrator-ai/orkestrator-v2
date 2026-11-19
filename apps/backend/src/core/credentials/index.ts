/** Agent credentials (docs/architecture/agent-credentials.md). */
export { CREDENTIAL_STORE_LAYOUTS } from "./layout.js";
export { CredentialRecordStore } from "./records.js";
export {
  credentialVaultPreference,
  FileCredentialVault,
  KeychainCredentialVault,
  MemoryCredentialVault,
  openCredentialVault,
  type CredentialVault,
  type CredentialVaultPreference,
} from "./vault.js";
export type {
  CredentialHost,
  CredentialRuntimeInfo,
  CredentialServiceOptions,
  CredentialSessionInfo,
} from "./context.js";
export type { CredentialCaller } from "./access.js";
export type { CredentialLaunch } from "./runner.js";
export { CredentialService } from "./service.js";
export {
  CREDENTIAL_TOOL_INSTRUCTIONS,
  registerCredentialTools,
  type CredentialToolHost,
} from "./tools.js";
