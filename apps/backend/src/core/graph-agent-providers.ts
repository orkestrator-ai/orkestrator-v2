/**
 * Provider instances for graph agent activations: one per environment and
 * agent, shared by every activation that runs there, created on first use
 * and retired once no admitted activation uses it (or when its transport
 * stopped answering, so the next use reconnects and restarts a local bridge
 * that died). The same lifetime rules as Multi Review's provider cache
 * (`provider-retirement.ts`): an instance in use is never disposed under a
 * caller.
 */
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  createBuildPipelineProvider,
  type BridgeConnection,
  type BuildPipelineProvider,
  type ProviderDependencies,
} from "./build-pipeline-provider.js";
import type { Environment } from "./models.js";
import { managedProvider, retireProvider } from "./provider-retirement.js";

export type GraphAgentCommandInvoker = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

/** The bridge an environment's agent answers on, started if needed (as Multi Review does). */
export async function graphAgentBridgeConnection(
  invoke: GraphAgentCommandInvoker,
  agent: AgentPlatform,
  environment: Environment,
): Promise<BridgeConnection> {
  if (environment.environmentType === "local") {
    const result = await invoke<{ port: number; authToken?: string }>(
      `start_local_${agent}_server_cmd`,
      { environmentId: environment.id },
    );
    if (!result.authToken) throw new Error(`${agent} bridge authentication is unavailable`);
    return {
      agent,
      baseUrl: `http://127.0.0.1:${result.port}`,
      authToken: result.authToken,
      directory: environment.worktreePath,
    };
  }
  if (!environment.containerId) throw new Error("The environment's container is unavailable");
  const result = await invoke<{ hostPort: number; authToken?: string }>(`start_${agent}_server`, {
    containerId: environment.containerId,
  });
  if (!result.authToken) throw new Error(`${agent} bridge authentication is unavailable`);
  return {
    agent,
    baseUrl: `http://127.0.0.1:${result.hostPort}`,
    authToken: result.authToken,
  } as BridgeConnection;
}

export interface GraphAgentProvidersOptions {
  /** Creates a provider; defaults to a bridge provider over `connection`. */
  create?: (environment: Environment, agent: AgentPlatform) => Promise<BuildPipelineProvider>;
  connection?: (environment: Environment, agent: AgentPlatform) => Promise<BridgeConnection>;
  dependencies?: ProviderDependencies;
}

export class GraphAgentProviders {
  private readonly providers = new Map<string, BuildPipelineProvider>();
  private readonly creations = new Map<string, Promise<BuildPipelineProvider>>();
  /** Activation keys using each instance. */
  private readonly users = new Map<string, Set<string>>();

  constructor(private readonly options: GraphAgentProvidersOptions) {}

  private key(environmentId: string, agent: AgentPlatform): string {
    return `${environmentId}:${agent}`;
  }

  /** The instance for an activation; registers it as a user until {@link release}. */
  async get(
    environment: Environment,
    agent: AgentPlatform,
    user: string,
  ): Promise<BuildPipelineProvider> {
    const key = this.key(environment.id, agent);
    let users = this.users.get(key);
    if (!users) {
      users = new Set();
      this.users.set(key, users);
    }
    users.add(user);
    const cached = this.providers.get(key);
    if (cached) return cached;
    const pending = this.creations.get(key);
    if (pending) return pending;
    const creation = (async () => {
      const provider = this.options.create
        ? await this.options.create(environment, agent)
        : createBuildPipelineProvider(await this.requireConnection(environment, agent), {
            ...this.options.dependencies,
            refreshConnection: () => this.requireConnection(environment, agent),
          });
      const managed = managedProvider(provider);
      this.providers.set(key, managed);
      return managed;
    })();
    this.creations.set(key, creation);
    try {
      return await creation;
    } finally {
      if (this.creations.get(key) === creation) this.creations.delete(key);
    }
  }

  private requireConnection(environment: Environment, agent: AgentPlatform) {
    if (!this.options.connection) throw new Error("No bridge connection is configured");
    return this.options.connection(environment, agent);
  }

  /** Drops an instance whose transport stopped answering (only that instance). */
  unavailable(environmentId: string, agent: AgentPlatform, provider: BuildPipelineProvider): void {
    const key = this.key(environmentId, agent);
    if (this.providers.get(key) !== provider) return;
    this.providers.delete(key);
    retireProvider(provider);
  }

  /** An activation no longer uses its instance; the last user retires it. */
  release(environmentId: string, agent: AgentPlatform, user: string): void {
    const key = this.key(environmentId, agent);
    const users = this.users.get(key);
    users?.delete(user);
    if (users && users.size > 0) return;
    this.users.delete(key);
    const provider = this.providers.get(key);
    if (!provider) return;
    this.providers.delete(key);
    retireProvider(provider);
  }

  /** Retires every instance (backend shutdown). */
  shutdown(): void {
    for (const provider of this.providers.values()) retireProvider(provider);
    this.providers.clear();
    this.users.clear();
  }
}
