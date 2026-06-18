import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AppConfig,
  Environment,
  EnvironmentStatus,
  EnvironmentType,
  PortMapping,
  PrState,
  Project,
  RepositoryConfig,
  Session,
  SessionType,
} from "./models.js";

export type JsonRecord = Record<string, unknown>;

type KanbanComment = {
  id: string;
  text: string;
  createdAt: string;
};

type KanbanImage = {
  id: string;
  filename: string;
  createdAt: string;
};

type KanbanStatus = "backlog" | "in-progress" | "review" | "done";

type KanbanTask = {
  id: string;
  projectId: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  status: KanbanStatus;
  comments: KanbanComment[];
  images: KanbanImage[];
  createdAt: string;
  order: number;
  environmentId?: string;
  buildPipelineId?: string;
  prUrl?: string;
  prState?: PrState;
  prMergeCommented?: boolean;
};

type ProjectNotes = {
  projectId: string;
  content: string;
  updatedAt: string;
};

async function resizeKanbanImage(rawBytes: Buffer): Promise<Buffer> {
  const { default: sharp } = await import("sharp");
  return sharp(rawBytes).resize({ width: 2000, height: 2000, fit: "inside", withoutEnlargement: true }).webp().toBuffer();
}

const MAX_JSON_BACKUPS = 5;
const MAX_SESSIONS_PER_ENVIRONMENT = 20;

const DEFAULT_ALLOWED_DOMAINS = [
  "github.com",
  "api.github.com",
  "registry.npmjs.org",
  "bun.sh",
  "api.anthropic.com",
  "sentry.io",
  "statsig.anthropic.com",
  "statsig.com",
  "marketplace.visualstudio.com",
  "vscode.blob.core.windows.net",
  "update.code.visualstudio.com",
  "mcp.context7.com",
];

function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return asOptionalString(value);
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function slugify(value: string, fallback: string, maxLength = 0): string {
  let out = "";
  let lastHyphen = false;

  for (const char of value) {
    if (/^[a-zA-Z0-9_]$/.test(char)) {
      out += char.toLowerCase();
      lastHyphen = false;
    } else if (char === "-" || char === " " || char === "." || char === "/") {
      if (!lastHyphen && out.length > 0) {
        out += "-";
        lastHyphen = true;
      }
    }
  }

  out = out.replace(/^-+/, "").replace(/-+$/, "");
  if (maxLength > 0 && out.length > maxLength) {
    out = out.slice(0, maxLength).replace(/-+$/, "");
  }
  return out || fallback;
}

export function sanitizeEnvironmentName(value: string): string {
  return slugify(value, "env", 100);
}

export function sanitizeBranchName(value: string): string {
  return slugify(value, "env");
}

export function extractRepoName(gitUrl: string): string {
  const trimmed = gitUrl.trim().replace(/\.git$/, "");
  const slashPart = trimmed.split("/").filter(Boolean).at(-1);
  if (slashPart) return slashPart;
  const colonPart = trimmed.split(":").filter(Boolean).at(-1);
  return colonPart || trimmed;
}

export function defaultConfig(): AppConfig {
  return {
    version: "1.0.0",
    global: {
      containerResources: { cpuCores: 2, memoryGb: 4 },
      envFilePatterns: [".env", ".env.local"],
      allowedDomains: [...DEFAULT_ALLOWED_DOMAINS],
      defaultAgent: "claude",
      opencodeModel: "opencode/grok-code",
      claudeModel: "claude-sonnet-4-6",
      codexModel: "gpt-5.3-codex",
      codexReasoningEffort: "medium",
      opencodeMode: "terminal",
      claudeMode: "terminal",
      claudeNativeBackend: "sdk",
      claudeNativeFastModeDefault: false,
      codexMode: "native",
      codexNativeFastModeDefault: false,
      terminalAppearance: {
        fontFamily: "FiraCode Nerd Font",
        fontSize: 14,
        backgroundColor: "#1e1e1e",
      },
      terminalScrollback: 1000,
      experimentalCodexRawEventLogging: true,
      debugLogging: false,
    },
    repositories: {},
  };
}

