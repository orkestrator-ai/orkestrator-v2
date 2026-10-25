import { spawnSync } from "node:child_process";
import { expectThat, type ScenarioContext } from "./harness.js";

interface DockerResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

type Resource = "container" | "volume";

/** Docker CLI with bounded, argv-only execution and verified idempotent removal. */
export class DockerClient {
  constructor(
    private readonly execute: (args: string[]) => DockerResult = (args) =>
      spawnSync("docker", args, { encoding: "utf8", timeout: 60_000 }),
  ) {}

  private failure(args: string[], result: DockerResult): Error {
    return new Error(
      `docker ${args.slice(0, 2).join(" ")} failed: ${result.error?.message ?? (result.stderr || `exit ${result.status}`)}`,
    );
  }

  run(args: string[]): string {
    const result = this.execute(args);
    if (result.error || result.status !== 0) throw this.failure(args, result);
    return result.stdout.trim();
  }

  private absent(type: Resource, id: string, result: DockerResult): boolean {
    if (result.error || result.status !== 1) return false;
    const message = result.stderr.trim();
    // Match only the daemon's explicit missing-resource responses for this ID.
    return type === "container"
      ? message === `Error response from daemon: No such container: ${id}`
      : [
          `Error response from daemon: No such volume: ${id}`,
          `Error response from daemon: get ${id}: no such volume`,
          `Error response from daemon: remove ${id}: no such volume`,
        ].includes(message);
  }

  remove(type: Resource, id: string): void {
    const args = type === "container" ? ["rm", "--force", id] : ["volume", "rm", "--force", id];
    const removed = this.execute(args);
    if (removed.error || (removed.status !== 0 && !this.absent(type, id, removed)))
      throw this.failure(args, removed);

    const inspect = [type, "inspect", id];
    const remaining = this.execute(inspect);
    if (this.absent(type, id, remaining)) return;
    if (remaining.error || remaining.status !== 0) throw this.failure(inspect, remaining);
    throw new Error(`docker ${type} ${id} still exists after removal`);
  }
}

/** Keep an unmounted volume too: Docker's in-use protection must not mask deletion. */
export function createForeignOwnerDecoys(
  context: Pick<ScenarioContext, "cleanup">,
  labels: string[],
  name: string,
  image: string,
  docker = new DockerClient(),
): { containerId: string; assertUnchanged(stage: string): void } {
  const volumes = [name, `${name}-unmounted`].map((volumeName) => {
    const id = docker.run(["volume", "create", ...labels, volumeName]);
    context.cleanup.push({
      label: `remove decoy volume ${id}`,
      run: async () => docker.remove("volume", id),
    });
    return id;
  });
  const containerId = docker.run([
    "create",
    "--name",
    name,
    "--network",
    "none",
    ...labels,
    "--mount",
    `type=volume,source=${volumes[0]},target=/foreign-decoy`,
    image,
    "true",
  ]);
  // Remove the container before its mounted volume, even on scenario failure.
  context.cleanup.unshift({
    label: `remove decoy container ${containerId}`,
    run: async () => docker.remove("container", containerId),
  });
  const snapshot = () => ({
    container: docker.run([
      "container",
      "inspect",
      "--format",
      "{{.State.Status}} {{.State.StartedAt}} {{.State.FinishedAt}} {{.RestartCount}} {{json .Config.Labels}}",
      containerId,
    ]),
    volumes: volumes.map((id) =>
      docker.run(["volume", "inspect", "--format", "{{json .Labels}}", id]),
    ),
  });
  const before = snapshot();
  expectThat(before.container.startsWith("created "), "the decoy was not left created");
  return {
    containerId,
    assertUnchanged(stage) {
      const now = snapshot();
      expectThat(
        JSON.stringify(now) === JSON.stringify(before),
        `[${stage}] the foreign-owner decoy changed`,
      );
    },
  };
}
