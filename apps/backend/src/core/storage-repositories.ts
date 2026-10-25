import { AgentAccountsRepository } from "./storage-agent-accounts.js";
import { AgentMailRepository } from "./storage-agent-mail.js";
import { BuildPipelinesRepository } from "./storage-build-pipelines.js";
import { ConfigRepository } from "./storage-config.js";
import type { StorageContext } from "./storage-context.js";
import { CoordinatorsRepository } from "./storage-coordinators.js";
import { DraftsRepository } from "./storage-drafts.js";
import { StorageFiles } from "./storage-files.js";
import { KanbanRepository } from "./storage-kanban.js";
import { NativeAgentSessionsRepository } from "./storage-native.js";
import { NodesRepository } from "./storage-nodes.js";
import { PreviewServicesRepository } from "./storage-preview-services.js";
import { ProjectsRepository } from "./storage-projects.js";
import { PromptsRepository } from "./storage-prompts.js";
import { PublicOperationsRepository } from "./storage-public-operations.js";
import { ReviewsRepository } from "./storage-reviews.js";
import { SessionsRepository } from "./storage-sessions.js";

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
 * points `storage-writer-guards.test.ts` follows writes back to.
 */
export class StorageRepositories {
  readonly files: StorageFiles;
  readonly projects: ProjectsRepository;
  readonly config: ConfigRepository;
  readonly sessions: SessionsRepository;
  readonly reviews: ReviewsRepository;
  readonly nativeAgentSessions: NativeAgentSessionsRepository;
  readonly prompts: PromptsRepository;
  readonly buildPipelines: BuildPipelinesRepository;
  readonly drafts: DraftsRepository;
  readonly agentMail: AgentMailRepository;
  readonly kanban: KanbanRepository;
  readonly previewServices: PreviewServicesRepository;
  readonly nodes: NodesRepository;
  readonly publicOperations: PublicOperationsRepository;
  readonly coordinators: CoordinatorsRepository;
  readonly agentAccounts: AgentAccountsRepository;

  constructor(context: StorageContext) {
    const files = new StorageFiles(context.dataDir);
    this.files = files;
    this.projects = new ProjectsRepository(context, files, this);
    this.config = new ConfigRepository(context, files);
    this.sessions = new SessionsRepository(context, files, this);
    this.reviews = new ReviewsRepository(context, files, this);
    this.nativeAgentSessions = new NativeAgentSessionsRepository(context, files, this);
    this.prompts = new PromptsRepository(context, files, this);
    this.buildPipelines = new BuildPipelinesRepository(context, files, this);
    this.drafts = new DraftsRepository(context, files, this);
    this.agentMail = new AgentMailRepository(context, files, this);
    this.kanban = new KanbanRepository(context, files);
    this.previewServices = new PreviewServicesRepository(context);
    this.nodes = new NodesRepository(context);
    this.publicOperations = new PublicOperationsRepository(context, files, this);
    this.coordinators = new CoordinatorsRepository(context, files, this);
    this.agentAccounts = new AgentAccountsRepository(context);
  }
}
