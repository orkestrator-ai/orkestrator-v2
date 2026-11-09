/**
 * Which Orkestrator MCP connections an OpenCode 2.x turn uses
 * (docs/todo/agent-engines/0008-opencode-v2.md, phase 5; owner decision 2 of
 * 2026-11-09).
 *
 * 1.x keeps one environment-wide `orkestrator` registration, so three
 * per-turn facts reach its agent as trusted `system` text: the turn's
 * artifact grant (`artifactGrant`), a pipeline worker's mail capability
 * (`workerMail`) and the tab a turn runs in (`tabMail`). A 2.x prompt has no
 * `system` field, and a 2.x server has no environment-wide Orkestrator
 * connection at all: every Orkestrator server is a per-session runtime MCP
 * server (`mcp.ts`). So a 2.x turn carries these facts the way the HTTP
 * bridges do, as connections:
 *
 * - **`tabMail`**: an interactive 2.x tab already connects with its own
 *   tab-scoped credential (`sessionTakesAgentTools`), which names the
 *   mailbox. Nothing more is needed.
 * - **`workerMail`**: a pipeline worker turn with no workflow-result
 *   connection gets its worker mailbox's own scoped connection
 *   (`workerMailbox`, the same `connection(…, tabId)` a bridge worker gets),
 *   registered as the session's tab server. The capability itself is not
 *   used: it only selects a mailbox on an environment-wide connection.
 * - **`artifactGrant`**: a turn whose connection is the workflow-result
 *   broker (which never carries artifact authority) gets the grant as an
 *   artifact-only server (`agentMcp.artifacts`, `/artifact-mcp`), as a
 *   bridge's result turn does. A tab-scoped connection (a tab's or a
 *   worker's) carries artifact authority itself, so the grant is not
 *   delivered there, again as on the bridges.
 * - **`agentMcp.design`**: a tab-scoped connection in an environment with
 *   design canvases also gets the session's own `/design-mcp` server
 *   (`mcp.ts`), with the same credential.
 *
 * None of the three option fields reaches the 2.x provider's dispatch; the
 * resulting `agentMcp` does.
 */
import type { ProviderSendOptions, ProviderWorkerMail } from "../agent-provider-contract.js";
import type { Environment } from "../models.js";

type TurnConnection = NonNullable<ProviderSendOptions["agentMcp"]>;

/**
 * A pipeline worker mailbox's own scoped connection in the provider's
 * environment, or undefined when it cannot be issued (the agent tools server
 * is down, or the mailbox is not a worker's of this environment).
 */
export type OpenCode2WorkerMailbox = (
  mail: ProviderWorkerMail,
) => Promise<TurnConnection | undefined>;

type TurnFields = Pick<
  ProviderSendOptions,
  "agentMcp" | "artifactGrant" | "workerMail" | "tabMail"
>;

/** A turn's options as the 2.x provider dispatches them. */
export type OpenCode2TurnOptions<T extends TurnFields> = Omit<
  T,
  "agentMcp" | "artifactGrant" | "workerMail" | "tabMail"
> &
  Pick<ProviderSendOptions, "agentMcp">;

export interface OpenCode2WorkerMailboxDependencies {
  getEnvironment(
    environmentId: string,
  ): Promise<Pick<Environment, "id" | "projectId" | "environmentType"> | null>;
  /** The worker's mailbox the capability names, or null (`pipeline-worker-identity.ts`). */
  authenticate(
    capability: string,
  ): { environmentId: string; projectId: string; tabId: string } | null;
  /** The agent tools server's mailbox-scoped connection (`AgentToolsServer.connection`). */
  connection(
    environmentId: string,
    projectId: string,
    target: "host" | "container",
    tabId: string,
  ): TurnConnection;
}

/**
 * {@link OpenCode2WorkerMailbox} for one environment's provider. The
 * connection is issued only for the worker mailbox the turn's own signed
 * capability names, in this environment and its project, so a turn can never
 * be handed another mailbox than the one the backend gave it.
 */
export function openCode2WorkerMailbox(
  environmentId: string,
  deps: OpenCode2WorkerMailboxDependencies,
): OpenCode2WorkerMailbox {
  return async (mail) => {
    const scope = deps.authenticate(mail.capability);
    if (!scope || scope.environmentId !== environmentId || scope.tabId !== mail.tabId) {
      return undefined;
    }
    if (mail.environmentId !== environmentId) return undefined;
    const environment = await deps.getEnvironment(environmentId);
    if (!environment || environment.projectId !== scope.projectId) return undefined;
    const target = environment.environmentType === "local" ? "host" : "container";
    return deps.connection(environmentId, scope.projectId, target, scope.tabId);
  };
}

/**
 * The turn's options with its per-turn Orkestrator facts turned into
 * connections, and `artifactGrant`, `workerMail` and `tabMail` removed.
 */
export async function openCode2TurnConnections<T extends TurnFields>(
  options: T,
  workerMailbox: OpenCode2WorkerMailbox | undefined,
): Promise<OpenCode2TurnOptions<T>> {
  const { artifactGrant, workerMail } = options;
  let agentMcp = options.agentMcp;
  if (!agentMcp && workerMail && workerMailbox) {
    agentMcp = await workerMailbox(workerMail).catch(() => undefined);
  }
  if (agentMcp?.workflowResultCapability) {
    // The broker: never design (refused for workflow credentials), and the
    // turn's artifact authority only through the grant's own server.
    const broker: TurnConnection = { ...agentMcp };
    delete broker.design;
    if (artifactGrant && !broker.artifacts) broker.artifacts = { token: artifactGrant };
    agentMcp = broker;
  }
  const result: TurnFields = { ...options };
  delete result.artifactGrant;
  delete result.workerMail;
  delete result.tabMail;
  if (agentMcp) result.agentMcp = agentMcp;
  else delete result.agentMcp;
  return result as OpenCode2TurnOptions<T>;
}
