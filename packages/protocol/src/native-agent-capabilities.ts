/**
 * The provider-neutral capability vocabulary of `NativeAgentExecutionPolicy`,
 * and how it travels to bridges that predate part of it.
 *
 * A capability names an operation (`file.write`, `git.push`), never a tool.
 * Each bridge translates the ones it knows into its own SDK's terms. The first
 * six (`LEGACY_NATIVE_AGENT_CAPABILITIES`) are known to every bridge ever
 * released. The rest arrived with graph capability profiles (plan P1.6,
 * report §6.3):
 *
 * - `git.commit`, `git.push`, `github.write`: version control and GitHub
 *   writes. Agents never hold the last two (D12); a system node pushes.
 * - `subagents`: the agent's own sub-agent tool (Claude `Task`/`Agent`,
 *   OpenCode `task`, Cursor `task`).
 * - `mcp:<server>`: one named MCP server. Deny only until per-session user
 *   servers exist (plan item 404).
 * - `orkestrator:<group>`: Orkestrator's own tool groups. The backend holds
 *   these through the activation's credential, so they never reach a bridge.
 *
 * Every released bridge validates a request's policy with
 * `isNativeAgentExecutionPolicy` and, on failure, drops the whole policy and
 * runs its permissive default. A new name in `capabilityPolicy.deny` would
 * therefore widen a session on an older bridge, such as one baked into a
 * container image. `nativeAgentPolicyForBridge` keeps the wire form readable
 * to those bridges: `deny` carries only the six old names, the new ones ride
 * in `extendedDeny` (which older validators ignore), and a capability the
 * target bridge does not translate gets its nearest enforceable stand-in.
 * Bridges read denials through `nativeAgentDeniedCapabilities`, which accepts
 * both forms.
 */
import type { AgentPlatform } from "./agent-platforms.js";
import type { NativeAgentExecutionPolicy } from "./native-agent.js";

/** The vocabulary every released bridge validates. Never extend this list. */
export const LEGACY_NATIVE_AGENT_CAPABILITIES = [
  "file.write",
  "file.patch",
  "shell",
  "shell.mutate",
  "network",
  "web.search",
] as const;
export type LegacyNativeAgentCapability = (typeof LEGACY_NATIVE_AGENT_CAPABILITIES)[number];

/**
 * A thing an agent can do, named independently of any provider's tool names.
 *
 * `toolPolicy` cannot serve this purpose: it is the user-editable override
 * surface and its strings are passed to a provider verbatim, so the same list
 * means "Write, Edit" on one bridge and nothing at all on another. A capability
 * is translated by each bridge into whatever its own SDK calls that operation,
 * which is what lets one coordinator policy hold across every platform.
 *
 * These are the plain names; `mcp:<server>` and `orkestrator:<group>` are
 * families (`isNativeAgentCapability`).
 */
export const NATIVE_AGENT_CAPABILITIES = [
  ...LEGACY_NATIVE_AGENT_CAPABILITIES,
  "git.commit",
  "git.push",
  "github.write",
  "subagents",
] as const;
export type NativeAgentPlainCapability = (typeof NATIVE_AGENT_CAPABILITIES)[number];

/** Backend-enforced Orkestrator tool groups: `orkestrator:<group>`. */
export const NATIVE_AGENT_ORKESTRATOR_CAPABILITY_GROUPS = [
  "tickets.read",
  "tickets.write",
  "mail",
  "artifacts",
  "schedules",
] as const;
export type NativeAgentOrkestratorCapabilityGroup =
  (typeof NATIVE_AGENT_ORKESTRATOR_CAPABILITY_GROUPS)[number];

/** A server name inside `mcp:<server>`, as the graph template grammar accepts it. */
export const NATIVE_AGENT_MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
export const NATIVE_AGENT_MCP_SERVER_NAME_MAX_CHARS = 64;

export type NativeAgentCapability =
  | NativeAgentPlainCapability
  | `mcp:${string}`
  | `orkestrator:${NativeAgentOrkestratorCapabilityGroup}`;

/** Most entries `extendedDeny` may carry; a policy is a handful of names. */
export const NATIVE_AGENT_EXTENDED_DENY_MAX = 64;
/** Longest `extendedDeny` entry accepted, known or not. */
export const NATIVE_AGENT_EXTENDED_DENY_MAX_CHARS = 128;

