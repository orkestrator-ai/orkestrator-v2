/**
 * The `docker` domain client (plan item 7003; §11.2 "Client adapters"): one
 * method per command, over any command call.
 *
 * The domain has no capability command. Version 2 sends the envelope
 * (`operationId`/`expectedRevision` on `provision_environment` and
 * `selectionToken` on `docker_cleanup_execute` are critical) and decodes
 * results with the commands' schemas.
 *
 * Only the current version has an adapter: the older ones went with the
 * one-time support floor v2.39.1-beta (to-do 8304 (retired), 2026-11-26). A domains map
 * that omits this domain yields `unsupported-version`. Without a domains
 * map, calls use the lowest adapter unnegotiated. Later bumps keep an
 * adapter for every version a release in the 60-day window speaks.
 *
 * Browser-safe.
 */
import { domainClient, type CommandCall } from "../../client.js";
import type { AnyCommandDef, ArgsOf, ResultOf } from "../../command.js";
import {
  checkContainerHostReachabilityCommand,
  checkDockerCommand,
  closeContainerLogsCommand,
  dockerCleanupExecuteCommand,
  dockerCleanupPreviewCommand,
  dockerContainerStatusCommand,
  dockerRemoveContainerCommand,
  dockerStartContainerCommand,
  dockerStopContainerCommand,
  getContainerHostReachabilityCommand,
  getContainerLogsCommand,
  getContainerUsageCommand,
  getDockerCapacityCommand,
  getDockerImageStatusCommand,
  getDockerSystemStatsCommand,
  getDockerTopologyCommand,
  getOrkestratorContainersCommand,
  openContainerLogsCommand,
  propagateGithubTokenToContainersCommand,
  provisionEnvironmentCommand,
  readContainerLogsCommand,
  reattachContainerCommand,
} from "./commands.js";
import { dockerDomain } from "./domain.js";

type Call<C extends AnyCommandDef> = (args: ArgsOf<C>) => Promise<ResultOf<C>>;
type NoArgsCall<C extends AnyCommandDef> = () => Promise<ResultOf<C>>;

export interface DockerApi {
  checkDocker: NoArgsCall<typeof checkDockerCommand>;
  imageStatus: NoArgsCall<typeof getDockerImageStatusCommand>;
  hostReachability: NoArgsCall<typeof getContainerHostReachabilityCommand>;
  checkHostReachability: NoArgsCall<typeof checkContainerHostReachabilityCommand>;
  topology: Call<typeof getDockerTopologyCommand>;
  provisionEnvironment: Call<typeof provisionEnvironmentCommand>;
  startContainer: Call<typeof dockerStartContainerCommand>;
  stopContainer: Call<typeof dockerStopContainerCommand>;
  removeContainer: Call<typeof dockerRemoveContainerCommand>;
  containerStatus: Call<typeof dockerContainerStatusCommand>;
  containerLogs: Call<typeof getContainerLogsCommand>;
  openContainerLogs: Call<typeof openContainerLogsCommand>;
  readContainerLogs: Call<typeof readContainerLogsCommand>;
  closeContainerLogs: Call<typeof closeContainerLogsCommand>;
  systemStats: NoArgsCall<typeof getDockerSystemStatsCommand>;
  capacity: Call<typeof getDockerCapacityCommand>;
  containerUsage: NoArgsCall<typeof getContainerUsageCommand>;
  orkestratorContainers: NoArgsCall<typeof getOrkestratorContainersCommand>;
  cleanupPreview: NoArgsCall<typeof dockerCleanupPreviewCommand>;
  cleanupExecute: Call<typeof dockerCleanupExecuteCommand>;
  reattachContainer: Call<typeof reattachContainerCommand>;
  propagateGithubToken: NoArgsCall<typeof propagateGithubTokenToContainersCommand>;
}

/** The API over any command call: the adapter, and a node's own local commands. */
export function dockerApi(call: CommandCall): DockerApi {
  return {
    checkDocker: () => call(checkDockerCommand, {}),
    imageStatus: () => call(getDockerImageStatusCommand, {}),
    hostReachability: () => call(getContainerHostReachabilityCommand, {}),
    checkHostReachability: () => call(checkContainerHostReachabilityCommand, {}),
    topology: (args) => call(getDockerTopologyCommand, args),
    provisionEnvironment: (args) => call(provisionEnvironmentCommand, args),
    startContainer: (args) => call(dockerStartContainerCommand, args),
    stopContainer: (args) => call(dockerStopContainerCommand, args),
    removeContainer: (args) => call(dockerRemoveContainerCommand, args),
    containerStatus: (args) => call(dockerContainerStatusCommand, args),
    containerLogs: (args) => call(getContainerLogsCommand, args),
    openContainerLogs: (args) => call(openContainerLogsCommand, args),
    readContainerLogs: (args) => call(readContainerLogsCommand, args),
    closeContainerLogs: (args) => call(closeContainerLogsCommand, args),
    systemStats: () => call(getDockerSystemStatsCommand, {}),
    capacity: (args) => call(getDockerCapacityCommand, args),
    containerUsage: () => call(getContainerUsageCommand, {}),
    orkestratorContainers: () => call(getOrkestratorContainersCommand, {}),
    cleanupPreview: () => call(dockerCleanupPreviewCommand, {}),
    cleanupExecute: (args) => call(dockerCleanupExecuteCommand, args),
    reattachContainer: (args) => call(reattachContainerCommand, args),
    propagateGithubToken: () => call(propagateGithubTokenToContainersCommand, {}),
  };
}

export const dockerClient = domainClient(dockerDomain, {
  2: dockerApi,
});
