/**
 * The `docker` domain client (plan item 7003; §11.2 "Client adapters"): one
 * method per command, over any command call.
 *
 * No docker command was ever capability-gated and the domain has no
 * capability command, so both adapters call the same commands. Version 1
 * sends the envelope (`operationId`/`expectedRevision` on
 * `provision_environment` and `selectionToken` on `docker_cleanup_execute`
 * are critical); version 0, for a node that advertises no `docker` range (a
 * pre-contract node, or a renderer client without negotiation), sends today's
 * `{ command, args }` and answers the result as sent, like the environments
 * client's version 0: an older node's answers are the shapes callers already
 * handle. Version 1 decodes results with the commands' schemas.
 *
 * Retirement: adapter 0 goes when the support floor passes the first Stable
 * release that advertises the `docker` domain.
 *
 * Browser-safe.
 */
import { domainClient, type CommandCall } from "../../client.js";
import type { AnyCommandDef, ArgsOf, ResultOf } from "../../command.js";
import {
  checkBaseImageCommand,
  checkContainerHostReachabilityCommand,
  checkDockerCommand,
  cleanupOrphanedContainersCommand,
  closeContainerLogsCommand,
  dockerCleanupExecuteCommand,
  dockerCleanupPreviewCommand,
  dockerContainerStatusCommand,
  dockerRemoveContainerCommand,
  dockerStartContainerCommand,
  dockerStopContainerCommand,
  dockerSystemPruneCommand,
  dockerVersionCommand,
  getContainerHostPortCommand,
  getContainerHostReachabilityCommand,
  getContainerLogsCommand,
  getContainerUsageCommand,
  getDockerCapacityCommand,
  getDockerImageStatusCommand,
  getDockerSystemStatsCommand,
  getDockerTopologyCommand,
  getOrkestratorContainersCommand,
  listDockerContainersCommand,
  openContainerLogsCommand,
  propagateGithubTokenToContainersCommand,
  provisionEnvironmentCommand,
  readContainerLogsCommand,
  reattachContainerCommand,
  streamContainerLogsCommand,
} from "./commands.js";
import { dockerDomain } from "./domain.js";
import { answeredAsSent } from "../environments/client.js";

type Call<C extends AnyCommandDef> = (args: ArgsOf<C>) => Promise<ResultOf<C>>;
type NoArgsCall<C extends AnyCommandDef> = () => Promise<ResultOf<C>>;

export interface DockerApi {
  checkDocker: NoArgsCall<typeof checkDockerCommand>;
  dockerVersion: NoArgsCall<typeof dockerVersionCommand>;
  imageStatus: NoArgsCall<typeof getDockerImageStatusCommand>;
  hostReachability: NoArgsCall<typeof getContainerHostReachabilityCommand>;
  checkHostReachability: NoArgsCall<typeof checkContainerHostReachabilityCommand>;
  topology: Call<typeof getDockerTopologyCommand>;
  checkBaseImage: NoArgsCall<typeof checkBaseImageCommand>;
  provisionEnvironment: Call<typeof provisionEnvironmentCommand>;
  startContainer: Call<typeof dockerStartContainerCommand>;
  stopContainer: Call<typeof dockerStopContainerCommand>;
  removeContainer: Call<typeof dockerRemoveContainerCommand>;
  containerStatus: Call<typeof dockerContainerStatusCommand>;
  listContainers: NoArgsCall<typeof listDockerContainersCommand>;
  containerHostPort: Call<typeof getContainerHostPortCommand>;
  containerLogs: Call<typeof getContainerLogsCommand>;
  openContainerLogs: Call<typeof openContainerLogsCommand>;
  readContainerLogs: Call<typeof readContainerLogsCommand>;
  closeContainerLogs: Call<typeof closeContainerLogsCommand>;
  streamContainerLogs: Call<typeof streamContainerLogsCommand>;
  systemPrune: NoArgsCall<typeof dockerSystemPruneCommand>;
  systemStats: NoArgsCall<typeof getDockerSystemStatsCommand>;
  capacity: Call<typeof getDockerCapacityCommand>;
  containerUsage: NoArgsCall<typeof getContainerUsageCommand>;
  orkestratorContainers: NoArgsCall<typeof getOrkestratorContainersCommand>;
  cleanupPreview: NoArgsCall<typeof dockerCleanupPreviewCommand>;
  cleanupExecute: Call<typeof dockerCleanupExecuteCommand>;
  cleanupOrphanedContainers: NoArgsCall<typeof cleanupOrphanedContainersCommand>;
  reattachContainer: Call<typeof reattachContainerCommand>;
  propagateGithubToken: NoArgsCall<typeof propagateGithubTokenToContainersCommand>;
}

/** The API over any command call: both adapters, and a node's own local commands. */
export function dockerApi(call: CommandCall): DockerApi {
  return {
    checkDocker: () => call(checkDockerCommand, {}),
    dockerVersion: () => call(dockerVersionCommand, {}),
    imageStatus: () => call(getDockerImageStatusCommand, {}),
    hostReachability: () => call(getContainerHostReachabilityCommand, {}),
    checkHostReachability: () => call(checkContainerHostReachabilityCommand, {}),
    topology: (args) => call(getDockerTopologyCommand, args),
    checkBaseImage: () => call(checkBaseImageCommand, {}),
    provisionEnvironment: (args) => call(provisionEnvironmentCommand, args),
    startContainer: (args) => call(dockerStartContainerCommand, args),
    stopContainer: (args) => call(dockerStopContainerCommand, args),
    removeContainer: (args) => call(dockerRemoveContainerCommand, args),
    containerStatus: (args) => call(dockerContainerStatusCommand, args),
    listContainers: () => call(listDockerContainersCommand, {}),
    containerHostPort: (args) => call(getContainerHostPortCommand, args),
    containerLogs: (args) => call(getContainerLogsCommand, args),
    openContainerLogs: (args) => call(openContainerLogsCommand, args),
    readContainerLogs: (args) => call(readContainerLogsCommand, args),
    closeContainerLogs: (args) => call(closeContainerLogsCommand, args),
    streamContainerLogs: (args) => call(streamContainerLogsCommand, args),
    systemPrune: () => call(dockerSystemPruneCommand, {}),
    systemStats: () => call(getDockerSystemStatsCommand, {}),
    capacity: (args) => call(getDockerCapacityCommand, args),
    containerUsage: () => call(getContainerUsageCommand, {}),
    orkestratorContainers: () => call(getOrkestratorContainersCommand, {}),
    cleanupPreview: () => call(dockerCleanupPreviewCommand, {}),
    cleanupExecute: (args) => call(dockerCleanupExecuteCommand, args),
    cleanupOrphanedContainers: () => call(cleanupOrphanedContainersCommand, {}),
    reattachContainer: (args) => call(reattachContainerCommand, args),
    propagateGithubToken: () => call(propagateGithubTokenToContainersCommand, {}),
  };
}

export const dockerClient = domainClient(dockerDomain, {
  1: dockerApi,
  // Today's call, answered as sent (`answeredAsSent`, as the environments client).
  0: (_call, context) => dockerApi(answeredAsSent(context)),
});
