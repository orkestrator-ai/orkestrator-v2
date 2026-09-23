/**
 * Which native sources each provider reads, in which order, and what the
 * management feature can honestly promise about them.
 *
 * Paths mirror the launchers and bridges, not the vendors' documentation in
 * general: the Claude bridge reads `homedir()/.claude.json` regardless of
 * `CLAUDE_CONFIG_DIR`, so that is the file edited here; host Cursor and Pi
 * sessions never load project settings, so those sources are shown as
 * excluded. See docs/architecture/mcp-management.md for the evidence table.
 */

import os from "node:os";
import path from "node:path";

import { AGENT_PLATFORM_LABELS, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  MCP_MANAGEMENT_LIMITS,
  type McpCapabilityFlag,
  type McpTargetCapabilities,
  type McpTransport,
} from "@orkestrator/protocol/mcp-management";

import { PROVIDER_CODECS } from "./codecs.js";
import type { SourceSpec, TargetContextInfo } from "./types.js";

export interface ProviderHomes {
  home: string;
  codexHome: string;
  xdgConfigHome: string;
  piAgentDir: string;
  opencodeCustomConfig?: string;
}

function expandTilde(value: string, home: string): string {
  return value === "~" ? home : value.startsWith("~/") ? path.join(home, value.slice(2)) : value;
}