export function isLegacyNativeAgentCapability(
  value: unknown,
): value is LegacyNativeAgentCapability {
  return (
    typeof value === "string" &&
    (LEGACY_NATIVE_AGENT_CAPABILITIES as readonly string[]).includes(value)
  );
}

export function isNativeAgentCapability(value: unknown): value is NativeAgentCapability {
  if (typeof value !== "string") return false;
  if ((NATIVE_AGENT_CAPABILITIES as readonly string[]).includes(value)) return true;
  return (
    nativeAgentMcpServer(value) !== undefined || nativeAgentOrkestratorGroup(value) !== undefined
  );
}

/** The server a `mcp:<server>` capability names, or undefined. */
export function nativeAgentMcpServer(capability: string): string | undefined {
  if (!capability.startsWith("mcp:")) return undefined;
  const server = capability.slice(4);
  return server.length > 0 &&
    server.length <= NATIVE_AGENT_MCP_SERVER_NAME_MAX_CHARS &&
    NATIVE_AGENT_MCP_SERVER_NAME_PATTERN.test(server)
    ? server
    : undefined;
}

/** The group an `orkestrator:<group>` capability names, or undefined. */
export function nativeAgentOrkestratorGroup(
  capability: string,
): NativeAgentOrkestratorCapabilityGroup | undefined {
  if (!capability.startsWith("orkestrator:")) return undefined;
  const group = capability.slice(12);
  return (NATIVE_AGENT_ORKESTRATOR_CAPABILITY_GROUPS as readonly string[]).includes(group)
    ? (group as NativeAgentOrkestratorCapabilityGroup)
    : undefined;
}

/**
 * Sort key that keeps capability lists stable: plain names in vocabulary
 * order, then `mcp:` servers, then Orkestrator groups, each alphabetically.
 */
export function compareNativeAgentCapabilities(a: string, b: string): number {
  const rank = (value: string): [number, string] => {
    const plain = (NATIVE_AGENT_CAPABILITIES as readonly string[]).indexOf(value);
    if (plain >= 0) return [plain, ""];
    if (value.startsWith("mcp:")) return [NATIVE_AGENT_CAPABILITIES.length, value];
    return [NATIVE_AGENT_CAPABILITIES.length + 1, value];
  };
  const [rankA, keyA] = rank(a);
  const [rankB, keyB] = rank(b);
  if (rankA !== rankB) return rankA - rankB;
  return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
}

/**
 * Every capability a policy denies, in either form.
 *
 * The canonical form lists them all in `deny`. The wire form
 * (`nativeAgentPolicyForBridge`) moves the post-legacy names to
 * `extendedDeny`; names this build does not know are skipped there, because a
 * sender newer than this reader already put their stand-ins in `deny`.
 */
export function nativeAgentDeniedCapabilities(
  policy: Pick<NativeAgentExecutionPolicy, "capabilityPolicy"> | undefined,
): NativeAgentCapability[] {
  const capabilities = policy?.capabilityPolicy;
  if (!capabilities) return [];
  const denied = new Set<NativeAgentCapability>(capabilities.deny);
  for (const name of capabilities.extendedDeny ?? []) {
    if (isNativeAgentCapability(name)) denied.add(name);
  }
  return [...denied];
}

export function nativeAgentPolicyDenies(
  policy: Pick<NativeAgentExecutionPolicy, "capabilityPolicy"> | undefined,
  capability: NativeAgentCapability,
): boolean {
  return nativeAgentDeniedCapabilities(policy).includes(capability);
}

/**
 * Whether a set of denials makes the workspace read-only: no file tool may
 * write and the shell may not mutate (or is gone). A read-only policy is
 * dispatched as a read-only turn, which is where every bridge holds its
 * strongest boundary.
 */
export function nativeAgentDenialsAreReadOnly(denied: Iterable<string>): boolean {
  const set = new Set(denied);
  return (
    set.has("file.write") && set.has("file.patch") && (set.has("shell.mutate") || set.has("shell"))
  );
}

/** What a bridge translates among the post-legacy capabilities. */
export type NativeAgentExtendedTranslation =
  "git.commit" | "git.push" | "github.write" | "subagents" | "mcp";

