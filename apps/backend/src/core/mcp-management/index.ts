// The mcp-management domain's public surface: the only module other backend
// code imports. Re-export by name (never `export *`) so the surface stays
// reviewable.
export type { ApplyEnvironment, ApplySession, RuntimeProbe } from "./apply.js";
export type { LoadedSource } from "./catalog.js";
export type { ContainerNetworkView } from "./network-hints.js";
export type { StagedDefaultsWriter } from "./overlay-service.js";
export { McpManagementService, type McpManagementServiceOptions } from "./service.js";
// The format-preserving TOML editor, for Codex plugin switches (capabilities/provider-adapters).
export {
  scanTomlLayout,
  tomlDeepEqual,
  tomlEntryLayout,
  TomlEditError,
  updateTomlEntry,
} from "./toml-edit.js";
export type {
  ContainerBootReader,
  ContainerDirectoryLister,
  ContainerFileReader,
  ContainerFileWriter,
  ContainerPathProbe,
} from "./types.js";