/** Resolve homes exactly as the backend's local launchers pass them to children. */
export function resolveProviderHomes(
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
): ProviderHomes {
  const codexHome = env.CODEX_HOME?.trim()
    ? path.resolve(expandTilde(env.CODEX_HOME.trim(), home))
    : path.join(home, ".codex");
  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim()
    ? path.resolve(env.XDG_CONFIG_HOME.trim())
    : path.join(home, ".config");
  // Host launches delete PI_AGENT_DIR, so the Pi SDK's own rule applies.
  const piAgentDir = env.PI_CODING_AGENT_DIR?.trim()
    ? path.resolve(expandTilde(env.PI_CODING_AGENT_DIR.trim(), home))
    : path.join(home, ".pi", "agent");
  const opencodeCustomConfig = env.OPENCODE_CONFIG?.trim()
    ? path.resolve(expandTilde(env.OPENCODE_CONFIG.trim(), home))
    : undefined;
  return { home, codexHome, xdgConfigHome, piAgentDir, opencodeCustomConfig };
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

export interface SourceContext {
  context: TargetContextInfo;
  homes: ProviderHomes;
  /** Existing-file probe, so optional sources only appear when present. */
  exists(filePath: string): Promise<boolean>;
  /** Read a Grok compat flag (`[compat.<name>] mcps = false`). */
  grokCompatDisabled(name: "claude" | "cursor", worktree?: string): Promise<boolean>;
}

export async function providerSources(
  provider: AgentPlatform,
  input: SourceContext,
): Promise<SourceSpec[]> {
  const { homes, context } = input;
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
      add(
        userSource("codex", "user", path.join(homes.codexHome, "config.toml"), homes, {
          format: "toml",
          subtree: ["mcp_servers"],
          precedence: 10,
        }),
      );
      if (worktree) {
        add(
          projectSource("codex", "project", worktree, path.join(".codex", "config.toml"), homes, {
            format: "toml",
            subtree: ["mcp_servers"],
            precedence: 20,
            trust: "unknown",
            trustReason:
              "Codex loads project configuration only for projects you have marked trusted in Codex.",
          }),
        );
      }
      break;
    }
    case "opencode": {
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
      if (worktree) {
        const projectFiles: Array<[string, "json" | "jsonc", number]> = [
          ["opencode.json", "json", 20],
          ["opencode.jsonc", "jsonc", 21],
        ];
        let any = false;
        for (const [name, format, precedence] of projectFiles) {
          if (await input.exists(path.join(worktree, name))) {
            any = true;
            add(
              projectSource("opencode", `project-${name}`, worktree, name, homes, {
                format,
                subtree: ["mcp"],
                precedence,
                trust: "allowed",
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
              trust: "allowed",
            }),
          );
        }
      }
      break;
    }
    case "cursor": {
      add(
        userSource("cursor", "user", path.join(homes.home, ".cursor", "mcp.json"), homes, {
          format: "json",
          subtree: ["mcpServers"],
          precedence: 10,
          maxBytes: 1024 * 1024,
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
    case "grok": {
      add(
        userSource("grok", "user", path.join(homes.home, ".grok", "config.toml"), homes, {
          format: "toml",
          subtree: ["mcp_servers"],
          precedence: 10,
        }),
      );
      if (worktree) {
        add(
          projectSource("grok", "project", worktree, path.join(".grok", "config.toml"), homes, {
            format: "toml",
            subtree: ["mcp_servers"],
            precedence: 20,
            trust: "unknown",
            trustReason:
              "Grok loads project configuration only for folders you have trusted in Grok.",
          }),
        );
      }
      const claudeOff = await input.grokCompatDisabled("claude", worktree);
      const cursorOff = await input.grokCompatDisabled("cursor", worktree);
      const compat = (spec: SourceSpec, off: boolean): SourceSpec => ({
        ...spec,
        scope: "compatibility",
        owner: "compatibility",
        writable: false,
        readOnlyReason: `Owned by ${spec.label}. Edit it from that provider, or add a Grok server with the same name to override it.`,
        excludedReason: off ? "Disabled by a [compat] setting in Grok's config.toml." : undefined,
        sharedWith: [],
      });
      add(
        compat(
          {
            ...userSource(
              "grok",
              "compat-claude-user",
              path.join(homes.home, ".claude.json"),
              homes,
              { format: "json", subtree: ["mcpServers"], precedence: 1 },
            ),
            label: "Claude Code user configuration",
          },
          claudeOff,
        ),
      );
      if (worktree) {
        add(
          compat(
            {
              ...projectSource("grok", "compat-claude-project", worktree, ".mcp.json", homes, {
                format: "json",
                subtree: ["mcpServers"],
                precedence: 2,
              }),
              label: "Claude Code project configuration",
            },
            claudeOff,
          ),
        );
        add(
          compat(
            {
              ...projectSource(
                "grok",
                "compat-cursor-project",
                worktree,
                path.join(".cursor", "mcp.json"),
                homes,
                { format: "json", subtree: ["mcpServers"], precedence: 3 },
              ),
              label: "Cursor project configuration",
            },
            cursorOff,
          ),
        );
      }
      break;
    }
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
  return build.sources;
}

/** Home layout inside Orkestrator's container image (user `node`). */
export const CONTAINER_HOMES: ProviderHomes = {
  home: "/home/node",
  codexHome: "/home/node/.codex",
  xdgConfigHome: "/home/node/.config",
  piAgentDir: "/home/node/.pi/agent",
};
export const CONTAINER_WORKSPACE = "/workspace";

/**
 * The container's own copies of provider configuration, read-only. Container
 * homes are copied from the backend user when the container is created and are
 * not a durable store of user intent, so editing them here would be lost on
 * recreation; see CONTAINER_READ_ONLY_REASON.
 */
export async function containerSources(
  provider: AgentPlatform,
  containerId: string,
  readOnlyReason: string,
): Promise<SourceSpec[]> {
  const specs = await providerSources(provider, {
    context: { kind: "environment", location: "local-worktree", worktreePath: CONTAINER_WORKSPACE },
    homes: CONTAINER_HOMES,
    exists: async () => false,
    grokCompatDisabled: async () => false,
  });
  return specs.map((spec) => {
    if (spec.format === "runtime") return spec;
    const inProject = spec.path.startsWith(`${CONTAINER_WORKSPACE}/`);
    return {
      ...spec,
      container: { containerId },
      writable: false,
      readOnlyReason: spec.owner === "compatibility" ? spec.readOnlyReason : readOnlyReason,
      allowedRoot: undefined,
      displayPath: inProject ? spec.path : `container:${spec.path}`,
      label:
        inProject || spec.owner === "compatibility"
          ? spec.label
          : spec.scope === "claude-local"
            ? "Container private local"
            : "Container home (copied from backend user)",
      // Container sessions opt into project resources; the host exclusions do not apply.
      ...(inProject && spec.owner !== "compatibility"
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
    "A saved enable switch has not been verified with the pinned Grok Build release.",
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