/**
 * What each current bridge translates natively, beyond the legacy six.
 *
 * Translating is not enforcing: Claude's and OpenCode's git and GitHub rules
 * match commands as written, so the enforcement matrix still rates them
 * advisory. This table decides only where a stand-in is needed. A bridge
 * older than this change ignores `extendedDeny` altogether, and for it the
 * post-hoc guards remain the backstop.
 */
export const NATIVE_AGENT_BRIDGE_EXTENDED_TRANSLATIONS: Readonly<
  Record<AgentPlatform, readonly NativeAgentExtendedTranslation[]>
> = Object.freeze({
  // `disallowedTools`: Task/Agent, `mcp__<server>__*`, `Bash(git push *)`.
  claude: Object.freeze(["git.commit", "git.push", "github.write", "subagents", "mcp"] as const),
  // Session permission rules: `task`, `<server>_*`, bash command patterns.
  opencode: Object.freeze(["git.commit", "git.push", "github.write", "subagents", "mcp"] as const),
  // `disallowedTools: ["task"]`. MCP is one tool group in its SDK.
  cursor: Object.freeze(["subagents"] as const),
  // Codex ignores tool lists; its only levers are the sandbox and config.
  codex: Object.freeze([] as const),
  // Grok's tool removal is a fixed agent profile for deny-policy children.
  grok: Object.freeze([] as const),
  // Pi applies no capability denial outside its read-only gate.
  pi: Object.freeze([] as const),
});

function extendedTranslationOf(capability: NativeAgentCapability): NativeAgentExtendedTranslation {
  return capability.startsWith("mcp:") ? "mcp" : (capability as NativeAgentExtendedTranslation);
}

/** How a denied capability is held on a platform once it reaches the bridge. */
export type NativeAgentCapabilityHold =
  /** The bridge translates it into its own SDK's terms. */
  | "bridge"
  /** A shell denial in the same policy already rules it out. */
  | "shell-denial"
  /** Repository configuration is switched off instead (`projectResources: false`). */
  | "project-resources"
  /** Nothing in the session stops it; a post-hoc guard detects it. */
  | "guard"
  /** The backend's credential scope, never the bridge (`orkestrator:<group>`). */
  | "backend"
  /** Not held anywhere; the denial is advice to the agent. */
  | "advisory";

/**
 * The nearest enforceable stand-in for a denied capability on a platform.
 *
 * - A legacy capability is always translated by the bridge.
 * - `git.commit`, `git.push` and `github.write` are covered by a shell
 *   denial when the policy allows no other mutation (it already denies
 *   `shell.mutate` or `shell`). Otherwise the shell may legitimately write
 *   (a verifier's builds, a builder's edits), so turning their denial into a
 *   `shell.mutate` denial would take that work away; the post-hoc guards
 *   (HEAD baseline, remote-ref check, withheld GitHub credential) hold them.
 * - `mcp:<server>` falls back to `projectResources: false`, which keeps the
 *   checkout's MCP configuration out but not the user's own servers.
 * - `subagents` has no stand-in: a sub-agent inherits its parent's sandbox
 *   and denials on every bridge that has one.
 */
export function nativeAgentCapabilityHold(
  platform: AgentPlatform,
  capability: NativeAgentCapability,
  denied: readonly string[],
): NativeAgentCapabilityHold {
  if (isLegacyNativeAgentCapability(capability)) return "bridge";
  if (capability.startsWith("orkestrator:")) return "backend";
  const remoteOrCommit =
    capability === "git.commit" || capability === "git.push" || capability === "github.write";
  if (remoteOrCommit && (denied.includes("shell") || denied.includes("shell.mutate"))) {
    return "shell-denial";
  }
  if (
    NATIVE_AGENT_BRIDGE_EXTENDED_TRANSLATIONS[platform].includes(extendedTranslationOf(capability))
  ) {
    return "bridge";
  }
  if (capability.startsWith("mcp:")) return "project-resources";
  if (remoteOrCommit) return "guard";
  return "advisory";
}

/**
 * The policy as it is sent to a bridge.
 *
 * `deny` and `allow` keep only the legacy names, so every released bridge
 * still validates the policy instead of dropping it. The other denials ride in
 * `extendedDeny` for bridges that read it. `orkestrator:<group>` never leaves
 * the backend. Where the target platform does not translate an `mcp:<server>`
 * denial, repository configuration is turned off as its stand-in; the git and
 * GitHub stand-ins need no change on the wire (`nativeAgentCapabilityHold`).
 * Idempotent, and the identity for a policy that uses only legacy names.
 */
