/**
 * Which native sources each provider reads, in which order, and what the
 * management feature can honestly promise about them.
 *
 * Paths mirror the launchers, bridges and the pinned provider binaries, not
 * the vendors' documentation in general: the Claude bridge reads
 * `homedir()/.claude.json` regardless of `CLAUDE_CONFIG_DIR`, so that is the
 * file edited here; host Cursor and Pi sessions never load project settings,
 * so those sources are shown as excluded. Read-only layers the provider loads
 * (system and managed files, inline environment configuration, another
 * provider's file) are shown so an effective entry is never a surprise. See
 * docs/architecture/mcp-management.md for the evidence table.
 */

import os from "node:os";
import * as fs from "node:fs/promises";
import path from "node:path";

import { AGENT_PLATFORM_LABELS, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  MCP_MANAGEMENT_LIMITS,
  type McpCapabilityFlag,
  type McpTargetCapabilities,
  type McpTransport,
} from "@orkestrator/protocol/mcp-management";

import { PROVIDER_CODECS } from "./codecs.js";
import {
  codexProjectTrust,
  grokCompat,
  grokFolderTrust,
  readHostText,
  type GrokPolicyInput,
  type TextReader,
  type TrustVerdict,
} from "./native-policy.js";
import type { ContainerFileReader, SourceSpec, TargetContextInfo } from "./types.js";

export interface ProviderHomes {
  home: string;
  codexHome: string;
  xdgConfigHome: string;
  piAgentDir: string;
  opencodeCustomConfig?: string;
  /** `$GROK_HOME`, default `~/.grok`. */
  grokHome?: string;
  /** System directories; fixed paths, overridable only for tests. */
  codexSystemDir?: string;
  grokSystemDir?: string;
  opencodeManagedDir?: string;
  /** `$OPENCODE_CONFIG_DIR`, an extra configuration directory. */
  opencodeConfigDir?: string;
  /** `$OPENCODE_CONFIG_CONTENT`: inline configuration. May carry secrets; never logged. */
  opencodeConfigContent?: string;
  /** `$OPENCODE_DISABLE_PROJECT_CONFIG` is `true` or `1`. */
  opencodeDisableProjectConfig?: boolean;
  /** Grok's documented environment switches, verbatim. */
  grokEnv?: GrokPolicyInput["env"];
}

function expandTilde(value: string, home: string): string {
  return value === "~" ? home : value.startsWith("~/") ? path.join(home, value.slice(2)) : value;
}

function envPath(value: string | undefined, home: string): string | undefined {
  return value?.trim() ? path.resolve(expandTilde(value.trim(), home)) : undefined;
}

/** Resolve homes exactly as the backend's local launchers pass them to children. */
export function resolveProviderHomes(
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
): ProviderHomes {
  const codexHome = envPath(env.CODEX_HOME, home) ?? path.join(home, ".codex");
  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim()
    ? path.resolve(env.XDG_CONFIG_HOME.trim())
    : path.join(home, ".config");
  // Host launches delete PI_AGENT_DIR, so the Pi SDK's own rule applies.
  const piAgentDir = envPath(env.PI_CODING_AGENT_DIR, home) ?? path.join(home, ".pi", "agent");
  return {
    home,
    codexHome,
    xdgConfigHome,
    piAgentDir,
    opencodeCustomConfig: envPath(env.OPENCODE_CONFIG, home),
    grokHome: envPath(env.GROK_HOME, home) ?? path.join(home, ".grok"),
    opencodeConfigDir: envPath(env.OPENCODE_CONFIG_DIR, home),
    opencodeConfigContent: env.OPENCODE_CONFIG_CONTENT?.trim()
      ? env.OPENCODE_CONFIG_CONTENT
      : undefined,
    // OpenCode's flag parser: true only for "true" or "1", case-insensitively.
    opencodeDisableProjectConfig: /^(true|1)$/i.test(
      env.OPENCODE_DISABLE_PROJECT_CONFIG?.trim() ?? "",
    ),
    grokEnv: {
      claudeMcps: env.GROK_CLAUDE_MCPS_ENABLED,
      cursorMcps: env.GROK_CURSOR_MCPS_ENABLED,
      folderTrust: env.GROK_FOLDER_TRUST,
    },
  };
}

