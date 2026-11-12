/**
 * Coordinators on OpenCode (docs/todo/agent-engines/0008-opencode-v2.md,
 * owner decision 4).
 *
 * A coordinator conversation's OpenCode server is its own process (the
 * conversation's `opencode` local server, keyed by its runtime id), so the
 * read-only policy is held by that process rather than by any session record:
 *
 * - **Launch authority** ({@link openCode2CoordinatorLaunchEnv}). The server
 *   is started with `ORKESTRATOR_BRIDGE_EXECUTION_POLICY=coordinator-read-only`,
 *   the data directory to protect, the research setting of the moment and
 *   `OPENCODE_DISABLE_PROJECT_CONFIG=1`, so the checkout's `opencode.json`,
 *   `.opencode/` agents, commands, plugins and MCP servers never load (2.2.6's
 *   `config.project`). Its configuration directory holds the credential
 *   plugin and the coordinator guard (`coordinator-plugin.ts`), which refuses
 *   every tool outside the read-only set and every read of the data
 *   directory, in the server process, whatever a session's stored rules say.
 * - **Backend authority** ({@link OpenCode2CoordinatorAuthority}). The
 *   connection of that server carries the policy it was launched with. The
 *   provider built for it ignores a request's policy and a session's stored
 *   base rules: every create, resume, policy synchronization and turn writes
 *   the rules computed here and reads them back before the prompt
 *   (`turn-grants.ts`), pins the `plan` agent and refuses provider commands.
 * - **Tools.** The conversation's Control MCP credential (the one the
 *   supervisor issued for the server's launch, held beside the process) is
 *   registered as the location's `orkestrator` server, and the research
 *   servers named at launch as theirs; their tools are allowed by exact id.
 *
 * A changed research setting replaces an idle coordinator server (the
 * supervisor compares the launch's research signature); a busy one keeps its
 * launch setting until it is idle.
 */
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import {
  COORDINATOR_EXECUTION_POLICY,
  COORDINATOR_PROTECTED_DATA_DIR_ENV,
} from "@orkestrator/protocol/coordinator";
import {
  coordinatorWebResearchEnv,
  type CoordinatorResearchMcpServer,
  type CoordinatorWebResearch,
} from "@orkestrator/protocol/coordinator-web-research";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import {
  PromptRejectedError,
  ProviderDispatchPreparationError,
  type ProviderSendOptions,
} from "../agent-provider-contract.js";
import { ORKESTRATOR_AGENT_MCP_SERVER_NAME } from "../agent-tools.js";
import { resolveNativeAgentExecutionPolicy } from "../native-agent-execution-policy.js";
import { openCodePermissionRules } from "./policy-rules.js";
import { listOpenCodeResearchTools, openCodeResearchToolIds } from "./research-tools.js";
import { OpenCode2RequestError, type OpenCode2Client } from "./client.js";
import {
  OPENCODE2_ATTACHMENT_ROOT_ENV,
  OPENCODE2_COORDINATOR_GUARD_PLUGIN_ID,
  OPENCODE2_EXECUTION_POLICY_ENV,
  buildOpenCode2CoordinatorGuardPluginSource,
} from "./coordinator-plugin.js";
import type { OpenCode2McpConnection, OpenCode2McpServers } from "./mcp.js";
import { MAX_OPENCODE2_SESSION_RULES, toOpenCode2Rules } from "./permissions.js";
import {
  OPENCODE2_CREDENTIAL_PLUGIN_ID,
  buildOpenCode2CredentialPluginSource,
  openCode2HostPaths,
} from "./server.js";
import type { OpenCode2PermissionRule } from "./types.js";
import { mirrorOpenCodeUserConfig } from "./user-config.js";

const log = createLogger("native-agent.opencode2");

/** The agent every coordinator prompt runs as. */
export const OPENCODE2_COORDINATOR_AGENT = "plan";

/** Research tool ids a session's rules may name; the rest of the rule budget is the policy's. */
export const MAX_OPENCODE2_COORDINATOR_RESEARCH_TOOLS = 256;

/** What a coordinator's 2.x server was launched with, held by the backend beside its process. */
export interface OpenCode2CoordinatorAuthority {
  /** The coordinator policy for the launch's research mode; never a request's. */
  policy: NativeAgentExecutionPolicy;
  research: { mode: CoordinatorWebResearch; servers: readonly CoordinatorResearchMcpServer[] };
  /** Equal for two launches with the same research setting. */
  signature: string;
  /**
   * The conversation's current Control MCP credential: the one its server was
   * launched with, which that launch issues and revokes on exit
   * (`startLocalServerAttempt`). Undefined while none is live; a turn is then
   * refused.
   */
  controlConnection(): OpenCode2McpConnection | undefined;
}

