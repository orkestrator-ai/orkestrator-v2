import { DOCKER_LABEL_RESOURCE_ROLE } from "../constants.js";
import {
  DOCKER_LABEL_EGRESS_GATEWAY,
  EGRESS_GATEWAY_ROLE,
  prepareEgressGatewayForStart,
} from "../egress-gateway.js";
import {
  GITHUB_RANGES_SEED_DIRECTORY,
  copyGithubRangesSeed,
  githubRangesSeed,
} from "./github-ranges-cache.js";
import { runCommand } from "../shell.js";
import { createLogger } from "@orkestrator/protocol/logger";

const log = createLogger("docker");

/**
 * Hands a restricted container a fresh GitHub ranges seed just before the
 * backend boots it (to-do 7549 task 2).
 *
 * The firewall trusts a seed for a day and otherwise asks
 * `api.github.com/meta` anonymously, from an allowance of 60 an hour per
 * address. The seed used to be refreshed only when a container was created,
 * so every restart more than a day later fetched. Docker never starts these
 * containers on its own (no restart policy), so refreshing here covers every
 * boot:
 *
 * - a container that binds the seed directory (created since the bind) sees
 *   the refreshed file through the bind, and nothing is copied;
 * - an older container, which was given a copy at creation, gets a new copy
 *   (`copyGithubRangesSeed`, best effort) until it is rebuilt.
 *
 * Only containers that run a firewall take part: an egress gateway, or a
 * restricted runtime with no gateway. Never throws; a container left without
 * a seed fetches the ranges itself, as before.
 */

export type GithubSeedDelivery =
  "not-firewall" | "bound" | "copied" | "not-copied" | "no-seed" | "inspect-failed";

const SEED_CONSUMER_FORMAT = [
  `{{range .Config.Env}}{{if eq . "NETWORK_MODE=restricted"}}restricted{{end}}{{end}}`,
  `{{ index .Config.Labels "${DOCKER_LABEL_RESOURCE_ROLE}" }}`,
  `{{ index .Config.Labels "${DOCKER_LABEL_EGRESS_GATEWAY}" }}`,
  `{{range .Mounts}}{{.Destination}};{{end}}`,
].join("\t");

export interface SeedConsumer {
  /** Runs the firewall: a gateway, or a restricted runtime without one. */
  firewall: boolean;
  /** Binds the seed directory, so a refreshed seed needs no copy. */
  bound: boolean;
}

function label(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  return trimmed === "<no value>" ? "" : trimmed;
}

/** Parses {@link SEED_CONSUMER_FORMAT}; null when the answer is not that shape. */
export function parseSeedConsumer(stdout: string): SeedConsumer | null {
  const line = stdout.replace(/\r?\n$/, "");
  if (line.includes("\n")) return null;
  const fields = line.split("\t");
  if (fields.length !== 4) return null;
  const [mode = "", role, gateway, mounts = ""] = fields;
  const restricted = mode.includes("restricted");
  const isGateway = label(role) === EGRESS_GATEWAY_ROLE;
  return {
    firewall: restricted && (isGateway || label(gateway) === ""),
    bound: mounts.split(";").includes(GITHUB_RANGES_SEED_DIRECTORY),
  };
}

export interface SeedDeliveryDependencies {
  run?: typeof runCommand;
  seed?: (dataDir: string) => Promise<string | null>;
  copy?: (containerId: string, seedFile: string) => Promise<boolean>;
}

export async function deliverGithubRangesSeedBeforeBoot(
  dataDir: string,
  containerId: string,
  dependencies: SeedDeliveryDependencies = {},
): Promise<GithubSeedDelivery> {
  const run = dependencies.run ?? runCommand;
  let consumer: SeedConsumer | null;
  try {
    const { stdout } = await run(
      "docker",
      ["inspect", "--type", "container", "--format", SEED_CONSUMER_FORMAT, containerId],
      { timeoutMs: 15_000 },
    );
    consumer = parseSeedConsumer(stdout);
  } catch {
    // The start that follows reports an unreachable daemon or a missing
    // container itself.
    return "inspect-failed";
  }
  if (!consumer) return "inspect-failed";
  if (!consumer.firewall) return "not-firewall";
  const seed = await (dependencies.seed ?? githubRangesSeed)(dataDir).catch(() => null);
  if (consumer.bound) return "bound";
  if (!seed) return "no-seed";
  const copied = await (
    dependencies.copy ?? ((id: string, file: string) => copyGithubRangesSeed(id, file, run))
  )(containerId, seed).catch(() => false);
  if (copied) {
    log.info("github-ranges.seed-copied-before-boot", { containerId: containerId.slice(0, 12) });
  }
  return copied ? "copied" : "not-copied";
}

/**
 * Brings a runtime's egress gateway up for a start, as
 * {@link prepareEgressGatewayForStart} does, refreshing the gateway's seed
 * just before it boots. The production start path and the container
 * benchmark share it so the benchmark counts the same Docker calls.
 */
export function prepareEgressGatewayWithSeed(
  dataDir: string,
  containerId: string,
): ReturnType<typeof prepareEgressGatewayForStart> {
  return prepareEgressGatewayForStart(containerId, {
    beforeGatewayBoot: (gatewayId) => deliverGithubRangesSeedBeforeBoot(dataDir, gatewayId),
  });
}

/**
 * The runtime's own seed delivery before it boots. A runtime behind a gateway
 * (`gateway` is not `"none"`) or in full mode runs no firewall of its own, so
 * it is answered `not-firewall` without the inspect: only a container that
 * runs the firewall pays for one. A runtime whose mode is unknown (no
 * environment record) is inspected. Skipping only ever costs freshness: a
 * firewall that finds no usable seed fetches GitHub's ranges itself and still
 * fails closed.
 */
export async function deliverRuntimeSeedBeforeBoot(
  dataDir: string,
  containerId: string,
  options: {
    gateway: Awaited<ReturnType<typeof prepareEgressGatewayForStart>>;
    networkAccessMode?: string | null;
  },
  dependencies: SeedDeliveryDependencies = {},
): Promise<GithubSeedDelivery> {
  if (options.gateway !== "none" || options.networkAccessMode === "full") return "not-firewall";
  return deliverGithubRangesSeedBeforeBoot(dataDir, containerId, dependencies);
}
