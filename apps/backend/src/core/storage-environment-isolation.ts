import { environmentPortBlockAvailable } from "./environment-port-probe.js";
import { chooseEnvironmentPortBase, isEnvironmentPortBase } from "./environment-isolation.js";
import type { StorageContext } from "./storage-context.js";
import type { StorageRepositories } from "./storage-repositories.js";

/**
 * Port blocks of local environments (`environment-isolation.ts`), kept on the
 * environment record as `isolationPortBase`.
 *
 * The block is chosen and written under the environment store's lease, which
 * every other environment write also holds, so two environments starting at
 * once cannot be handed the same block. Newly assigned blocks are also probed:
 * deleting a row never makes a still-bound service port available for reuse.
 */
export class EnvironmentIsolationRepository {
  constructor(
    private readonly context: StorageContext,
    private readonly repos: StorageRepositories,
  ) {}

  /**
   * The environment's port block, reserving one on first use. Null when the
   * environment does not exist or every block is reserved.
   */
  async assignEnvironmentPortBase(environmentId: string): Promise<number | null> {
    const projects = this.repos.projects;
    return projects.enqueueEnvironmentMutation(async () => {
      const environment = await projects.getEnvironment(environmentId);
      if (!environment) return null;
      const environments = await projects.loadEnvironments();
      const current = environment.isolationPortBase;
      // A block shared with another record (a copied row, an older write) is
      // given up by whichever of the two asks first; the other keeps it.
      if (
        isEnvironmentPortBase(current) &&
        !environments.some(
          (other) => other.id !== environmentId && other.isolationPortBase === current,
        )
      ) {
        return current;
      }
      const taken = new Set(
        environments
          .filter((other) => other.id !== environmentId)
          .map((other) => other.isolationPortBase)
          .filter(isEnvironmentPortBase),
      );
      let base = chooseEnvironmentPortBase(environmentId, taken);
      while (base !== null && !(await environmentPortBlockAvailable(base))) {
        taken.add(base);
        base = chooseEnvironmentPortBase(environmentId, taken);
      }
      if (base === null) return null;
      environment.isolationPortBase = base;
      projects.saveEnvironment(environment);
      this.context.changes.announce("environment", environmentId, environment.projectId);
      return base;
    });
  }
}

/** What code outside the storage files may call (`storage.environmentIsolation`). */
export type EnvironmentIsolationStorage = Pick<
  EnvironmentIsolationRepository,
  "assignEnvironmentPortBase"
>;