export function defaultRepositoryConfig(): RepositoryConfig {
  return {
    defaultBranch: "main",
    prBaseBranch: "main",
  };
}

export function createProject(gitUrl: string, localPath?: string): Project {
  return {
    id: randomUUID(),
    name: extractRepoName(gitUrl),
    gitUrl,
    localPath: localPath ?? null,
    addedAt: nowIso(),
    order: 0,
  };
}

export function createEnvironment(
  projectId: string,
  options: {
    name?: string;
    networkAccessMode?: "full" | "restricted";
    initialPrompt?: string;
    portMappings?: PortMapping[];
    environmentType?: EnvironmentType;
    entryPort?: number;
  } = {},
): Environment {
  const rawName =
    options.name?.trim() || new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 15);
  const name = sanitizeEnvironmentName(rawName);
  const environmentType = options.environmentType ?? "containerized";

  return {
    id: randomUUID(),
    projectId,
    name,
    branch: sanitizeBranchName(name),
    containerId: null,
    status: "stopped",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: nowIso(),
    networkAccessMode: options.networkAccessMode ?? (environmentType === "local" ? "full" : "restricted"),
    allowedDomains: undefined,
    order: 0,
    portMappings: options.portMappings,
    entryPort: options.entryPort,
    hostEntryPort: undefined,
    environmentType,
    worktreePath: undefined,
    opencodePid: undefined,
    claudeBridgePid: undefined,
    codexBridgePid: undefined,
    localOpencodePort: undefined,
    localClaudePort: undefined,
    localCodexPort: undefined,
    defaultAgent: undefined,
    claudeMode: undefined,
    claudeNativeBackend: undefined,
    opencodeMode: undefined,
    codexMode: undefined,
    setupScriptsComplete: false,
    initialPrompt: options.initialPrompt,
  };
}

