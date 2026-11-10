/**
 * `docker` commands (plan item 7003): Docker availability, the environment
 * image and daemon topology, raw container operations, container logs,
 * capacity and usage, the reviewed cleanup, and reattaching a container.
 *
 * None of these handlers was strict (`assertOnlyKeys`); they keep their own
 * checks. An argument the handler reads with `asString(x, "x")` is
 * `Schema.String` (the registry's text for a missing or mistyped key is the
 * same `Expected x to be a string`); every other argument the handler checks
 * or coerces itself is `optionalKey(Unknown)`, so nothing accepted today is
 * refused and the error text is unchanged. `access` is `admin` for the two
 * workspace-excluded cleanup commands; `read` equals `isNodeReadCommand`.
 *
 * Container lifecycle semantics (docs/architecture/container-lifecycle.md)
 * are the handlers' and are unchanged: `provision_environment` runs the
 * durable `create` operation, and its `operationId`/`expectedRevision` are
 * critical.
 *
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import { mutableArray } from "../../model-schema.js";
import { defineCommand } from "../../command.js";
import { ClientEnvironmentSchema, EnvironmentStatusSchema } from "../environments/models.js";
import { dockerDomain } from "./domain.js";
import {
  CleanupExecuteResultSchema,
  CleanupPreviewSchema,
  ContainerHostReachabilitySchema,
  ContainerInfoSchema,
  ContainerLogReadSchema,
  ContainerLogSubscriptionSchema,
  ContainerUsageSnapshotSchema,
  DockerAvailabilitySchema,
  DockerCapacitySchema,
  DockerSystemStatsSchema,
  DockerTopologySchema,
  ImageStatusSchema,
  PropagateTokenResultSchema,
} from "./models.js";

const noArgs = Schema.Struct({});
const optionalUnknown = Schema.optionalKey(Schema.Unknown);
const containerArgs = Schema.Struct({ containerId: Schema.String });

/** Docker installed and the daemon reachable; recorded for node summaries. */
export const checkDockerCommand = defineCommand({
  domain: dockerDomain,
  name: "check_docker",
  since: 1,
  access: "workspace",
  read: true,
  args: noArgs,
  result: DockerAvailabilitySchema,
  critical: [],
});

export const getDockerImageStatusCommand = defineCommand({
  domain: dockerDomain,
  name: "get_docker_image_status",
  since: 1,
  access: "workspace",
  read: true,
  args: noArgs,
  result: ImageStatusSchema,
  critical: [],
});

/** The startup "can containers reach the agent tools server?" result. */
export const getContainerHostReachabilityCommand = defineCommand({
  domain: dockerDomain,
  name: "get_container_host_reachability",
  since: 1,
  access: "workspace",
  read: true,
  args: noArgs,
  result: ContainerHostReachabilitySchema,
  critical: [],
});

/** Runs the reachability check now ("Check again"). */
export const checkContainerHostReachabilityCommand = defineCommand({
  domain: dockerDomain,
  name: "check_container_host_reachability",
  since: 1,
  access: "workspace",
  read: true,
  args: noArgs,
  result: ContainerHostReachabilitySchema,
  critical: [],
});

export const getDockerTopologyCommand = defineCommand({
  domain: dockerDomain,
  name: "get_docker_topology",
  since: 1,
  access: "workspace",
  read: true,
  // `refresh` is read as `=== true`.
  args: Schema.Struct({ refresh: optionalUnknown }),
  result: DockerTopologySchema,
  critical: [],
});

/** Creates the environment's container (idempotent); its id, or `null`. */
export const provisionEnvironmentCommand = defineCommand({
  domain: dockerDomain,
  name: "provision_environment",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Schema.String,
    // Checked by `parseContainerMutationIdentity` with its lifecycle error text.
    operationId: optionalUnknown,
    expectedRevision: optionalUnknown,
  }),
  result: Schema.NullOr(Schema.String),
  // operationId: a retried request is answered from the recorded outcome;
  // ignoring it runs the create again. expectedRevision: the fence against a
  // lifecycle the caller did not review; ignoring it acts on a changed one.
  critical: ["operationId", "expectedRevision"],
});

export const dockerStartContainerCommand = defineCommand({
  domain: dockerDomain,
  name: "docker_start_container",
  since: 1,
  access: "workspace",
  read: false,
  args: containerArgs,
  result: Schema.Void,
  critical: [],
});

export const dockerStopContainerCommand = defineCommand({
  domain: dockerDomain,
  name: "docker_stop_container",
  since: 1,
  access: "workspace",
  read: false,
  args: containerArgs,
  result: Schema.Void,
  critical: [],
});

/** Removes a container nothing claims; an environment's runtime is refused. */
export const dockerRemoveContainerCommand = defineCommand({
  domain: dockerDomain,
  name: "docker_remove_container",
  since: 1,
  access: "workspace",
  read: false,
  args: containerArgs,
  result: Schema.Void,
  critical: [],
});

export const dockerContainerStatusCommand = defineCommand({
  domain: dockerDomain,
  name: "docker_container_status",
  since: 1,
  access: "workspace",
  read: false,
  args: containerArgs,
  result: EnvironmentStatusSchema,
  critical: [],
});