/** The coordinator policy for a research mode, resolved as the trusted session input does. */
export function openCode2CoordinatorPolicy(
  mode: CoordinatorWebResearch,
): NativeAgentExecutionPolicy {
  return resolveNativeAgentExecutionPolicy(
    { environmentType: "local", networkAccessMode: "restricted" },
    "coordinator",
    undefined,
    mode,
  );
}

export function openCode2CoordinatorSignature(research: OpenCode2CoordinatorAuthority["research"]) {
  return JSON.stringify(coordinatorWebResearchEnv(research.mode, research.servers));
}

/**
 * The session rules of a coordinator: 1.x's coordinator rules (deny
 * everything, then the read-only tools, the control tools and the research
 * tools by exact id, then the policy's denials), translated. The policy's
 * own `projectResources: false` holds on 2.x (project configuration is off
 * for the server), so it is not widened the way `effectiveOpenCodePolicy`
 * widens it for 1.x.
 */
export function openCode2CoordinatorRules(
  policy: NativeAgentExecutionPolicy,
  researchToolIds: readonly string[],
): OpenCode2PermissionRule[] {
  if (policy.id !== COORDINATOR_EXECUTION_POLICY) {
    throw new PromptRejectedError(
      "A coordinator's OpenCode 2 server runs only its read-only policy",
    );
  }
  const rules = toOpenCode2Rules(
    openCodePermissionRules(policy, {
      researchTools: researchToolIds.slice(0, MAX_OPENCODE2_COORDINATOR_RESEARCH_TOOLS),
    }),
  );
  if (rules.length > MAX_OPENCODE2_SESSION_RULES - 8) {
    throw new PromptRejectedError("The coordinator's OpenCode 2 rules exceed the session budget");
  }
  return rules;
}

// ── launch ──────────────────────────────────────────────────────────────────

/** The coordinator servers' own configuration directory, beside the ordinary one. */
export function openCode2CoordinatorConfigDir(dataDir: string): string {
  return path.join(openCode2HostPaths(dataDir).root, "coordinator-config");
}

/**
 * Write the coordinator configuration directory (credential plugin and
 * coordinator guard); returns it. Ordinary 2.x servers never read it.
 */
export async function writeOpenCode2CoordinatorConfig(
  dataDir: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const configDir = openCode2CoordinatorConfigDir(dataDir);
  const plugins: Array<[string, string]> = [
    [OPENCODE2_CREDENTIAL_PLUGIN_ID, buildOpenCode2CredentialPluginSource()],
    [OPENCODE2_COORDINATOR_GUARD_PLUGIN_ID, buildOpenCode2CoordinatorGuardPluginSource()],
  ];
  for (const [id, source] of plugins) {
    const pluginDir = path.join(configDir, "plugins", id);
    await mkdir(pluginDir, { recursive: true, mode: 0o700 });
    const plugin = path.join(pluginDir, "index.ts");
    // A server starting alongside this one must never load half a file.
    const staged = `${plugin}.${randomUUID()}.tmp`;
    try {
      await writeFile(staged, source, { mode: 0o600, flag: "wx" });
      await rename(staged, plugin);
    } finally {
      await rm(staged, { force: true });
    }
  }
  // The user's providers, models and AGENTS.md, as a 1.x coordinator reads
  // them. Their MCP tools and commands stay behind the guard plugin.
  try {
    await mirrorOpenCodeUserConfig({
      configDir,
      customConfigFile: openCode2HostPaths(dataDir).customConfig,
      env,
    });
  } catch (error) {
    log.warn("user-config.mirror-failed", { error: formatLogError(error, { message: false }) });
  }
  return configDir;
}

/** The launch variables of a coordinator's 2.x server, over the ordinary host launch. */
export function openCode2CoordinatorLaunchEnv(input: {
  dataDir: string;
  attachmentRoot?: string;
  research: OpenCode2CoordinatorAuthority["research"];
}): Record<string, string> {
  return {
    [OPENCODE2_EXECUTION_POLICY_ENV]: COORDINATOR_EXECUTION_POLICY,
    [COORDINATOR_PROTECTED_DATA_DIR_ENV]: input.dataDir,
    ...(input.attachmentRoot ? { [OPENCODE2_ATTACHMENT_ROOT_ENV]: input.attachmentRoot } : {}),
    ...coordinatorWebResearchEnv(input.research.mode, input.research.servers),
    // The checkout's opencode.json, .opencode/ agents, commands, plugins and
    // MCP servers: a coordinator reads the checkout, it never runs it.
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  };
}