function display(filePath: string, homes: ProviderHomes, worktree?: string): string {
  if (worktree && (filePath === worktree || filePath.startsWith(`${worktree}${path.sep}`))) {
    return `<worktree>${filePath.slice(worktree.length)}`;
  }
  if (filePath === homes.home || filePath.startsWith(`${homes.home}${path.sep}`))
    return `~${filePath.slice(homes.home.length)}`;
  return filePath;
}

const PRIVATE_FILE = 0o600;
const PROJECT_FILE = 0o644;
const GENERAL_MAX = MCP_MANAGEMENT_LIMITS.sourceFileMaxBytes;

/** Names each provider's launch path injects. Never persisted, never editable. */
export const INJECTED_SERVER_NAMES: Readonly<Record<AgentPlatform, readonly string[]>> =
  Object.freeze({
    claude: ["orkestrator", "orkestrator-design"],
    codex: ["orkestrator", "orkestrator-design"],
    opencode: ["orkestrator", "orkestrator_workflow_result"],
    cursor: ["orkestrator"],
    grok: ["orkestrator"],
    pi: ["orkestrator"],
  });

function injectedSource(provider: AgentPlatform): SourceSpec {
  return {
    sourceId: `${provider}:injected`,
    provider,
    scope: "injected",
    owner: "orkestrator",
    format: "runtime",
    label: "Orkestrator (injected at launch)",
    path: "",
    displayPath: "Added by Orkestrator for each session",
    subtree: [],
    precedence: 1000,
    writable: false,
    readOnlyReason:
      "Orkestrator adds this connection with a per-session credential; it is never saved to a file.",
    sharedWith: [],
    maxBytes: 0,
    createMode: PRIVATE_FILE,
    runtimeNames: [...INJECTED_SERVER_NAMES[provider]],
  };
}

interface SourceBuild {
  sources: SourceSpec[];
}

function userSource(
  provider: AgentPlatform,
  key: string,
  filePath: string,
  homes: ProviderHomes,
  spec: Partial<SourceSpec> & Pick<SourceSpec, "format" | "subtree" | "precedence">,
): SourceSpec {
  return {
    sourceId: `${provider}:${key}`,
    provider,
    scope: "backend-user",
    owner: "native-user",
    label: "Backend user",
    path: filePath,
    displayPath: display(filePath, homes),
    writable: true,
    sharedWith: [],
    maxBytes: GENERAL_MAX,
    createMode: PRIVATE_FILE,
    ...spec,
  };
}

function projectSource(
  provider: AgentPlatform,
  key: string,
  worktree: string,
  relative: string,
  homes: ProviderHomes,
  spec: Partial<SourceSpec> & Pick<SourceSpec, "format" | "subtree" | "precedence">,
): SourceSpec {
  const filePath = path.join(worktree, relative);
  return {
    sourceId: `${provider}:${key}`,
    provider,
    scope: "project",
    owner: "native-project",
    label: "Project (this worktree)",
    path: filePath,
    displayPath: display(filePath, homes, worktree),
    writable: true,
    sharedWith: [],
    maxBytes: GENERAL_MAX,
    allowedRoot: worktree,
    createMode: PROJECT_FILE,
    ...spec,
  };
}

/** A file an administrator (or the system) owns. Shown, never edited here. */
function managedSource(
  provider: AgentPlatform,
  key: string,
  filePath: string,
  homes: ProviderHomes,
  spec: Partial<SourceSpec> & Pick<SourceSpec, "format" | "subtree" | "precedence" | "label">,
): SourceSpec {
  return {
    sourceId: `${provider}:${key}`,
    provider,
    scope: "managed",
    owner: "managed-policy",
    path: filePath,
    displayPath: display(filePath, homes),
    writable: false,
    readOnlyReason:
      "Managed configuration outside your user files; change it where it is administered.",
    sharedWith: [],
    maxBytes: GENERAL_MAX,
    createMode: PRIVATE_FILE,
    ...spec,
  };
}

/** Project trust fields for a source, from a provider's own trust decision. */
function trustFields(
  verdict: TrustVerdict,
): Pick<SourceSpec, "trust" | "trustReason" | "excludedReason"> {
  return {
    trust: verdict.trust,
    trustReason: verdict.reason,
    excludedReason: verdict.trust === "excluded" ? verdict.reason : undefined,
  };
}