function createSessionObject(
  environmentId: string,
  containerId: string,
  tabId: string,
  sessionType: SessionType,
): Session {
  const now = nowIso();
  return {
    id: randomUUID(),
    environmentId,
    containerId,
    tabId,
    sessionType,
    status: "connected",
    createdAt: now,
    lastActivityAt: now,
    order: 0,
    hasLaunchedCommand: false,
  };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export class StorageService {
  private readonly dataDir: string;
  private writeQueue = Promise.resolve();

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  getDataDir(): string {
    return this.dataDir;
  }

  getLogDirectory(): string {
    return path.join(this.dataDir, "logs");
  }

  private file(name: string): string {
    return path.join(this.dataDir, name);
  }

  private projectsFile(): string {
    return this.file("projects.json");
  }

  private environmentsFile(): string {
    return this.file("environments.json");
  }

  private configFile(): string {
    return this.file("config.json");
  }

  private sessionsFile(): string {
    return this.file("sessions.json");
  }

  private kanbanFile(): string {
    return this.file("kanban.json");
  }

  private projectNotesFile(): string {
    return this.file("project-notes.json");
  }

  private buffersDir(): string {
    return path.join(this.dataDir, "buffers");
  }

  private bufferFile(sessionId: string): string {
    return path.join(this.buffersDir(), `${sessionId}.txt`);
  }

  private kanbanImagesDir(): string {
    return path.join(this.dataDir, "kanban-images");
  }

  private kanbanImageFile(imageId: string): string {
    return path.join(this.kanbanImagesDir(), `${imageId}.webp`);
  }

  async init(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
  }

  private async writeAtomic(filePath: string, contents: string, makeBackup = true): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);

    await this.enqueueWrite(async () => {
      await fs.writeFile(tempPath, contents);
      if (makeBackup && await exists(filePath)) {
        await this.rotateBackups(filePath);
      }
      await fs.rename(tempPath, filePath);
    }).catch(async (error) => {
      if (await exists(tempPath)) {
        await fs.rm(tempPath, { force: true });
      }
      throw error;
    });
  }

  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(operation, operation);
    this.writeQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  private backupPath(filePath: string, index: number): string {
    return path.join(path.dirname(filePath), `${path.basename(filePath)}.bak.${index}`);
  }

  private async rotateBackups(filePath: string): Promise<void> {
    for (let index = MAX_JSON_BACKUPS - 1; index >= 1; index -= 1) {
      const current = this.backupPath(filePath, index);
      const next = this.backupPath(filePath, index + 1);
      if (await exists(next)) await fs.rm(next, { force: true });
      if (await exists(current)) await fs.rename(current, next);
    }

    const first = this.backupPath(filePath, 1);
    if (await exists(first)) await fs.rm(first, { force: true });
    await fs.copyFile(filePath, first);
  }

  private async loadJson<T>(filePath: string, fallback: () => T): Promise<T> {
    if (!await exists(filePath)) return fallback();

    try {
      const raw = await fs.readFile(filePath, "utf8");
      if (!raw.trim()) return fallback();
      return JSON.parse(raw) as T;
    } catch {
      for (let index = 1; index <= MAX_JSON_BACKUPS; index += 1) {
        const backup = this.backupPath(filePath, index);
        if (!await exists(backup)) continue;
        try {
          return JSON.parse(await fs.readFile(backup, "utf8")) as T;
        } catch {
          continue;
        }
      }
      return fallback();
    }
  }

  private async saveJson(filePath: string, value: unknown): Promise<void> {
    await this.writeAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
  }

  async loadProjects(): Promise<Project[]> {
    const projects = await this.loadJson<Project[]>(this.projectsFile(), () => []);
    return projects.sort((a, b) => a.order - b.order);
  }

  async addProject(project: Project): Promise<Project> {
    const projects = await this.loadProjects();
    if (projects.some((candidate) => candidate.gitUrl === project.gitUrl)) {
      throw new Error(`Duplicate project URL: ${project.gitUrl}`);
    }

    project.order = Math.max(-1, ...projects.map((item) => item.order)) + 1;
    projects.push(project);
    await this.saveJson(this.projectsFile(), projects);
    return project;
  }

  async removeProject(projectId: string): Promise<void> {
    const projects = await this.loadProjects();
    const filtered = projects.filter((project) => project.id !== projectId);
    if (filtered.length === projects.length) throw new Error(`Project not found: ${projectId}`);
    await this.saveJson(this.projectsFile(), filtered);
  }

  async getProject(projectId: string): Promise<Project | null> {
    return (await this.loadProjects()).find((project) => project.id === projectId) ?? null;
  }

  async updateProject(projectId: string, updates: Partial<Pick<Project, "name" | "localPath">>): Promise<Project> {
    const projects = await this.loadProjects();
    const project = projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    if (typeof updates.name === "string") project.name = updates.name;
    if ("localPath" in updates) project.localPath = updates.localPath ?? null;
    await this.saveJson(this.projectsFile(), projects);
    return project;
  }

  async reorderProjects(projectIds: string[]): Promise<Project[]> {
    const projects = await this.loadProjects();
    const provided = new Set(projectIds);
    for (const [index, id] of projectIds.entries()) {
      const project = projects.find((candidate) => candidate.id === id);
      if (project) project.order = index;
    }

    let order = projectIds.length;
    for (const project of projects) {
      if (!provided.has(project.id)) project.order = order++;
    }

    await this.saveJson(this.projectsFile(), projects);
    return projects.sort((a, b) => a.order - b.order);
  }

  async loadEnvironments(): Promise<Environment[]> {
    const environments = await this.loadJson<Environment[]>(this.environmentsFile(), () => []);
    return environments.sort((a, b) => a.order - b.order);
  }

  async getEnvironmentsByProject(projectId: string): Promise<Environment[]> {
    return (await this.loadEnvironments()).filter((environment) => environment.projectId === projectId);
  }

  async getEnvironment(environmentId: string): Promise<Environment | null> {
    return (await this.loadEnvironments()).find((environment) => environment.id === environmentId) ?? null;
  }

  async addEnvironment(environment: Environment): Promise<Environment> {
    const environments = await this.loadEnvironments();
    environment.order =
      Math.max(-1, ...environments.filter((item) => item.projectId === environment.projectId).map((item) => item.order)) + 1;
    environments.push(environment);
    await this.saveJson(this.environmentsFile(), environments);
    return environment;
  }

  async removeEnvironment(environmentId: string): Promise<void> {
    const environments = await this.loadEnvironments();
    const filtered = environments.filter((environment) => environment.id !== environmentId);
    if (filtered.length === environments.length) throw new Error(`Environment not found: ${environmentId}`);
    await this.saveJson(this.environmentsFile(), filtered);
  }

  async updateEnvironment(environmentId: string, updates: JsonRecord): Promise<Environment> {
    const environments = await this.loadEnvironments();
    const environment = environments.find((candidate) => candidate.id === environmentId);
    if (!environment) throw new Error(`Environment not found: ${environmentId}`);

    const stringFields = [
      "name",
      "branch",
      "status",
      "environmentType",
      "worktreePath",
      "defaultAgent",
      "claudeMode",
      "claudeNativeBackend",
      "opencodeMode",
      "codexMode",
      "initialPrompt",
    ] as const;
    for (const field of stringFields) {
      if (field in updates) {
        (environment as unknown as Record<string, unknown>)[field] = asNullableString(updates[field]) ?? undefined;
      }
    }

    if ("containerId" in updates) environment.containerId = asNullableString(updates.containerId) ?? null;
    if ("prUrl" in updates) environment.prUrl = asNullableString(updates.prUrl) ?? null;
    if ("prState" in updates) environment.prState = (asNullableString(updates.prState) as PrState | null | undefined) ?? null;
    if ("hasMergeConflicts" in updates) environment.hasMergeConflicts = asOptionalBoolean(updates.hasMergeConflicts) ?? null;
    if ("allowedDomains" in updates) environment.allowedDomains = Array.isArray(updates.allowedDomains) ? updates.allowedDomains.filter((value): value is string => typeof value === "string") : undefined;
    if ("portMappings" in updates) environment.portMappings = Array.isArray(updates.portMappings) ? updates.portMappings as PortMapping[] : undefined;
    if ("opencodePid" in updates) environment.opencodePid = asOptionalNumber(updates.opencodePid);
    if ("claudeBridgePid" in updates) environment.claudeBridgePid = asOptionalNumber(updates.claudeBridgePid);
    if ("codexBridgePid" in updates) environment.codexBridgePid = asOptionalNumber(updates.codexBridgePid);
    if ("localOpencodePort" in updates) environment.localOpencodePort = asOptionalNumber(updates.localOpencodePort);
    if ("localClaudePort" in updates) environment.localClaudePort = asOptionalNumber(updates.localClaudePort);
    if ("localCodexPort" in updates) environment.localCodexPort = asOptionalNumber(updates.localCodexPort);
    if ("entryPort" in updates) environment.entryPort = asOptionalNumber(updates.entryPort);
    if ("hostEntryPort" in updates) environment.hostEntryPort = asOptionalNumber(updates.hostEntryPort);
    if ("setupScriptsComplete" in updates) environment.setupScriptsComplete = asOptionalBoolean(updates.setupScriptsComplete) ?? false;
    if ("networkAccessMode" in updates && (updates.networkAccessMode === "full" || updates.networkAccessMode === "restricted")) {
      environment.networkAccessMode = updates.networkAccessMode;
    }

    await this.saveJson(this.environmentsFile(), environments);
    return environment;
  }

  async reorderEnvironments(projectId: string, environmentIds: string[]): Promise<Environment[]> {
    const environments = await this.loadEnvironments();
    const provided = new Set(environmentIds);
    for (const [index, id] of environmentIds.entries()) {
      const environment = environments.find((candidate) => candidate.id === id && candidate.projectId === projectId);
      if (environment) environment.order = index;
    }

    let order = environmentIds.length;
    for (const environment of environments) {
      if (environment.projectId === projectId && !provided.has(environment.id)) environment.order = order++;
    }

    await this.saveJson(this.environmentsFile(), environments);
    return environments.filter((environment) => environment.projectId === projectId).sort((a, b) => a.order - b.order);
  }

  async loadConfig(): Promise<AppConfig> {
    return this.loadJson<AppConfig>(this.configFile(), defaultConfig);
  }

  async saveConfig(config: AppConfig): Promise<void> {
    await this.saveJson(this.configFile(), config);
  }

  async getRepositoryConfig(projectId: string): Promise<RepositoryConfig> {
    const config = await this.loadConfig();
    return config.repositories[projectId] ?? defaultRepositoryConfig();
  }

  async updateRepositoryConfig(projectId: string, repoConfig: RepositoryConfig): Promise<AppConfig> {
    const config = await this.loadConfig();
    config.repositories[projectId] = { ...defaultRepositoryConfig(), ...repoConfig };
    await this.saveConfig(config);
    return config;
  }

  async updateGlobalConfig(globalConfig: AppConfig["global"]): Promise<AppConfig> {
    const config = await this.loadConfig();
    config.global = globalConfig;
    await this.saveConfig(config);
    return config;
  }

  async createSession(environmentId: string, containerId: string, tabId: string, sessionType: SessionType): Promise<Session> {
    const sessions = await this.loadJson<Session[]>(this.sessionsFile(), () => []);
    const session = createSessionObject(environmentId, containerId, tabId, sessionType);
    const envSessions = sessions.filter((candidate) => candidate.environmentId === environmentId);
    session.order = Math.max(-1, ...envSessions.map((candidate) => candidate.order)) + 1;

    if (envSessions.length >= MAX_SESSIONS_PER_ENVIRONMENT) {
      const oldestDisconnected = envSessions
        .filter((candidate) => candidate.status === "disconnected")
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      if (oldestDisconnected) {
        const index = sessions.findIndex((candidate) => candidate.id === oldestDisconnected.id);
        if (index >= 0) sessions.splice(index, 1);
        await this.deleteSessionBuffer(oldestDisconnected.id);
      }
    }

    sessions.push(session);
    await this.saveJson(this.sessionsFile(), sessions);
    return session;
  }

  async getSession(sessionId: string): Promise<Session | null> {
    const sessions = await this.loadJson<Session[]>(this.sessionsFile(), () => []);
    return sessions.find((session) => session.id === sessionId) ?? null;
  }

  async getSessionsByEnvironment(environmentId: string): Promise<Session[]> {
    const sessions = await this.loadJson<Session[]>(this.sessionsFile(), () => []);
    return sessions.filter((session) => session.environmentId === environmentId).sort((a, b) => a.order - b.order);
  }

  async updateSession(sessionId: string, updates: Partial<Session>): Promise<Session> {
    const sessions = await this.loadJson<Session[]>(this.sessionsFile(), () => []);
    const session = sessions.find((candidate) => candidate.id === sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    Object.assign(session, updates);
    await this.saveJson(this.sessionsFile(), sessions);
    return session;
  }

  async removeSession(sessionId: string): Promise<void> {
    const sessions = await this.loadJson<Session[]>(this.sessionsFile(), () => []);
    const filtered = sessions.filter((session) => session.id !== sessionId);
    if (filtered.length === sessions.length) throw new Error(`Session not found: ${sessionId}`);
    await this.saveJson(this.sessionsFile(), filtered);
    await this.deleteSessionBuffer(sessionId);
  }

  async removeSessionsByEnvironment(environmentId: string): Promise<string[]> {
    const sessions = await this.loadJson<Session[]>(this.sessionsFile(), () => []);
    const removed = sessions.filter((session) => session.environmentId === environmentId).map((session) => session.id);
    await this.saveJson(this.sessionsFile(), sessions.filter((session) => session.environmentId !== environmentId));
    await Promise.all(removed.map((sessionId) => this.deleteSessionBuffer(sessionId)));
    return removed;
  }

  async disconnectEnvironmentSessions(environmentId: string): Promise<Session[]> {
    const sessions = await this.loadJson<Session[]>(this.sessionsFile(), () => []);
    const updated: Session[] = [];
    for (const session of sessions) {
      if (session.environmentId === environmentId && session.status === "connected") {
        session.status = "disconnected";
        updated.push(session);
      }
    }
    await this.saveJson(this.sessionsFile(), sessions);
    return updated;
  }

  async reorderSessions(environmentId: string, sessionIds: string[]): Promise<Session[]> {
    const sessions = await this.loadJson<Session[]>(this.sessionsFile(), () => []);
    const provided = new Set(sessionIds);
    for (const [index, id] of sessionIds.entries()) {
      const session = sessions.find((candidate) => candidate.id === id && candidate.environmentId === environmentId);
      if (session) session.order = index;
    }
    let order = sessionIds.length;
    for (const session of sessions) {
      if (session.environmentId === environmentId && !provided.has(session.id)) session.order = order++;
    }
    await this.saveJson(this.sessionsFile(), sessions);
    return this.getSessionsByEnvironment(environmentId);
  }

  async saveSessionBuffer(sessionId: string, buffer: string): Promise<void> {
    await fs.mkdir(this.buffersDir(), { recursive: true });
    const maxBufferSize = 500 * 1024;
    const contents = buffer.length > maxBufferSize ? buffer.slice(buffer.length - maxBufferSize) : buffer;
    await fs.writeFile(this.bufferFile(sessionId), contents);
  }

  async loadSessionBuffer(sessionId: string): Promise<string | null> {
    const filePath = this.bufferFile(sessionId);
    if (!await exists(filePath)) return null;
    return fs.readFile(filePath, "utf8");
  }

  async deleteSessionBuffer(sessionId: string): Promise<void> {
    await fs.rm(this.bufferFile(sessionId), { force: true });
  }

  async cleanupOrphanedBuffers(): Promise<string[]> {
    if (!await exists(this.buffersDir())) return [];
    const sessions = await this.loadJson<Session[]>(this.sessionsFile(), () => []);
    const sessionIds = new Set(sessions.map((session) => session.id));
    const deleted: string[] = [];
    for (const entry of await fs.readdir(this.buffersDir())) {
      const sessionId = path.basename(entry, path.extname(entry));
      if (!sessionIds.has(sessionId)) {
        await fs.rm(path.join(this.buffersDir(), entry), { force: true });
        deleted.push(sessionId);
      }
    }
    return deleted;
  }

  async getKanbanTasks(projectId: string): Promise<KanbanTask[]> {
    const tasks = await this.loadJson<KanbanTask[]>(this.kanbanFile(), () => []);
    return tasks.filter((task) => task.projectId === projectId);
  }

  async addKanbanTask(projectId: string, title: string, description: string): Promise<KanbanTask> {
    const tasks = await this.loadJson<KanbanTask[]>(this.kanbanFile(), () => []);
    const task: KanbanTask = {
      id: randomUUID(),
      projectId,
      title,
      description,
      acceptanceCriteria: "",
      status: "backlog",
      comments: [],
      images: [],
      createdAt: nowIso(),
      order: Math.max(-1, ...tasks.filter((candidate) => candidate.projectId === projectId && candidate.status === "backlog").map((candidate) => candidate.order)) + 1,
      prMergeCommented: false,
    };
    tasks.push(task);
    await this.saveJson(this.kanbanFile(), tasks);
    return task;
  }

  async updateKanbanTask(taskId: string, updates: Partial<KanbanTask>): Promise<KanbanTask> {
    const tasks = await this.loadJson<KanbanTask[]>(this.kanbanFile(), () => []);
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new Error(`Kanban task not found: ${taskId}`);

    const oldStatus = task.status;
    Object.assign(task, updates);
    if (updates.status && updates.status !== oldStatus) {
      task.order = Math.max(-1, ...tasks.filter((candidate) => candidate.projectId === task.projectId && candidate.status === updates.status && candidate.id !== taskId).map((candidate) => candidate.order)) + 1;
    }
    await this.saveJson(this.kanbanFile(), tasks);
    return task;
  }

  async deleteKanbanTask(taskId: string): Promise<void> {
    const tasks = await this.loadJson<KanbanTask[]>(this.kanbanFile(), () => []);
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new Error(`Kanban task not found: ${taskId}`);
    await Promise.all(task.images.map((image) => fs.rm(this.kanbanImageFile(image.id), { force: true })));
    await this.saveJson(this.kanbanFile(), tasks.filter((candidate) => candidate.id !== taskId));
  }

  async addKanbanComment(taskId: string, text: string): Promise<KanbanTask> {
    const tasks = await this.loadJson<KanbanTask[]>(this.kanbanFile(), () => []);
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new Error(`Kanban task not found: ${taskId}`);
    task.comments.push({ id: randomUUID(), text, createdAt: nowIso() });
    await this.saveJson(this.kanbanFile(), tasks);
    return task;
  }

  async deleteKanbanComment(taskId: string, commentId: string): Promise<KanbanTask> {
    const tasks = await this.loadJson<KanbanTask[]>(this.kanbanFile(), () => []);
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new Error(`Kanban task not found: ${taskId}`);
    task.comments = task.comments.filter((comment) => comment.id !== commentId);
    await this.saveJson(this.kanbanFile(), tasks);
    return task;
  }

  async addKanbanImage(taskId: string, filename: string, data: string): Promise<KanbanTask> {
    const tasks = await this.loadJson<KanbanTask[]>(this.kanbanFile(), () => []);
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new Error(`Kanban task not found: ${taskId}`);

    const rawBytes = Buffer.from(data, "base64");
    const webpBytes = await resizeKanbanImage(rawBytes);
    await fs.mkdir(this.kanbanImagesDir(), { recursive: true });
    const image: KanbanImage = { id: randomUUID(), filename, createdAt: nowIso() };
    await fs.writeFile(this.kanbanImageFile(image.id), webpBytes);
    task.images.push(image);
    await this.saveJson(this.kanbanFile(), tasks);
    return task;
  }

  async deleteKanbanImage(taskId: string, imageId: string): Promise<KanbanTask> {
    const tasks = await this.loadJson<KanbanTask[]>(this.kanbanFile(), () => []);
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new Error(`Kanban task not found: ${taskId}`);
    task.images = task.images.filter((image) => image.id !== imageId);
    await fs.rm(this.kanbanImageFile(imageId), { force: true });
    await this.saveJson(this.kanbanFile(), tasks);
    return task;
  }

  async getKanbanImageData(imageId: string): Promise<string> {
    return (await fs.readFile(this.kanbanImageFile(imageId))).toString("base64");
  }

  async getProjectNotes(projectId: string): Promise<ProjectNotes> {
    const notes = await this.loadJson<ProjectNotes[]>(this.projectNotesFile(), () => []);
    return notes.find((note) => note.projectId === projectId) ?? { projectId, content: "", updatedAt: nowIso() };
  }

  async saveProjectNotes(projectId: string, content: string): Promise<ProjectNotes> {
    const notes = await this.loadJson<ProjectNotes[]>(this.projectNotesFile(), () => []);
    let note = notes.find((candidate) => candidate.projectId === projectId);
    if (!note) {
      note = { projectId, content, updatedAt: nowIso() };
      notes.push(note);
    } else {
      note.content = content;
      note.updatedAt = nowIso();
    }
    await this.saveJson(this.projectNotesFile(), notes);
    return note;
  }

  async setAllEnvironmentStatusesForContainer(containerId: string, status: EnvironmentStatus): Promise<void> {
    const environments = await this.loadEnvironments();
    let changed = false;
    for (const environment of environments) {
      if (environment.containerId === containerId) {
        environment.status = status;
        changed = true;
      }
    }
    if (changed) await this.saveJson(this.environmentsFile(), environments);
  }
}

export function parseUpdateObject(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}