// ── the provider side ───────────────────────────────────────────────────────

/**
 * What the 2.x provider does differently on a coordinator's server: its
 * rules, its tools, its agent and its commands. One instance per server
 * generation, like the provider that owns it.
 */
export class OpenCode2CoordinatorSessions {
  private research: Promise<readonly string[]> | undefined;

  constructor(
    private readonly client: OpenCode2Client,
    private readonly mcp: OpenCode2McpServers,
    readonly authority: OpenCode2CoordinatorAuthority,
  ) {}

  /** The rules every session on this server runs with, between and during turns. */
  async rules(): Promise<OpenCode2PermissionRule[]> {
    return openCode2CoordinatorRules(this.authority.policy, await this.researchToolIds());
  }

  /** Refuse a policy that is not the coordinator's; the launch's own is what applies. */
  assertPolicy(policy: NativeAgentExecutionPolicy | undefined): void {
    if (policy && policy.id !== COORDINATOR_EXECUTION_POLICY) {
      throw new PromptRejectedError(
        "This OpenCode 2 server serves a coordinator and runs only its read-only policy",
      );
    }
  }

  /** A coordinator turn's options: the plan agent, and no provider command. */
  sendOptions(options: ProviderSendOptions): ProviderSendOptions {
    if (options.command) {
      throw new PromptRejectedError(
        "OpenCode 2 does not say which agent a command runs as, so a read-only coordinator cannot run it. Nothing was sent.",
      );
    }
    const { mode: _mode, ...rest } = options;
    return {
      ...rest,
      executionAgent: OPENCODE2_COORDINATOR_AGENT,
      // Typed slash text reaches the model as text.
      allowProviderCommands: false,
      // Never a tab's or a workflow's connection: the coordinator's own is registered here.
      agentMcp: undefined,
    };
  }

  /**
   * Register the conversation's control tools and research servers before a
   * turn. A control credential that does not connect refuses the turn, as
   * its 1.x server refuses to start: every coordinator action is a control
   * tool. With Control MCP off there is no credential, and the conversation
   * runs without them, as on 1.x.
   */
  async prepare(): Promise<void> {
    const control = this.authority.controlConnection();
    if (control) await this.mcp.ensureServer(ORKESTRATOR_AGENT_MCP_SERVER_NAME, control);
    await this.researchToolIds();
  }

  /** Make sure the session runs as `plan`, reading it back. Nothing is dispatched here. */
  async pinAgent(sessionId: string): Promise<void> {
    try {
      const session = await this.client.getSession(sessionId);
      if (session.agent === OPENCODE2_COORDINATOR_AGENT) return;
      await this.client.selectAgent(sessionId, OPENCODE2_COORDINATOR_AGENT);
      const after = await this.client.getSession(sessionId);
      if (after.agent !== OPENCODE2_COORDINATOR_AGENT) throw new Error("agent not applied");
    } catch (error) {
      if (error instanceof OpenCode2RequestError && error.status === 404) {
        throw new PromptRejectedError("The OpenCode 2 session was not found");
      }
      throw new ProviderDispatchPreparationError(
        "The OpenCode 2 coordinator could not select its read-only agent",
        { cause: error },
      );
    }
  }

  /**
   * The research tools' exact ids, registered once per server generation.
   * Research is optional: a server that does not connect is left out, as on
   * 1.x, and a failed generation is not retried until the server restarts.
   */
  private researchToolIds(): Promise<readonly string[]> {
    this.research ??= this.registerResearch().catch((error: unknown) => {
      log.warn("coordinator-research.unavailable", {
        error: formatLogError(error, { message: false }),
      });
      return [];
    });
    return this.research;
  }

  private async registerResearch(): Promise<readonly string[]> {
    const servers =
      this.authority.research.mode === "search-and-mcp" ? this.authority.research.servers : [];
    if (servers.length === 0) return [];
    const connected: CoordinatorResearchMcpServer[] = [];
    for (const server of servers) {
      // Remote and credential-free: nothing runs on this machine.
      await this.mcp
        .ensureServer(server.name, { url: server.url })
        .then(() => connected.push(server))
        .catch(() => undefined);
    }
    const names = (await this.client.listMcpServers()).map((server) => server.name);
    const allowed: string[] = [];
    for (const server of connected) {
      const tools = await listOpenCodeResearchTools(server.url).catch(() => []);
      allowed.push(
        ...openCodeResearchToolIds(
          server.name,
          tools,
          names.filter((name) => name !== server.name),
        ),
      );
    }
    return allowed.slice(0, MAX_OPENCODE2_COORDINATOR_RESEARCH_TOOLS);
  }
}
