/**
 * Per-environment isolation for local environments
 * (docs/architecture/environment-isolation.md).
 *
 * Local worktrees share the host: its ports, its Docker daemon and its Docker
 * Compose project namespace. A repository whose compose file fixes
 * `name: my-stack` and publishes `5433:5432` makes every worktree's
 * `docker compose up` reach the same containers, so one environment's tests
 * (or migrations) run against another's database, or fail with "port is
 * already allocated". Each local environment therefore gets:
 *
 * - `COMPOSE_PROJECT_NAME`, unique to the environment. Compose gives it
 *   precedence over a compose file's top-level `name:`, so containers,
 *   networks and volumes are this environment's own without any change to
 *   the repository.
 * - A block of host ports reserved for it alone (`ORKESTRATOR_PORT_BASE` to
 *   `ORKESTRATOR_PORT_MAX`), which a repository can map its services onto
 *   (`ports: ["127.0.0.1:${ORKESTRATOR_PORT_BASE:-5433}:5432"]`).
 * - `ORKESTRATOR_ENVIRONMENT_ID`, so scripts can name other per-environment
 *   resources.
 *
 * The variables reach every process Orkestrator starts in the worktree: the
 * setup terminal, terminal tabs, user commands, the agent bridges and review
 * validation. Container environments need none of it: each has its own
 * network namespace and no Docker daemon.
 */
import { createHash } from "node:crypto";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import type { Environment } from "./models.js";

const log = createLogger("environment");

/** Ports in one environment's block. */
export const ENVIRONMENT_PORT_BLOCK_SIZE = 20;
/**
 * The blocks come from 20000-31999: above the usual development defaults
 * (3000, 5173, 5432, 8080, …) and below the ephemeral ranges the OS hands out
 * for outgoing connections (Linux from 32768, macOS from 49152), so neither
 * a dev server nor a client socket is likely to be holding one.
 */
export const ENVIRONMENT_PORT_RANGE_START = 20_000;
/** Exclusive. */
export const ENVIRONMENT_PORT_RANGE_END = 32_000;
export const ENVIRONMENT_PORT_BLOCK_COUNT =
  (ENVIRONMENT_PORT_RANGE_END - ENVIRONMENT_PORT_RANGE_START) / ENVIRONMENT_PORT_BLOCK_SIZE;

export const ENVIRONMENT_ID_ENV = "ORKESTRATOR_ENVIRONMENT_ID";
export const COMPOSE_PROJECT_NAME_ENV = "COMPOSE_PROJECT_NAME";
export const ENVIRONMENT_PORT_BASE_ENV = "ORKESTRATOR_PORT_BASE";
export const ENVIRONMENT_PORT_COUNT_ENV = "ORKESTRATOR_PORT_COUNT";
export const ENVIRONMENT_PORT_MAX_ENV = "ORKESTRATOR_PORT_MAX";

/**
 * Every variable this module sets. A process that gets no reservation of its
 * own drops them, so it never inherits another environment's from the
 * backend's own environment (a backend started from an environment terminal).
 */
export const ENVIRONMENT_ISOLATION_ENV_NAMES: readonly string[] = [
  ENVIRONMENT_ID_ENV,
  COMPOSE_PROJECT_NAME_ENV,
  ENVIRONMENT_PORT_BASE_ENV,
  ENVIRONMENT_PORT_COUNT_ENV,
  ENVIRONMENT_PORT_MAX_ENV,
];

/** Remove a parent worktree's values before applying the launch target's own. */
export function withEnvironmentIsolation(
  inherited: NodeJS.ProcessEnv,
  isolation: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const env = { ...inherited };
  for (const name of ENVIRONMENT_ISOLATION_ENV_NAMES) delete env[name];
  return Object.assign(env, isolation);
}

/** tmux inherits its server's environment, so replace these values in the pane. */
export function environmentIsolationShellPrefix(isolation: Record<string, string>): string {
  const exports = Object.entries(isolation)
    .filter(([name]) => ENVIRONMENT_ISOLATION_ENV_NAMES.includes(name))
    .map(([name, value]) => `${name}='${value.replace(/'/g, "'\\''")}'`);
  return `unset ${ENVIRONMENT_ISOLATION_ENV_NAMES.join(" ")}; ${exports.length ? `export ${exports.join(" ")}; ` : ""}`;
}