/** The last lines of a container's log, bounded in lines and bytes. */
export const getContainerLogsCommand = defineCommand({
  domain: dockerDomain,
  name: "get_container_logs",
  since: 1,
  access: "workspace",
  read: true,
  // `tail` is a line count as a string; anything else means the default.
  args: Schema.Struct({ containerId: Schema.String, tail: optionalUnknown }),
  result: Schema.String,
  critical: [],
});

/** Follows a container's log through one shared follower and a leased subscription. */
export const openContainerLogsCommand = defineCommand({
  domain: dockerDomain,
  name: "open_container_logs",
  since: 1,
  access: "workspace",
  read: false,
  args: containerArgs,
  result: ContainerLogSubscriptionSchema,
  critical: [],
});

/** Records after `cursor`; renews the lease. */
export const readContainerLogsCommand = defineCommand({
  domain: dockerDomain,
  name: "read_container_logs",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    subscriptionId: Schema.String,
    sourceId: Schema.String,
    // Checked by `asNumber` with its own text.
    cursor: optionalUnknown,
  }),
  result: ContainerLogReadSchema,
  critical: [],
});

/** Releases the subscription; the container keeps running. */
export const closeContainerLogsCommand = defineCommand({
  domain: dockerDomain,
  name: "close_container_logs",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ subscriptionId: Schema.String }),
  result: Schema.Void,
  critical: [],
});

export const getDockerSystemStatsCommand = defineCommand({
  domain: dockerDomain,
  name: "get_docker_system_stats",
  since: 1,
  access: "workspace",
  read: true,
  args: noArgs,
  result: DockerSystemStatsSchema,
  critical: [],
});

export const getDockerCapacityCommand = defineCommand({
  domain: dockerDomain,
  name: "get_docker_capacity",
  since: 1,
  access: "workspace",
  read: true,
  // `refresh` is read as `=== true`.
  args: Schema.Struct({ refresh: optionalUnknown }),
  result: DockerCapacitySchema,
  critical: [],
});

export const getContainerUsageCommand = defineCommand({
  domain: dockerDomain,
  name: "get_container_usage",
  since: 1,
  access: "workspace",
  read: true,
  args: noArgs,
  result: ContainerUsageSnapshotSchema,
  critical: [],
});

/** This installation's containers with their environment and cleanup classification. */
export const getOrkestratorContainersCommand = defineCommand({
  domain: dockerDomain,
  name: "get_orkestrator_containers",
  since: 1,
  access: "workspace",
  read: true,
  args: noArgs,
  result: mutableArray(ContainerInfoSchema),
  critical: [],
});

/** The reviewed cleanup's preview, bound to a selection token. */
export const dockerCleanupPreviewCommand = defineCommand({
  domain: dockerDomain,
  name: "docker_cleanup_preview",
  since: 1,
  access: "admin",
  read: false,
  args: noArgs,
  result: CleanupPreviewSchema,
  critical: [],
});

/** Removes only the selected resources of one preview; the token is consumed. */
export const dockerCleanupExecuteCommand = defineCommand({
  domain: dockerDomain,
  name: "docker_cleanup_execute",
  since: 1,
  access: "admin",
  read: false,
  args: Schema.Struct({
    selectionToken: Schema.String,
    // Lists of ids, checked by the handler with its own text.
    containerIds: optionalUnknown,
    volumeNames: optionalUnknown,
    networkNames: optionalUnknown,
  }),
  result: CleanupExecuteResultSchema,
  // selectionToken: binds the removal to the set the user reviewed; ignoring
  // it would remove without that review. (An ignored id list removes less,
  // which is safe.)
  critical: ["selectionToken"],
});

/** Adopts a reviewed, unclaimed container of this installation as a new environment. */
export const reattachContainerCommand = defineCommand({
  domain: dockerDomain,
  name: "reattach_container",
  since: 1,
  access: "workspace",
  read: false,
  // `name` is used only when it is a string.
  args: Schema.Struct({
    projectId: Schema.String,
    containerId: Schema.String,
    name: optionalUnknown,
  }),
  result: ClientEnvironmentSchema,
  critical: [],
});

/** Applies the selected GitHub credential to every running container. */
export const propagateGithubTokenToContainersCommand = defineCommand({
  domain: dockerDomain,
  name: "propagate_github_token_to_containers",
  since: 1,
  access: "workspace",
  read: false,
  args: noArgs,
  result: PropagateTokenResultSchema,
  critical: [],
});

export const DOCKER_COMMANDS = [
  checkDockerCommand,
  getDockerImageStatusCommand,
  getContainerHostReachabilityCommand,
  checkContainerHostReachabilityCommand,
  getDockerTopologyCommand,
  provisionEnvironmentCommand,
  dockerStartContainerCommand,
  dockerStopContainerCommand,
  dockerRemoveContainerCommand,
  dockerContainerStatusCommand,
  getContainerLogsCommand,
  openContainerLogsCommand,
  readContainerLogsCommand,
  closeContainerLogsCommand,
  getDockerSystemStatsCommand,
  getDockerCapacityCommand,
  getContainerUsageCommand,
  getOrkestratorContainersCommand,
  dockerCleanupPreviewCommand,
  dockerCleanupExecuteCommand,
  reattachContainerCommand,
  propagateGithubTokenToContainersCommand,
] as const;