export function nativeAgentPolicyForBridge(
  policy: NativeAgentExecutionPolicy,
  platform: AgentPlatform,
): NativeAgentExecutionPolicy {
  const capabilities = policy.capabilityPolicy;
  if (!capabilities) return policy;
  const denied = nativeAgentDeniedCapabilities(policy);
  const legacy = denied.filter(isLegacyNativeAgentCapability);
  const extended = denied
    .filter((capability) => !isLegacyNativeAgentCapability(capability))
    .filter((capability) => !capability.startsWith("orkestrator:"));
  if (
    extended.length === 0 &&
    legacy.length === capabilities.deny.length &&
    !capabilities.extendedDeny
  ) {
    return policy;
  }
  const projectResourcesStandIn = extended.some(
    (capability) => nativeAgentCapabilityHold(platform, capability, denied) === "project-resources",
  );
  const allow = capabilities.allow?.filter(isLegacyNativeAgentCapability);
  return {
    ...policy,
    ...(projectResourcesStandIn ? { projectResources: false } : {}),
    capabilityPolicy: {
      deny: legacy,
      ...(allow && allow.length > 0 ? { allow } : {}),
      ...(extended.length > 0 ? { extendedDeny: extended } : {}),
    },
  };
}

/**
 * Environment variables that hand a GitHub credential to `gh`, Git helpers
 * and GitHub MCP servers (`GITHUB_PERSONAL_ACCESS_TOKEN` is the official
 * GitHub plugin's header variable).
 */
export const GITHUB_CREDENTIAL_ENV_VARS = Object.freeze([
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GITHUB_PERSONAL_ACCESS_TOKEN",
] as const);

/**
 * Whether a session's environment must not carry the GitHub credential: its
 * policy denies `github.write` (every graph agent node, D12). Reading through
 * `gh` goes with it, because no environment variable separates a read token
 * from a write token.
 */
export function nativeAgentWithholdsGitHubCredential(
  policy: Pick<NativeAgentExecutionPolicy, "capabilityPolicy"> | undefined,
): boolean {
  return nativeAgentPolicyDenies(policy, "github.write");
}

/** Git credential helper lists an empty value resets (`gh auth setup-git` writes the scoped ones). */
const RESET_CREDENTIAL_HELPERS = Object.freeze([
  "credential.helper",
  "credential.https://github.com.helper",
  "credential.https://gist.github.com.helper",
]);

/**
 * A session environment without the GitHub credential, for a bridge that
 * builds one environment per session (item 209):
 *
 * - every {@link GITHUB_CREDENTIAL_ENV_VARS} entry is dropped, and so is
 *   `ORKESTRATOR_GITHUB_CREDENTIAL_FILE` (a container's managed token file);
 * - `GH_CONFIG_DIR` points at `ghConfigDir`, an empty directory the caller
 *   owns, so `gh` finds no stored login (its `hosts.yml` names the keychain
 *   entry it would read);
 * - Git's credential helpers are reset through `GIT_CONFIG_COUNT` entries
 *   (an empty `credential.helper` clears the inherited list), so an HTTPS
 *   push cannot borrow the keychain or `gh auth git-credential`.
 *
 * What it cannot withhold: SSH keys and agents, a token written into a
 * global Git `url.<…>.insteadOf` rewrite or a file the agent can read (a
 * container's runtime credential). The remote-ref guard is the backstop for
 * those. Pure: the input is not modified.
 */
export function withheldGitHubCredentialEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  options: { ghConfigDir: string },
): Record<string, string | undefined> {
  const next: Record<string, string | undefined> = { ...env };
  for (const name of GITHUB_CREDENTIAL_ENV_VARS) delete next[name];
  delete next.ORKESTRATOR_GITHUB_CREDENTIAL_FILE;
  next.GH_CONFIG_DIR = options.ghConfigDir;
  const inherited = Number.parseInt(next.GIT_CONFIG_COUNT ?? "", 10);
  let count = Number.isSafeInteger(inherited) && inherited > 0 ? inherited : 0;
  for (const key of RESET_CREDENTIAL_HELPERS) {
    next[`GIT_CONFIG_KEY_${count}`] = key;
    next[`GIT_CONFIG_VALUE_${count}`] = "";
    count += 1;
  }
  next.GIT_CONFIG_COUNT = String(count);
  return next;
}
