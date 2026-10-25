import type { EnvironmentStatus } from "./models.js";

/**
 * How long one `docker ps` snapshot may serve status reads. A multi-project
 * refresh fans out one `get_environments` per project almost simultaneously;
 * without this, each of them would run its own `docker ps`.
 */
export const DOCKER_CONTAINER_STATE_CACHE_MS = 3_000;

export type DockerContainerStates = Map<string, EnvironmentStatus> | null;

/**
 * One backend's short-lived `docker ps` snapshot, shared by concurrent status
 * reads with the same Docker ownership scope. Owned by `BackendRuntime` as
 * `containerStates`; container creation invalidates it.
 */
export class DockerContainerStateCache {
  private entry: {
    fetchedAt: number;
    ownershipKey: string;
    states: Promise<DockerContainerStates>;
  } | null = null;

  /**
   * The cached snapshot for `ownershipKey` while it is fresh, otherwise the
   * result of `fetch`, which then becomes the snapshot. Concurrent callers
   * share the one in-flight promise.
   */
  read(
    ownershipKey: string,
    fetch: () => Promise<DockerContainerStates>,
    now = Date.now(),
  ): Promise<DockerContainerStates> {
    const entry = this.entry;
    if (
      entry &&
      entry.ownershipKey === ownershipKey &&
      now - entry.fetchedAt < DOCKER_CONTAINER_STATE_CACHE_MS
    ) {
      return entry.states;
    }
    const states = fetch();
    this.entry = { fetchedAt: now, ownershipKey, states };
    return states;
  }

  invalidate(): void {
    this.entry = null;
  }
}