export interface SourceContext {
  context: TargetContextInfo;
  homes: ProviderHomes;
  /** Existing-file probe, so optional sources only appear when present. */
  exists(filePath: string): Promise<boolean>;
  /** Bounded read of provider policy files (trust, compat). Defaults to the host. */
  readText?: TextReader;
  /**
   * Ignored. Grok's `[compat.*] mcps` switches are resolved in this module
   * (env, requirements, user config, managed config), not by the caller.
   */
  grokCompatDisabled?(name: "claude" | "cursor", worktree?: string): Promise<boolean>;
  /** Container catalogs: project trust is the container's, not the host's. */
  inContainer?: boolean;
}

const OPENCODE_FILES: ReadonlyArray<["opencode.json" | "opencode.jsonc", "json" | "jsonc"]> = [
  ["opencode.json", "json"],
  ["opencode.jsonc", "jsonc"],
];

async function opencodeSources(
  input: SourceContext,
  worktree: string | undefined,
  add: (spec: SourceSpec) => void,
): Promise<void> {
  const { homes } = input;
  const dir = path.join(homes.xdgConfigHome, "opencode");
  const candidates: Array<[string, "json" | "jsonc", number]> = [
    ["config.json", "json", 10],
    ["opencode.json", "json", 11],
    ["opencode.jsonc", "jsonc", 12],
  ];
  const present: SourceSpec[] = [];
  for (const [name, format, precedence] of candidates) {
    const filePath = path.join(dir, name);
    if (await input.exists(filePath)) {
      present.push(
        userSource("opencode", `user-${name}`, filePath, homes, {
          format,
          subtree: ["mcp"],
          precedence,
        }),
      );
    }
  }
  if (!present.length) {
    present.push(
      userSource("opencode", "user-opencode.json", path.join(dir, "opencode.json"), homes, {
        format: "json",
        subtree: ["mcp"],
        precedence: 11,
      }),
    );
  }
  for (const spec of present) add(spec);
  if (homes.opencodeCustomConfig) {
    add({
      ...userSource("opencode", "custom", homes.opencodeCustomConfig, homes, {
        format: homes.opencodeCustomConfig.endsWith(".jsonc") ? "jsonc" : "json",
        subtree: ["mcp"],
        precedence: 15,
      }),
      label: "Custom config (OPENCODE_CONFIG)",
    });
  }
  const projectPolicy: Partial<SourceSpec> = homes.opencodeDisableProjectConfig
    ? {
        trust: "excluded",
        trustReason:
          "OPENCODE_DISABLE_PROJECT_CONFIG is set for this backend, so OpenCode ignores project configuration.",
        excludedReason:
          "Excluded: OPENCODE_DISABLE_PROJECT_CONFIG is set for this backend, so OpenCode ignores project configuration.",
      }
    : { trust: "allowed" };
  const projectDir = worktree ? path.join(worktree, ".opencode") : undefined;
  if (worktree) {
    // The session runs at the worktree root, which is also where OpenCode's
    // upward search stops, so the root is the only project directory.
    let any = false;
    for (const [[name, format], precedence] of OPENCODE_FILES.map(
      (file, i) => [file, 20 + i] as const,
    )) {
      if (await input.exists(path.join(worktree, name))) {
        any = true;
        add(
          projectSource("opencode", `project-${name}`, worktree, name, homes, {
            format,
            subtree: ["mcp"],
            precedence,
            ...projectPolicy,
          }),
        );
      }
    }
    if (!any) {
      add(
        projectSource("opencode", "project-opencode.json", worktree, "opencode.json", homes, {
          format: "json",
          subtree: ["mcp"],
          precedence: 20,
          ...projectPolicy,
        }),
      );
    }
    for (const [[name, format], precedence] of OPENCODE_FILES.map(
      (file, i) => [file, 30 + i] as const,
    )) {
      if (await input.exists(path.join(projectDir!, name))) {
        add(
          projectSource(
            "opencode",
            `project-dir-${name}`,
            worktree,
            path.join(".opencode", name),
            homes,
            {
              format,
              subtree: ["mcp"],
              precedence,
              label: "Project .opencode directory",
              ...projectPolicy,
            },
          ),
        );
      }
    }
  }
  // Configuration directories load after project files, so they win over them.
  const homeDir = path.join(homes.home, ".opencode");
  const directories: Array<[string, string, string, number]> = [
    [homeDir, "home-dir", "~/.opencode directory", 32],
  ];
  if (
    homes.opencodeConfigDir &&
    homes.opencodeConfigDir !== homeDir &&
    homes.opencodeConfigDir !== projectDir
  ) {
    directories.push([
      homes.opencodeConfigDir,
      "config-dir",
      "Config directory (OPENCODE_CONFIG_DIR)",
      34,
    ]);
  }
  for (const [directory, key, label, base] of directories) {
    for (const [[name, format], precedence] of OPENCODE_FILES.map(
      (file, i) => [file, base + i] as const,
    )) {
      const filePath = path.join(directory, name);
      if (await input.exists(filePath)) {
        add({
          ...userSource("opencode", `${key}-${name}`, filePath, homes, {
            format,
            subtree: ["mcp"],
            precedence,
          }),
          label,
        });
      }
    }
  }
  if (homes.opencodeConfigContent !== undefined) {
    add({
      ...userSource("opencode", "inline", "", homes, {
        format: "jsonc",
        subtree: ["mcp"],
        precedence: 40,
      }),
      label: "Inline config (OPENCODE_CONFIG_CONTENT)",
      displayPath: "OPENCODE_CONFIG_CONTENT environment variable",
      writable: false,
      readOnlyReason:
        "Set by the OPENCODE_CONFIG_CONTENT environment variable of this backend; change it where the backend is started.",
      inlineText: homes.opencodeConfigContent,
    });
  }
  const managedDir = homes.opencodeManagedDir ?? "/etc/opencode";
  for (const [[name, format], precedence] of OPENCODE_FILES.map(
    (file, i) => [file, 50 + i] as const,
  )) {
    const filePath = path.join(managedDir, name);
    if (await input.exists(filePath)) {
      add(
        managedSource("opencode", `managed-${name}`, filePath, homes, {
          format,
          subtree: ["mcp"],
          precedence,
          label: "Managed configuration",
        }),
      );
    }
  }
}