/** Whether `value` is the first port of a block this module hands out. */
export function isEnvironmentPortBase(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= ENVIRONMENT_PORT_RANGE_START &&
    value < ENVIRONMENT_PORT_RANGE_END &&
    (value - ENVIRONMENT_PORT_RANGE_START) % ENVIRONMENT_PORT_BLOCK_SIZE === 0
  );
}

/**
 * A free block for `environmentId`, or null when every block is taken.
 *
 * The hash spreads allocations across the range; it does not prove a block
 * is unused. The storage allocator also probes candidates for bound ports.
 */
export function chooseEnvironmentPortBase(
  environmentId: string,
  taken: ReadonlySet<number>,
): number | null {
  const digest = createHash("sha256").update(environmentId).digest();
  const start = digest.readUInt32BE(0) % ENVIRONMENT_PORT_BLOCK_COUNT;
  for (let offset = 0; offset < ENVIRONMENT_PORT_BLOCK_COUNT; offset += 1) {
    const index = (start + offset) % ENVIRONMENT_PORT_BLOCK_COUNT;
    const base = ENVIRONMENT_PORT_RANGE_START + index * ENVIRONMENT_PORT_BLOCK_SIZE;
    if (!taken.has(base)) return base;
  }
  return null;
}

/**
 * The environment's Compose project name: `ork-` and the first twelve
 * alphanumerics of its id, lowercased. Compose accepts lowercase letters,
 * digits, `-` and `_`, starting with a letter or digit. Derived from the id
 * rather than the name, so a rename does not orphan running containers.
 */
export function environmentComposeProjectName(environmentId: string): string {
  const compact = environmentId
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 12);
  return `ork-${compact || "env"}`;
}

/** The variables for one environment; the port variables only with a block. */
export function environmentIsolationVariables(
  environmentId: string,
  portBase: number | null,
): Record<string, string> {
  return {
    [ENVIRONMENT_ID_ENV]: environmentId,
    [COMPOSE_PROJECT_NAME_ENV]: environmentComposeProjectName(environmentId),
    ...(portBase === null
      ? {}
      : {
          [ENVIRONMENT_PORT_BASE_ENV]: String(portBase),
          [ENVIRONMENT_PORT_COUNT_ENV]: String(ENVIRONMENT_PORT_BLOCK_SIZE),
          [ENVIRONMENT_PORT_MAX_ENV]: String(portBase + ENVIRONMENT_PORT_BLOCK_SIZE - 1),
        }),
  };
}

/** The setup terminal's line naming what this environment has to itself. */
export function formatEnvironmentIsolationNotice(variables: Record<string, string>): string {
  const project = variables[COMPOSE_PROJECT_NAME_ENV];
  const base = variables[ENVIRONMENT_PORT_BASE_ENV];
  const max = variables[ENVIRONMENT_PORT_MAX_ENV];
  const ports =
    base && max
      ? `host ports ${base}-${max} ($${ENVIRONMENT_PORT_BASE_ENV}-$${ENVIRONMENT_PORT_MAX_ENV})`
      : "no reserved host ports";
  return `[orkestrator] Isolation: Docker Compose project ${project} ($${COMPOSE_PROJECT_NAME_ENV}), ${ports}`;
}

/** The storage entry point that reserves a block (`storage-environment-isolation.ts`). */
export interface EnvironmentPortBlockStorage {
  environmentIsolation: {
    assignEnvironmentPortBase(environmentId: string): Promise<number | null>;
  };
}

/**
 * The isolation variables for a process Orkestrator starts in `environment`'s
 * workspace: empty for a container environment, which is isolated already.
 *
 * Never throws. A launch is not worth failing over a missing port block: the
 * process then runs without the port variables (still with its own Compose
 * project name), as it did before this existed.
 */
export async function localEnvironmentIsolationEnv(
  environment: Pick<Environment, "id" | "environmentType">,
  storage: EnvironmentPortBlockStorage,
): Promise<Record<string, string>> {
  if (environment.environmentType !== "local") return {};
  let portBase: number | null = null;
  try {
    portBase = await storage.environmentIsolation.assignEnvironmentPortBase(environment.id);
    if (portBase === null) {
      log.warn("isolation.port-block-unavailable", {
        environmentId: environment.id,
        error: "every port block is reserved or the environment is gone",
      });
    }
  } catch (error) {
    log.warn("isolation.port-block-unavailable", {
      environmentId: environment.id,
      error: formatLogError(error),
    });
  }
  return environmentIsolationVariables(environment.id, portBase);
}
