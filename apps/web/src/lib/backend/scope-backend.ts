/**
 * Every `@/lib/backend` command function for one node scope (plan item 4001).
 *
 * The named exports of `@/lib/backend` are the command-scope shim (plan item
 * 3002): they reach the command node whichever node a component shows. A
 * component in a node's workspace calls `backendForScope(scope).fn(...)`
 * instead. On the app's command scope this is the `@/lib/backend` module
 * itself, so suites that mock it or spy on its exports still see the call;
 * any other scope gets each file's factory over `scopeBackendClient(scope)`
 * (its prefetched cache applies), laid over the module so constants and
 * helpers that send nothing stay available. Made once per scope.
 *
 * Prefer `backendApiForScope(scope, createXApi, backend)` where one file's
 * functions are enough; this is for components with calls into many files.
 */

import * as backend from "@/lib/backend";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { isAppCommandScope } from "@/lib/node-scope-slots";
import { scopeBackendClient } from "./client";
import { createProjectsEnvironmentsApi } from "./projects-environments";
import { createTerminalsApi } from "./terminals";
import { createConfigIntegrationsApi } from "./config-integrations";
import { createDockerSkillsApi } from "./docker-skills";
import { createSystemApi } from "./system";
import { createHostMaintenanceApi } from "./host-maintenance";
import { createFilesSessionsApi } from "./files-sessions";
import { createWorkflowsApi } from "./workflows";
import { createLaunchesApi } from "./launches";
import { createKanbanApi } from "./kanban";
import { createAgentMailApi } from "./agent-mail";
import { createCoordinatorApi } from "./coordinator";
import { createClientStateApi } from "./client-state";
import { createPreviewsApi } from "./previews";
import { createMcpManagementApi } from "./mcp-management";
import { createAgentAccountsApi } from "./agent-accounts";
import { createOpencodeProviderAuthApi } from "./opencode-provider-auth";
import { createDiskUsageApi } from "./disk-usage";
import { createUsageApi } from "./usage";
import { createTranscriptArtifactsApi } from "./transcript-artifacts";
import { createChangesApi } from "./changes";
import { createMachineProfileApi } from "./machine-profile";
import { createGithubPullRequestsApi } from "./github-pull-requests";
import { createScheduledJobsApi } from "./scheduled-jobs";
import { createUserCommandsApi } from "./user-commands";
import { createPermissionRulesApi } from "./permission-rules";
import { createBugReportApi } from "./bug-report";
import { createGraphRunsApi } from "./graph-runs";
import { createGraphTemplatesApi } from "./graph-templates";
import { createGraphTemplateSharingApi } from "./graph-template-sharing";
import { createAgentHandoffsApi } from "./agent-handoffs";

export type ScopeBackend = typeof backend;

const FACTORIES = [
  createProjectsEnvironmentsApi,
  createTerminalsApi,
  createConfigIntegrationsApi,
  createDockerSkillsApi,
  createSystemApi,
  createHostMaintenanceApi,
  createFilesSessionsApi,
  createWorkflowsApi,
  createLaunchesApi,
  createKanbanApi,
  createAgentMailApi,
  createCoordinatorApi,
  createClientStateApi,
  createPreviewsApi,
  createMcpManagementApi,
  createAgentAccountsApi,
  createOpencodeProviderAuthApi,
  createDiskUsageApi,
  createUsageApi,
  createTranscriptArtifactsApi,
  createChangesApi,
  createMachineProfileApi,
  createGithubPullRequestsApi,
  createScheduledJobsApi,
  createUserCommandsApi,
  createPermissionRulesApi,
  createBugReportApi,
  createGraphRunsApi,
  createGraphTemplatesApi,
  createGraphTemplateSharingApi,
  createAgentHandoffsApi,
] as const;

const perScope = new WeakMap<NodeScope, ScopeBackend>();

export function backendForScope(scope: NodeScope): ScopeBackend {
  if (isAppCommandScope(scope)) return backend;
  let api = perScope.get(scope);
  if (!api) {
    const client = scopeBackendClient(scope);
    api = Object.freeze(
      Object.assign({}, backend, ...FACTORIES.map((create) => create(client))),
    ) as ScopeBackend;
    perScope.set(scope, api);
  }
  return api;
}
