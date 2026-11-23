import { AgentAccountsRepository } from "./agent-accounts.js";
import { AgentMailBudgets } from "./agent-mail-budgets.js";
import { AgentMailboxDirectory } from "./agent-mail-directory.js";
import { AgentMailInjects } from "./agent-mail-injects.js";
import { AgentMailStore } from "./agent-mail-store.js";
import { AgentMailRepository } from "./agent-mail.js";
import { BugReportsRepository } from "./bug-reports.js";
import { CapabilitiesRepository } from "./capabilities.js";
import { BuildPipelinesRepository } from "./build-pipelines.js";
import { ConfigRepository } from "./config.js";
import type { StorageContext } from "./context.js";
import { CoordinatorsRepository } from "./coordinators.js";
import { DraftsRepository } from "./drafts.js";
import { GraphTemplatesRepository } from "./graph-templates.js";
import { GraphRunsRepository } from "./graph-runs.js";
import { GraphEffectsRepository } from "./graph-effects.js";
import { GraphDescribeRepository } from "./graph-describe.js";
import { SuborksRepository } from "./suborks.js";
import { ClientStateRepository } from "./client-state.js";
import { SetupApprovalsRepository } from "./setup-approvals.js";
import { EnvironmentIsolationRepository } from "./environment-isolation.js";
import { WatchedPullRequestsRepository } from "./watched-pull-requests.js";
import { MachineLoadHistoryRepository } from "./machine-load-history.js";
import { StorageFiles } from "./files.js";
import { KanbanRepository } from "./kanban.js";
import { KanbanBoardStore } from "./kanban-board.js";
import { KanbanSyncRepository } from "./kanban-sync-repository.js";
import { LinearRepository } from "./linear.js";
import { NativeAgentDeliveries } from "./native-deliveries.js";
import { NativeAgentSessionsRepository } from "./native.js";
import { NodesRepository } from "./nodes.js";
import { CoordinatorNoticesRepository } from "./coordinator-notices.js";
import { PreviewServicesRepository } from "./preview-services.js";
import { PromptQueueEditsRepository } from "./prompt-queue-edits.js";
import { PromptQueueStore } from "./prompt-queue-store.js";
import { ProjectsRepository } from "./projects.js";
import { PromptsRepository } from "./prompts.js";
import { PublicOperationsRepository } from "./public-operations.js";
import { ReviewsRepository } from "./reviews.js";
import { PermissionRulesRepository } from "./permission-rules.js";
import { RichInteractionsRepository } from "./rich-interactions.js";
import { CredentialsRepository } from "./credentials.js";
import { ScheduledJobsRepository } from "./scheduled-jobs.js";
import { SessionsRepository } from "./sessions.js";

/**
 * Every repository of one `StorageService`, over its one {@link StorageContext}.
 *
 * A repository reaches another through this registry (`this.repos.projects`)
 * rather than through a constructor argument of its own, because several
 * depend on each other: project removal deletes compose drafts, while drafts
 * read projects. Nothing calls a repository while the registry is being
 * built, so each one may hold it before the others exist.
 *
 * Only `StorageService` builds one. Code outside the storage files never
 * names a repository; it calls the facade, whose public methods are the entry
 * points `writer-guards.test.ts` follows writes back to.
 */