async function grokSources(
  input: SourceContext,
  worktree: string | undefined,
  add: (spec: SourceSpec) => void,
): Promise<void> {
  const { homes } = input;
  const read = input.readText ?? readHostText;
  const grokHome = homes.grokHome ?? path.join(homes.home, ".grok");
  const policy: GrokPolicyInput = {
    grokHome,
    systemDir: homes.grokSystemDir ?? "/etc/grok",
    env: homes.grokEnv ?? {},
  };
  const managedFiles: Array<[string, string, string, number]> = [
    [
      path.join(policy.systemDir, "managed_config.toml"),
      "managed-system",
      "System managed configuration",
      6,
    ],
    [path.join(grokHome, "managed_config.toml"), "managed-user", "Managed configuration", 7],
  ];
  for (const [filePath, key, label, precedence] of managedFiles) {
    if (await input.exists(filePath)) {
      add(
        managedSource("grok", key, filePath, homes, {
          format: "toml",
          subtree: ["mcp_servers"],
          precedence,
          label,
          readOnlyReason:
            "Grok's managed configuration; your own config.toml overrides it. Add a Grok server with the same name to replace an entry.",
        }),
      );
    }
  }
  add(
    userSource("grok", "user", path.join(grokHome, "config.toml"), homes, {
      format: "toml",
      subtree: ["mcp_servers"],
      precedence: 10,
    }),
  );
  let projectTrust: TrustVerdict | undefined;
  if (worktree) {
    projectTrust = input.inContainer ? undefined : await grokFolderTrust(policy, worktree, read);
    add(
      projectSource("grok", "project", worktree, path.join(".grok", "config.toml"), homes, {
        format: "toml",
        subtree: ["mcp_servers"],
        precedence: 20,
        ...(projectTrust
          ? trustFields(projectTrust)
          : {
              trust: "unknown",
              trustReason:
                "Grok loads project configuration only for folders you have trusted in Grok.",
            }),
      }),
    );
  }
  const claude = await grokCompat("claude", policy, read);
  const cursor = await grokCompat("cursor", policy, read);
  const compat = (
    spec: SourceSpec,
    owner: string,
    enabled: { enabled: boolean; source?: string } | null,
  ): SourceSpec => {
    const inProject = spec.scope === "project";
    const excluded =
      enabled && !enabled.enabled
        ? `Excluded: turned off by ${enabled.source ?? "a Grok compatibility setting"}.`
        : inProject && projectTrust?.trust === "excluded"
          ? `Excluded: ${projectTrust.reason}`
          : undefined;
    return {
      ...spec,
      scope: "compatibility",
      owner: "compatibility",
      writable: false,
      readOnlyReason: `Owned by ${owner}. Edit it from that provider, or add a Grok server with the same name to override it.`,
      excludedReason: excluded,
      trust: inProject ? (projectTrust?.trust ?? spec.trust) : undefined,
      trustReason: inProject ? projectTrust?.reason : undefined,
      sharedWith: [],
    };
  };
  // Grok's documented order: config.toml > Claude > Cursor > `.mcp.json`.
  if (worktree) {
    add(
      compat(
        {
          ...projectSource("grok", "compat-project-mcp-json", worktree, ".mcp.json", homes, {
            format: "json",
            subtree: ["mcpServers"],
            precedence: 1,
          }),
          label: "Project .mcp.json",
        },
        "the project's .mcp.json (Claude Code's project file); Grok reads it unless you imported or dismissed its Claude import prompt",
        null,
      ),
    );
  }
  add(
    compat(
      {
        ...userSource(
          "grok",
          "compat-cursor-user",
          path.join(homes.home, ".cursor", "mcp.json"),
          homes,
          {
            format: "json",
            subtree: ["mcpServers"],
            precedence: 2,
          },
        ),
        label: "Cursor user configuration",
      },
      "Cursor's user configuration",
      cursor,
    ),
  );
  if (worktree) {
    add(
      compat(
        {
          ...projectSource(
            "grok",
            "compat-cursor-project",
            worktree,
            path.join(".cursor", "mcp.json"),
            homes,
            {
              format: "json",
              subtree: ["mcpServers"],
              precedence: 3,
            },
          ),
          label: "Cursor project configuration",
        },
        "Cursor's project configuration",
        cursor,
      ),
    );
  }
  const claudeFile = path.join(homes.home, ".claude.json");
  add(
    compat(
      {
        ...userSource("grok", "compat-claude-user", claudeFile, homes, {
          format: "json",
          subtree: ["mcpServers"],
          precedence: 4,
        }),
        label: "Claude Code user configuration",
      },
      "Claude Code's user configuration",
      claude,
    ),
  );
  if (worktree) {
    add(
      compat(
        {
          ...userSource("grok", "compat-claude-local", claudeFile, homes, {
            format: "json",
            subtree: ["projects", worktree, "mcpServers"],
            precedence: 5,
          }),
          label: "Claude Code private local configuration",
          displayPath: `${display(claudeFile, homes)} → projects[<worktree>]`,
        },
        "Claude Code's private local configuration",
        claude,
      ),
    );
  }
}

