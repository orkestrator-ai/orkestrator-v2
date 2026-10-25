import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type {
  McpAdvancedFieldSchema,
  McpAdvancedValue,
  McpConfigSource,
  McpFieldError,
  McpSourceFormat,
  McpSourceOwner,
  McpTargetCapabilities,
  McpTransport,
} from "@orkestrator/protocol/mcp-management";

/** Provider-neutral view of one saved definition. Backend-only: carries secrets. */
export interface CanonicalDefinition {
  transport: McpTransport | "unknown";
  command?: string;
  args: string[];
  cwd?: string;
  url?: string;
  env: Record<string, string>;
  headers: Record<string, string>;
  /** `null` when the provider has no persisted enable flag. */
  enabled: boolean | null;
  advanced: Record<string, McpAdvancedValue>;
  /** Native keys the codec does not own; retained verbatim on write. */
  preservedFields: string[];
  /** Set when the entry cannot be represented faithfully; it is then read-only. */
  unsupportedReason?: string;
  invalidReason?: string;
}

export type NativeEntry = Record<string, unknown>;

export interface ProviderCodec {
  /** Native keys this codec reads and writes; everything else is preserved. */
  decode(raw: NativeEntry): CanonicalDefinition;
  /** Build the native entry, starting from `previous` so unknown keys survive. */
  encode(definition: CanonicalDefinition, previous: NativeEntry | null): NativeEntry;
  advancedFields: McpAdvancedFieldSchema[];
  /** Provider limits and grammar beyond the protocol's structural checks. */
  validate(definition: CanonicalDefinition, name: string, isNewName: boolean): McpFieldError[];
  nameRule: McpTargetCapabilities["nameRule"];
  /** How a same-name entry in a higher source combines with a lower one. */
  mergeNote?: string;
}

export interface TargetContextInfo {
  kind: "backend" | "environment";
  environmentId?: string;
  environmentName?: string;
  projectId?: string;
  projectName?: string;
  location: "backend-host" | "local-worktree" | "container";
  /** Local worktree root, when the target is a local environment. */
  worktreePath?: string;
  /** Container id, when the target is a running or stopped container environment. */
  containerId?: string;
  /** Environment is a coordinator/review runtime with project resources excluded. */
  environmentStatus?: string;
  /**
   * Whether the environment's interactive sessions load project resources,
   * from its resolved execution policy. Host Cursor and Pi sessions load their
   * project MCP file only when this is on.
   */
  projectResources?: boolean;
}

/** A native configuration source a target can see. Backend-only: carries a path. */
export interface SourceSpec {
  sourceId: string;
  provider: AgentPlatform;
  scope: McpConfigSource["scope"];
  owner: McpSourceOwner;
  format: Exclude<McpSourceFormat, "runtime"> | "runtime";
  label: string;
  path: string;
  displayPath: string;
  /** Key path of the server map, e.g. `["mcpServers"]` or `["projects", cwd, "mcpServers"]`. */
  subtree: string[];
  /** Pi accepts a bare map at the document root as well as `mcpServers`. */
  bareMapFallback?: boolean;
  precedence: number;
  writable: boolean;
  readOnlyReason?: string;
  trust?: McpConfigSource["trust"];
  trustReason?: string;
  sharedWith: AgentPlatform[];
  maxBytes: number;
  allowedRoot?: string;
  createMode: number;
  /** For runtime-only sources (injected connections): the names they own. */
  runtimeNames?: string[];
  /** Entries a source is known to exclude (Grok compat disabled, etc.). */
  excludedReason?: string;
  /** Set when the file lives inside a container; `path` is then a container path. */
  container?: { containerId: string };
  /**
   * Configuration supplied inline (e.g. `OPENCODE_CONFIG_CONTENT`) rather than
   * from a file. Always read-only; may carry secrets and is never logged.
   */
  inlineText?: string;
  /**
   * Prefix the provider puts before every server name in this source (Claude
   * plugins: `plugin:<plugin>:`). Read-only sources only: entries are matched
   * to the file by their unprefixed key.
   */
  entryNamePrefix?: string;
  /** Every entry is disabled by a setting outside this file (a plugin turned off). */
  disabledReason?: string;
  /** Shown with the source: how something outside the file affects what it declares. */
  note?: string;
  /** Listed for its note and state only; its servers are not read (an unmodelled declaration). */
  noEntries?: boolean;
  /** Discovery omitted declarations or could not read a plugin layer. */
  discoveryIncomplete?: boolean;
}

/** Bounded read of one file inside a container. Never runs a shell over the path. */
export type ContainerFileReader = (
  containerId: string,
  filePath: string,
  maxBytes: number,
) => Promise<{ state: "ok"; bytes: Uint8Array } | { state: "absent" | "oversized" | "offline" }>;

export type ContainerFileWriteResult =
  | { state: "ok" }
  /** The file no longer has the bytes the write was prepared against. */
  | { state: "conflict" }
  /** Destination outside the allowed homes, a symlink, or not a regular file. */
  | { state: "refused" }
  | { state: "oversized" }
  | { state: "offline" }
  | { state: "failed" };

/**
 * Narrow, backend-owned write of one file inside a container as the `node`
 * user. The backend chooses `filePath` from its own source specs (never the
 * renderer); the payload goes over stdin, bounded; `expectedDigest` is the
 * `contentDigest` of the bytes the change was prepared against, or `absent`.
 * `private` writes mode 0600; `preserve` keeps an existing file's mode
 * (0644 for a new one).
 */
export type ContainerFileWriter = (
  containerId: string,
  filePath: string,
  write: { expectedDigest: string; bytes: Uint8Array; mode: "private" | "preserve" },
) => Promise<ContainerFileWriteResult>;

/** Id of the container's current boot, or `null` for images without boot status. */
export type ContainerBootReader = (containerId: string) => Promise<string | null>;

/**
 * What each absolute path is inside a container, from one bounded exec.
 * Paths are arguments to a fixed script, never shell text.
 */
export type ContainerPathProbe = (
  containerId: string,
  paths: readonly string[],
) => Promise<Map<string, "file" | "directory" | "absent"> | null>;

export interface PluginDirectoryListing {
  directories: string[];
  /** The scan hit its bound or could not finish. */
  incomplete?: boolean;
}

/** Bounded subdirectory listing inside a container for plugin folder discovery. */
export type ContainerDirectoryLister = (
  containerId: string,
  dir: string,
) => Promise<PluginDirectoryListing>;