export class StorageRepositories {
  readonly scheduledJobs: ScheduledJobsRepository;
  readonly permissionRules: PermissionRulesRepository;
  readonly richInteractions: RichInteractionsRepository;
  readonly credentials: CredentialsRepository;
  readonly files: StorageFiles;
  readonly projects: ProjectsRepository;
  readonly config: ConfigRepository;
  readonly sessions: SessionsRepository;
  readonly reviews: ReviewsRepository;
  readonly nativeAgentSessions: NativeAgentSessionsRepository;
  readonly nativeAgentDeliveries: NativeAgentDeliveries;
  readonly promptQueues: PromptQueueStore;
  readonly promptQueueEdits: PromptQueueEditsRepository;
  readonly prompts: PromptsRepository;
  readonly buildPipelines: BuildPipelinesRepository;
  readonly drafts: DraftsRepository;
  readonly agentMail: AgentMailRepository;
  readonly agentMailboxes: AgentMailboxDirectory;
  readonly agentMailInjects: AgentMailInjects;
  readonly agentMailBudgets: AgentMailBudgets;
  readonly kanban: KanbanRepository;
  readonly ticketSync: KanbanSyncRepository;
  readonly linear: LinearRepository;
  readonly previewServices: PreviewServicesRepository;
  readonly nodes: NodesRepository;
  readonly coordinatorNotices: CoordinatorNoticesRepository;
  readonly publicOperations: PublicOperationsRepository;
  readonly coordinators: CoordinatorsRepository;
  readonly agentAccounts: AgentAccountsRepository;
  readonly bugReports: BugReportsRepository;
  readonly graphTemplates: GraphTemplatesRepository;
  readonly graphRuns: GraphRunsRepository;
  readonly graphEffects: GraphEffectsRepository;
  readonly graphDescribe: GraphDescribeRepository;
  readonly suborks: SuborksRepository;
  readonly clientState: ClientStateRepository;
  readonly setupApprovals: SetupApprovalsRepository;
  readonly environmentIsolation: EnvironmentIsolationRepository;
  readonly watchedPullRequests: WatchedPullRequestsRepository;
  readonly machineLoadHistory: MachineLoadHistoryRepository;
  readonly capabilities: CapabilitiesRepository;

  constructor(context: StorageContext) {
    const files = new StorageFiles(context.dataDir);
    this.files = files;
    this.scheduledJobs = new ScheduledJobsRepository(context);
    this.permissionRules = new PermissionRulesRepository(context);
    this.richInteractions = new RichInteractionsRepository(context);
    this.credentials = new CredentialsRepository(context);
    this.projects = new ProjectsRepository(context, files, this);
    this.agentAccounts = new AgentAccountsRepository(context);
    this.config = new ConfigRepository(context, files, this.agentAccounts);
    this.sessions = new SessionsRepository(context, files, this);
    this.reviews = new ReviewsRepository(context, files, this);
    this.nativeAgentSessions = new NativeAgentSessionsRepository(context, files, this);
    this.nativeAgentDeliveries = new NativeAgentDeliveries(context, files, this);
    this.promptQueues = new PromptQueueStore(context, files, this);
    this.promptQueueEdits = new PromptQueueEditsRepository(this);
    this.prompts = new PromptsRepository(context, files, this);
    this.buildPipelines = new BuildPipelinesRepository(context, files, this);
    this.drafts = new DraftsRepository(context, files, this);
    const mailStore = new AgentMailStore(context, files);
    this.agentMail = new AgentMailRepository(context, files, this, mailStore);
    this.agentMailboxes = new AgentMailboxDirectory(context, this, mailStore);
    this.agentMailInjects = new AgentMailInjects(context, this, mailStore);
    this.agentMailBudgets = new AgentMailBudgets(context, this, mailStore);
    const buildPipelines = this.buildPipelines;
    const kanbanBoard = new KanbanBoardStore(context, files, () =>
      buildPipelines.ticketsHeldByBuilds(),
    );
    this.kanban = new KanbanRepository(context, files, kanbanBoard);
    this.ticketSync = new KanbanSyncRepository(context, files, kanbanBoard);
    this.linear = new LinearRepository(context);
    this.previewServices = new PreviewServicesRepository(context);
    this.nodes = new NodesRepository(context);
    this.capabilities = new CapabilitiesRepository(context);
    this.coordinatorNotices = new CoordinatorNoticesRepository(context);
    this.publicOperations = new PublicOperationsRepository(context, files, this);
    this.coordinators = new CoordinatorsRepository(context, files, this);
    this.bugReports = new BugReportsRepository(context, files);
    this.graphTemplates = new GraphTemplatesRepository(context);
    this.graphRuns = new GraphRunsRepository(context, this);
    this.graphEffects = new GraphEffectsRepository(context, this);
    this.graphDescribe = new GraphDescribeRepository(context);
    this.suborks = new SuborksRepository(context, this);
    this.clientState = new ClientStateRepository(context);
    this.setupApprovals = new SetupApprovalsRepository(context);
    this.environmentIsolation = new EnvironmentIsolationRepository(context, this);
    this.watchedPullRequests = new WatchedPullRequestsRepository(context);
    this.machineLoadHistory = new MachineLoadHistoryRepository(context);
  }
}