export async function providerSources(
  provider: AgentPlatform,
  input: SourceContext,
): Promise<SourceSpec[]> {
  const { homes, context } = input;
  const read = input.readText ?? readHostText;
  const worktree = context.location === "local-worktree" ? context.worktreePath : undefined;
  const build: SourceBuild = { sources: [] };
  const add = (spec: SourceSpec) => build.sources.push(spec);
  switch (provider) {
    case "claude": {
      const file = path.join(homes.home, ".claude.json");
      add(
        userSource("claude", "user", file, homes, {
          format: "json",
          subtree: ["mcpServers"],
          precedence: 10,
          sharedWith: ["grok"],
        }),
      );
      if (worktree) {
        add({
          ...userSource("claude", "local", file, homes, {
            format: "json",
            subtree: ["projects", worktree, "mcpServers"],
            precedence: 20,
          }),
          scope: "claude-local",
          owner: "native-local",
          label: "Private local (this worktree)",
          displayPath: `${display(file, homes)} → projects[<worktree>]`,
          trust: "allowed",
          trustReason: "Private to you; not committed with the project.",
          sharedWith: ["grok"],
        });
        add(
          projectSource("claude", "project", worktree, ".mcp.json", homes, {
            format: "json",
            subtree: ["mcpServers"],
            precedence: 30,
            sharedWith: ["grok"],
            trust: "allowed",
            trustReason:
              "Loaded by native sessions; coordinator and review sessions exclude project servers.",
          }),
        );
      }
      break;
    }
    case "codex": {
      const systemDir = homes.codexSystemDir ?? "/etc/codex";
      const system = path.join(systemDir, "config.toml");
      if (await input.exists(system)) {
        add(
          managedSource("codex", "system", system, homes, {
            format: "toml",
            subtree: ["mcp_servers"],
            precedence: 5,
            label: "System configuration",
            readOnlyReason:
              "Codex's system configuration; your own config.toml overrides it field by field.",
          }),
        );
      }
      add(
        userSource("codex", "user", path.join(homes.codexHome, "config.toml"), homes, {
          format: "toml",
          subtree: ["mcp_servers"],
          precedence: 10,
        }),
      );
      if (worktree) {
        const verdict = input.inContainer
          ? undefined
          : await codexProjectTrust(homes.codexHome, worktree, read);
        add(
          projectSource("codex", "project", worktree, path.join(".codex", "config.toml"), homes, {
            format: "toml",
            subtree: ["mcp_servers"],
            precedence: 20,
            ...(verdict
              ? trustFields(verdict)
              : {
                  trust: "unknown",
                  trustReason:
                    "Codex loads project configuration only for projects you have marked trusted in Codex.",
                }),
          }),
        );
      }
      const managed = path.join(systemDir, "managed_config.toml");
      if (await input.exists(managed)) {
        add(
          managedSource("codex", "managed", managed, homes, {
            format: "toml",
            subtree: ["mcp_servers"],
            precedence: 30,
            label: "Managed configuration",
          }),
        );
      }
      break;
    }
    case "opencode":
      await opencodeSources(input, worktree, add);
      break;
    case "cursor": {
      add(
        userSource("cursor", "user", path.join(homes.home, ".cursor", "mcp.json"), homes, {
          format: "json",
          subtree: ["mcpServers"],
          precedence: 10,
          maxBytes: 1024 * 1024,
          sharedWith: ["grok"],
        }),
      );
      if (worktree) {
        add(
          projectSource("cursor", "project", worktree, path.join(".cursor", "mcp.json"), homes, {
            format: "json",
            subtree: ["mcpServers"],
            precedence: 20,
            maxBytes: 1024 * 1024,
            sharedWith: ["grok"],
            trust: "excluded",
            trustReason:
              "Host Cursor sessions do not load project settings, so cloning a repository cannot run its servers on this computer.",
            excludedReason:
              "Excluded on this computer: host Cursor sessions do not load project settings.",
          }),
        );
      }
      break;
    }
    case "grok":
      await grokSources(input, worktree, add);
      break;
    case "pi": {
      add(
        userSource("pi", "user", path.join(homes.piAgentDir, "mcp.json"), homes, {
          format: "json",
          subtree: ["mcpServers"],
          bareMapFallback: true,
          precedence: 10,
          maxBytes: 1024 * 1024,
        }),
      );
      if (worktree) {
        add(
          projectSource("pi", "project", worktree, path.join(".pi", "mcp.json"), homes, {
            format: "json",
            subtree: ["mcpServers"],
            bareMapFallback: true,
            precedence: 20,
            maxBytes: 1024 * 1024,
            trust: "excluded",
            trustReason:
              "Host Pi sessions do not load project resources; a Pi project server is arbitrary code.",
            excludedReason:
              "Excluded on this computer: host Pi sessions do not load project resources.",
          }),
        );
      }
      break;
    }
  }
  add(injectedSource(provider));
  if (provider === "opencode") {
    const seen = new Set<string>();
    const unique: SourceSpec[] = [];
    for (const spec of build.sources) {
      const resolved =
        spec.format === "runtime"
          ? spec.path
          : await fs.realpath(spec.path).catch(() => path.resolve(spec.path));
      const key = `${resolved}\u0000${spec.subtree.join("/")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(spec);
    }
    return unique;
  }
  return build.sources;
}

/** Home layout inside Orkestrator's container image (user `node`). */
export const CONTAINER_HOMES: ProviderHomes = {
  home: "/home/node",
  codexHome: "/home/node/.codex",
  xdgConfigHome: "/home/node/.config",
  piAgentDir: "/home/node/.pi/agent",
  grokHome: "/home/node/.grok",
};
export const CONTAINER_WORKSPACE = "/workspace";

/**
 * Container sources the entrypoint fills from the backend user's own files
 * (docker/entrypoint.sh). Everything else in a container home is the
 * container's own file.
 */
function copiedFromBackend(spec: SourceSpec): boolean {
  return (
    spec.sourceId === "claude:user" ||
    spec.sourceId === "codex:user" ||
    spec.sourceId.startsWith("opencode:user-") ||
    spec.sourceId === "grok:user" ||
    spec.sourceId === "pi:user"
  );
}

export const CONTAINER_OWN_FILE_REASON =
  "This is the container's own file. Orkestrator does not copy it from the backend user, so editing the " +
  "backend user's copy does not change it.";

function containerProbes(
  containerId: string,
  reader: ContainerFileReader | undefined,
): Pick<SourceContext, "exists" | "readText"> {
  if (!reader) return { exists: async () => false, readText: async () => null };
  return {
    exists: async (filePath) => {
      try {
        const result = await reader(containerId, filePath, 0);
        return result.state === "ok" || result.state === "oversized";
      } catch {
        return false;
      }
    },
    readText: async (filePath) => {
      try {
        const result = await reader(containerId, filePath, GENERAL_MAX);
        if (result.state !== "ok") return null;
        return new TextDecoder("utf-8", { fatal: true }).decode(result.bytes);
      } catch {
        return null;
      }
    },
  };
}

/**
 * The container's own copies of provider configuration, read-only. Container
 * homes are copied from the backend user when the container is created and are
 * not a durable store of user intent, so editing them here would be lost on
 * recreation; see CONTAINER_READ_ONLY_REASON. With a reader, optional files
 * (OpenCode's alternate names, Grok's compat switches) are probed inside the
 * container; without one, only the default files are listed.
 */
export async function containerSources(
  provider: AgentPlatform,
  containerId: string,
  readOnlyReason: string,
  reader?: ContainerFileReader,
): Promise<SourceSpec[]> {
  const specs = await providerSources(provider, {
    context: { kind: "environment", location: "local-worktree", worktreePath: CONTAINER_WORKSPACE },
    homes: CONTAINER_HOMES,
    inContainer: true,
    ...containerProbes(containerId, reader),
  });
  return specs.map((spec) => {
    if (spec.format === "runtime") return spec;
    const inProject = spec.path.startsWith(`${CONTAINER_WORKSPACE}/`);
    const compat = spec.owner === "compatibility";
    const copied = copiedFromBackend(spec);
    return {
      ...spec,
      container: { containerId },
      writable: false,
      readOnlyReason:
        compat || spec.owner === "managed-policy"
          ? spec.readOnlyReason
          : inProject || copied || spec.scope === "claude-local"
            ? readOnlyReason
            : `${CONTAINER_OWN_FILE_REASON} ${readOnlyReason}`,
      allowedRoot: undefined,
      displayPath: inProject ? spec.path : `container:${spec.path}`,
      label:
        inProject || compat
          ? spec.label
          : spec.scope === "claude-local"
            ? "Container private local"
            : spec.owner === "managed-policy"
              ? `Container ${spec.label.toLowerCase()}`
              : copied
                ? "Container home (copied from backend user)"
                : "Container home (container's own file)",
      // Container sessions opt into project resources; the host exclusions do not apply.
      ...(inProject && !compat
        ? {
            trust: "allowed" as const,
            trustReason: "Loaded by sessions in this container.",
            excludedReason: undefined,
          }
        : {}),
    };
  });
}

const flag = (supported: boolean, reason?: string): McpCapabilityFlag =>
  supported ? { supported } : { supported, reason };

const TRANSPORTS: Record<AgentPlatform, Record<McpTransport, McpCapabilityFlag>> = {
  claude: {
    stdio: flag(true),
    http: flag(true),
    sse: flag(false, "Orkestrator's Claude runtime does not load SSE servers; use HTTP."),
  },
  codex: {
    stdio: flag(true),
    http: flag(true),
    sse: flag(false, "Codex supports stdio and streamable HTTP servers only."),
  },
  opencode: {
    stdio: flag(true),
    http: flag(true),
    sse: flag(false, "OpenCode remote servers negotiate their transport; choose HTTP."),
  },
  cursor: { stdio: flag(true), http: flag(true), sse: flag(true) },
  grok: {
    stdio: flag(true),
    http: flag(true),
    sse: flag(false, "SSE has not been verified with the pinned Grok Build release."),
  },
  pi: {
    stdio: flag(true),
    http: flag(true),
    sse: flag(
      false,
      "Pi's MCP client speaks Streamable HTTP; a separate SSE client is not implemented.",
    ),
  },
};

const APPLY: Record<AgentPlatform, McpTargetCapabilities["apply"]> = {
  claude: {
    strategy: "next-query",
    impact: "session",
    description:
      "Claude re-reads MCP configuration for every message, so open sessions use the change from their next message.",
  },
  codex: {
    strategy: "process-reload",
    impact: "environment-process",
    description:
      "Codex reloads MCP configuration for the environment's whole app-server once no turn is running; threads use it from their next turn.",
  },
  opencode: {
    strategy: "directory-restart",
    impact: "directory",
    description:
      "OpenCode reads configuration when its server starts; the change applies after the environment's OpenCode server restarts.",
  },
  cursor: {
    strategy: "idle-reattach",
    impact: "session",
    description:
      "The Cursor bridge reattaches a session with fresh settings before its next message; the conversation is kept.",
  },
  grok: {
    strategy: "next-load",
    impact: "environment-process",
    description:
      "Grok Build loads MCP configuration when its process starts; the change applies after the environment's Grok process restarts.",
  },
  pi: {
    strategy: "generation-rebuild",
    impact: "session",
    description:
      "The Pi bridge rebuilds its MCP connections and tools before a session's next message; the conversation is kept.",
  },
};

const TERMINAL: Record<AgentPlatform, McpTargetCapabilities["terminal"]> = {
  claude: {
    readsNativeConfig: true,
    guidance:
      "Running Claude terminals keep their servers; restart the terminal session to load changes.",
  },
  codex: {
    readsNativeConfig: true,
    guidance:
      "Running Codex terminals keep their servers; restart the terminal session to load changes.",
  },
  opencode: {
    readsNativeConfig: true,
    guidance:
      "Running OpenCode terminals keep their servers; restart the terminal session to load changes.",
  },
  cursor: { readsNativeConfig: false, guidance: "Cursor has no terminal mode in Orkestrator." },
  grok: {
    readsNativeConfig: true,
    guidance:
      "Running Grok terminals keep their servers; restart the terminal session to load changes.",
  },
  pi: {
    readsNativeConfig: false,
    guidance: "Pi terminals have no MCP client; these servers are used by native Pi sessions only.",
  },
};

const SIGN_IN: Record<AgentPlatform, McpCapabilityFlag> = {
  claude: flag(true),
  codex: flag(true),
  opencode: flag(true),
  cursor: flag(
    false,
    "Sign in to the server from Cursor itself; the Cursor SDK reuses that authorization.",
  ),
  grok: flag(false, "Grok Build's MCP sign-in is not exposed to Orkestrator."),
  pi: flag(false, "Pi's MCP client has no OAuth support; use a header or environment variable."),
};

const ENABLED_FLAG: Record<AgentPlatform, McpCapabilityFlag> = {
  claude: flag(
    false,
    "Claude Code has no saved per-server switch; remove the server or use the session's connection toggle.",
  ),
  codex: flag(true),
  opencode: flag(true),
  cursor: flag(false, "Cursor stores its enable switch outside mcp.json."),
  grok: flag(
    false,
    "Grok's saved enable switch is shown, but changing it from Orkestrator has not been verified with the pinned Grok Build release; use `grok mcp enable` or `grok mcp disable`.",
  ),
  pi: flag(true),
};

const CWD_FLAG: Record<AgentPlatform, McpCapabilityFlag> = {
  claude: flag(false, "Claude Code starts servers in the session's working directory."),
  codex: flag(true),
  opencode: flag(true),
  cursor: flag(true),
  grok: flag(false, "Not supported by Grok Build's configuration."),
  pi: flag(false, "Pi starts servers in the session's working directory."),
};

export function providerCapabilities(
  provider: AgentPlatform,
  readOnlyReason?: string,
): McpTargetCapabilities {
  const codec = PROVIDER_CODECS[provider];
  const write = readOnlyReason ? flag(false, readOnlyReason) : flag(true);
  return {
    management: write,
    transports: TRANSPORTS[provider],
    operations: {
      add: write,
      update: write,
      rename: write,
      remove: write,
      setEnabled: readOnlyReason ? write : ENABLED_FLAG[provider],
    },
    fields: {
      env: flag(true),
      headers: flag(true),
      cwd: CWD_FLAG[provider],
      advanced: codec.advancedFields,
    },
    authentication: {
      staticHeaders: true,
      envReferences: true,
      runtimeSignIn: SIGN_IN[provider],
    },
    apply: APPLY[provider],
    terminal: TERMINAL[provider],
    nameRule: codec.nameRule,
  };
}

export function providerLabel(provider: AgentPlatform): string {
  return AGENT_PLATFORM_LABELS[provider];
}
