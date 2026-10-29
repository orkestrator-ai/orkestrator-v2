import {
  AGENT_PLATFORMS,
  isAgentPlatform,
  type AgentPlatform,
} from "@orkestrator/protocol/agent-platforms";
import { graphRoleProviderChoices } from "@orkestrator/protocol/graphs/agent-enforcement";
import {
  DEFAULT_GRAPH_CAPABILITY_CEILING,
  graphCapabilityCeilingIssues,
  type AgentEnforcementHost,
  type GraphCapabilityCeiling,
} from "@orkestrator/protocol/graphs/capability-profiles";
import {
  compile,
  graphTemplateDigest,
  type CompiledGraphPlan,
  type GraphCompileResult,
} from "@orkestrator/protocol/graphs/compile";
import {
  GRAPH_ID_PATTERN,
  GRAPH_TEMPLATE_BOUNDS,
  graphUtf8Bytes,
} from "@orkestrator/protocol/graphs/grammar";
import {
  graphBuiltinEngineStatus,
  graphBuiltinTemplates,
  graphTemplateExportFileName,
  graphTemplateExportText,
  graphTemplateTrustState,
  isGraphProjectTemplatePath,
  type GraphProjectCeiling,
  type GraphTemplateCompileResponse,
  type GraphTemplateCompileSummary,
  type GraphTemplateDetail,
  type GraphTemplateExport,
  type GraphTemplateImportResult,
  type GraphTemplateRef,
  type GraphTemplateSummary,
  type GraphTemplateTrustResult,
  type GraphTemplateTrustState,
  type GraphTemplatesListResult,
} from "@orkestrator/protocol/graphs/library";
import {
  GRAPH_SUBGRAPH_MAX_RESOLUTIONS,
  graphSubgraphRefKey,
  type GraphTemplateResolution,
  type GraphTemplateResolver,
} from "@orkestrator/protocol/graphs/subgraphs";
import {
  parseGraphTemplate,
  validateGraphTemplate,
  type GraphTemplateRef as GraphSubgraphRef,
  type GraphTemplateV1,
} from "@orkestrator/protocol/graphs/template";
import { defaultCoordinatorHostCapabilities } from "./coordinator-providers.js";
import {
  GraphProjectTemplates,
  type GraphProjectTemplateScan,
  type StartGraphProjectWatch,
} from "./graph-project-templates.js";
import { GraphTemplateError } from "./graph-template-errors.js";
import { GraphTemplateSharing } from "./graph-template-sharing.js";
import type { AppConfig, Project } from "./models.js";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import type { ResourceChange } from "@orkestrator/protocol/resource-events";
import type { GraphTemplatesStorage } from "./storage.js";

/**
 * The template library (item 109, plan P1.9, D2, D18): built-in templates
 * from code, user templates from the `graph-templates` store, project
 * templates from the project's checkout, trust for project templates, and
 * the per-project capability ceiling every compile here applies.
 *
 * Compiles are pure and cached by template digest and compile context (the
 * ceiling, enabled providers and host), so listing many templates compiles
 * each one once until it or the context changes.
 */

export interface GraphTemplateServiceStorage {
  graphTemplates: GraphTemplatesStorage;
  getProject(projectId: string): Promise<Project | null>;
  loadConfig(): Promise<AppConfig>;
  /** When present, a removed project's watch stops at once. */
  addResourceChangeListener?(listener: (change: ResourceChange) => void): () => void;
}

export interface GraphTemplateServiceOptions {
  storage: GraphTemplateServiceStorage;
  /** Built-in templates; default the protocol registry (item 108 fills it). */
  builtins?: () => readonly GraphTemplateV1[];
  /**
   * What this host offers provider sandboxes; probed on first use and again
   * for every launch compile.
   */
  host?: () => AgentEnforcementHost;
  /** Project-template watching (tests inject; `null` disables it). */
  startWatch?: StartGraphProjectWatch | null;
  watchSettleMs?: number;
  now?: () => Date;
}

interface ResolvedTemplate {
  ref: GraphTemplateRef;
  template: GraphTemplateV1;
  digest: string;
  revision: number;
  readOnly: boolean;
  trust: GraphTemplateTrustState;
  approvedAt?: string;
  updatedAt?: string;
}

interface CompileContext {
  ceiling: GraphCapabilityCeiling;
  providers?: AgentPlatform[];
  host: AgentEnforcementHost;
  /** The launch environment's resolved policy (item 214); design time uses the compiler's default. */
  environment?: NativeAgentExecutionPolicy;
  key: string;
  /** The project whose templates a sub-graph may name (item 402). */
  projectId?: string;
}

/** A template's sub-graph children, read ahead for one synchronous compile (item 402). */
interface SubgraphResolution {
  resolve: GraphTemplateResolver;
  /** What resolved, for the compile cache: a child edit must recompile its parents. */
  key: string;
}

const COMPILE_CACHE_ENTRIES = 256;
const MAX_ERROR_SUMMARY = 3;

export class GraphTemplateService {
  readonly projectTemplates: GraphProjectTemplates;
  /** Share bundles, signing keys and the project template review (item 405). */
  readonly sharing: GraphTemplateSharing;
  private readonly storage: GraphTemplateServiceStorage;
  private readonly builtinSource: () => readonly GraphTemplateV1[];
  private readonly hostSource: () => AgentEnforcementHost;
  private readonly now: () => Date;
  private builtins: GraphTemplateV1[] | null = null;
  private host: AgentEnforcementHost | null = null;
  private readonly compiled = new Map<string, GraphCompileResult>();
  private readonly stopListening: () => void;

  constructor(options: GraphTemplateServiceOptions) {
    this.storage = options.storage;
    this.builtinSource = options.builtins ?? graphBuiltinTemplates;
    this.hostSource = options.host ?? (() => defaultCoordinatorHostCapabilities());
    this.now = options.now ?? (() => new Date());
    this.projectTemplates = new GraphProjectTemplates({
      checkoutOf: async (projectId) => (await this.requireProject(projectId)).localPath,
      onChange: (projectId) =>
        this.storage.graphTemplates.announceGraphProjectTemplatesChanged(projectId),
      ...(options.startWatch !== undefined ? { startWatch: options.startWatch } : {}),
      ...(options.watchSettleMs !== undefined ? { settleMs: options.watchSettleMs } : {}),
    });
    this.sharing = new GraphTemplateSharing({
      service: this,
      storage: this.storage.graphTemplates,
      now: this.now,
    });
    this.stopListening =
      this.storage.addResourceChangeListener?.((change) => {
        if (change.resource === "project" && change.deleted) {
          this.projectTemplates.forget(change.id);
        }
      }) ?? (() => undefined);
  }

  shutdown(): void {
    this.stopListening();
    this.projectTemplates.close();
  }

  // ------------------------------------------------------------ queries

  async list(input: { projectId?: string } = {}): Promise<GraphTemplatesListResult> {
    const context = await this.compileContext(input.projectId);
    const resolved: ResolvedTemplate[] = this.builtinTemplates().map((template) =>
      this.resolvedBuiltin(template),
    );
    const users = (await this.storage.graphTemplates.listGraphTemplateRecords())
      .map((record) => this.resolvedUser(record))
      .sort(
        (a, b) =>
          a.template.name.localeCompare(b.template.name) ||
          (a.template.id < b.template.id ? -1 : 1),
      );
    resolved.push(...users);
    let project: GraphTemplatesListResult["project"] = null;
    if (input.projectId) {
      const scan = await this.projectTemplates.scan(input.projectId);
      project = scan.source;
      resolved.push(...this.resolvedProjectFiles(input.projectId, scan));
    }
    return {
      templates: await Promise.all(resolved.map((entry) => this.summary(entry, context))),
      project,
      ceiling: context.ceiling,
    };
  }

  async get(
    ref: GraphTemplateRef,
    input: { projectId?: string } = {},
  ): Promise<GraphTemplateDetail> {
    const resolved = await this.resolve(ref);
    const context = await this.compileContext(projectIdFor(ref, input.projectId));
    return {
      summary: await this.summary(resolved, context),
      template: structuredClone(resolved.template),
    };
  }

  async export(ref: GraphTemplateRef): Promise<GraphTemplateExport> {
    const resolved = await this.resolve(ref);
    return {
      fileName: graphTemplateExportFileName(resolved.template),
      text: graphTemplateExportText(resolved.template),
      digest: resolved.digest,
    };
  }

  /**
   * Compiles a stored template (`ref`) or an unsaved draft (`template`) under
   * the project's ceiling. `forLaunch` refuses a template that is not trusted
   * (an untrusted project template is listed but never compiled for a launch)
   * and a built-in, which runs on its own engine (D5).
   */
  async compile(
    target: { ref: GraphTemplateRef } | { template: unknown },
    input: {
      projectId?: string;
      includePlan?: boolean;
      forLaunch?: boolean;
      /** The launch environment's resolved execution policy (item 214). */
      environment?: NativeAgentExecutionPolicy;
    } = {},
  ): Promise<GraphTemplateCompileResponse> {
    if ("template" in target) {
      if (input.forLaunch) {
        throw new GraphTemplateError("invalid-request", "Save a template before launching it");
      }
      const context = await this.compileContext(input.projectId);
      const subgraphs = await this.subgraphResolution(target.template, context);
      const result = compile(target.template, compileOptions(context, subgraphs));
      return compileResponse(null, result, context, "trusted", input.includePlan);
    }
    const resolved = await this.resolve(target.ref);
    if (input.forLaunch && resolved.trust !== "trusted") {
      throw new GraphTemplateError(
        "untrusted",
        resolved.trust === "changed"
          ? "This project template changed since it was approved; approve the new version before launching it"
          : "This project template is not trusted; approve it before launching it",
      );
    }
    if (input.forLaunch && resolved.template.engine !== undefined) {
      throw new GraphTemplateError(
        "engine-template",
        "A built-in template runs on its own engine; duplicate it to run a copy as a graph",
      );
    }
    // A launch judges providers on the host as it is now (item 209): the
    // sandbox may have stopped working since the last probe.
    if (input.forLaunch) this.host = this.hostSource();
    const context = await this.compileContext(
      projectIdFor(target.ref, input.projectId),
      input.environment,
    );
    const result = await this.compileResolved(resolved, context);
    const response = compileResponse(
      await this.summary(resolved, context),
      result,
      context,
      resolved.trust,
      input.includePlan,
    );
    if (!input.forLaunch || !result.plan) return response;
    return {
      ...response,
      providerChoices: graphRoleProviderChoices(
        result.plan,
        context.host,
        context.providers ?? AGENT_PLATFORMS,
      ),
    };
  }

  /**
   * For launch surfaces (item 214): refuses an untrusted template and an
   * engine template, compiles under the launch environment's own policy
   * (`environment`) and the project's ceiling, and returns the plan (null
   * when the template has errors; check `launchable`).
   */
  async compileForLaunch(
    ref: GraphTemplateRef,
    projectId?: string,
    environment?: NativeAgentExecutionPolicy,
  ): Promise<GraphTemplateCompileResponse & { plan: CompiledGraphPlan | null }> {
    const response = await this.compile(
      { ref },
      {
        projectId,
        includePlan: true,
        forLaunch: true,
        ...(environment ? { environment } : {}),
      },
    );
    return { ...response, plan: response.plan ?? null };
  }

  // ------------------------------------------------------------ user templates

  async save(
    template: unknown,
    input: { expectedRevision?: number; projectId?: string } = {},
  ): Promise<GraphTemplateDetail> {
    const valid = this.validUserTemplate(template, "save");
    const expected = input.expectedRevision ?? valid.revision;
    const record = await this.storage.graphTemplates.saveGraphTemplateRecord(valid, expected);
    return this.get({ scope: "user", id: record.id }, input);
  }

  async delete(id: string, expectedRevision?: number): Promise<{ deleted: boolean }> {
    return { deleted: this.storage.graphTemplates.deleteGraphTemplateRecord(id, expectedRevision) };
  }

  /**
   * Copies any template into a new user template (revision 1) with a new id
   * and name. A built-in's `engine` is dropped: the copy runs on the graph
   * runtime (D5). A project template is copied only at the digest the caller
   * saw, so a file changed in between is never copied unseen.
   */
  async duplicate(
    ref: GraphTemplateRef,
    input: { id?: string; name?: string; digest?: string; projectId?: string } = {},
  ): Promise<GraphTemplateDetail> {
    const source = await this.resolve(ref);
    if (ref.scope === "project" && input.digest !== source.digest) {
      throw new GraphTemplateError(
        "digest-mismatch",
        input.digest === undefined
          ? "Duplicating a project template needs the digest you reviewed"
          : "The project template changed since you opened it; review it again",
      );
    }
    const taken = await this.userIds();
    let id: string;
    if (input.id !== undefined) {
      if (taken.has(input.id)) {
        throw new GraphTemplateError(
          "revision-conflict",
          `A user template ${input.id} already exists`,
        );
      }
      id = input.id;
    } else {
      id = uniqueId(`${source.template.id}-copy`, taken);
    }
    const copy: GraphTemplateV1 = {
      ...structuredClone(source.template),
      id,
      name: input.name ?? copyName(source.template.name),
      revision: 0,
    };
    delete copy.engine;
    const valid = this.validUserTemplate(copy, "duplicate");
    await this.storage.graphTemplates.saveGraphTemplateRecord(valid, 0);
    return this.get({ scope: "user", id }, { projectId: projectIdFor(ref, input.projectId) });
  }

  /**
   * JSON text to a new user template. Refused text (too large, duplicate
   * keys, failing the guard) comes back as errors. An id already in use gets
   * a fresh one; `engine` is dropped as for a duplicate.
   */
  async importText(
    text: string,
    input: { projectId?: string } = {},
  ): Promise<GraphTemplateImportResult> {
    const parsed = parseGraphTemplate(text);
    if (!parsed.ok) return parsed;
    const taken = await this.userIds();
    const original = parsed.value.id;
    const id = uniqueId(original, taken);
    const template: GraphTemplateV1 = { ...parsed.value, id, revision: 0 };
    delete template.engine;
    const valid = this.validUserTemplate(template, "import");
    await this.storage.graphTemplates.saveGraphTemplateRecord(valid, 0);
    const detail = await this.get({ scope: "user", id }, input);
    return { ok: true, detail, ...(id !== original ? { renamedFrom: original } : {}) };
  }

  /** The id an import of a template with `id` would get (item 405's preview). */
  async availableUserTemplateId(id: string): Promise<string> {
    return uniqueId(id, await this.userIds());
  }

  // ------------------------------------------------------------ trust

  async trust(input: {
    projectId: string;
    path: string;
    action: "approve" | "revoke";
    digest?: string;
  }): Promise<GraphTemplateTrustResult> {
    if (!isGraphProjectTemplatePath(input.path)) {
      throw new GraphTemplateError("invalid-request", "path must name a project template file");
    }
    const scan = await this.projectTemplates.scan(input.projectId);
    const file = scan.files.find((candidate) => candidate.path === input.path);
    if (input.action === "revoke") {
      const { settings } = this.storage.graphTemplates.revokeGraphProjectTemplate(
        input.projectId,
        input.path,
      );
      return {
        projectId: input.projectId,
        path: input.path,
        trust: "untrusted",
        digest: file?.digest ?? null,
        records: settings.trust,
      };
    }
    if (!file) {
      const problem = scan.source.problems.find((candidate) => candidate.path === input.path);
      throw new GraphTemplateError(
        problem ? "invalid-template" : "not-found",
        problem
          ? "Only a valid project template can be trusted"
          : `No project template at ${input.path}`,
      );
    }
    if (input.digest !== file.digest) {
      throw new GraphTemplateError(
        "digest-mismatch",
        "The project template changed since you reviewed it; review it again before approving",
      );
    }
    const approvedAt = this.now().toISOString();
    const settings = this.storage.graphTemplates.approveGraphProjectTemplate(
      input.projectId,
      { path: file.path, digest: file.digest, approvedAt },
      new Set(scan.files.map((candidate) => candidate.path)),
      // The approved copy, for item 405's review diff when the file changes.
      graphTemplateExportText(file.template),
    );
    return {
      projectId: input.projectId,
      path: file.path,
      trust: "trusted",
      digest: file.digest,
      approvedAt,
      records: settings.trust,
    };
  }

  // ------------------------------------------------------------ ceiling

  async getCeiling(projectId: string): Promise<GraphProjectCeiling> {
    await this.requireProject(projectId);
    return this.ceilingView(projectId);
  }

  /**
   * Sets a project's ceiling (D18), or with `null` returns it to the default.
   * `git.push` and `github.write` are refused: they are outside the ceiling,
   * because no agent node ever holds them (D12).
   */
  async setCeiling(
    projectId: string,
    ceiling: unknown,
    expectedRevision?: number,
  ): Promise<GraphProjectCeiling> {
    await this.requireProject(projectId);
    let normalized: GraphCapabilityCeiling | null = null;
    if (ceiling !== null) {
      const issues = graphCapabilityCeilingIssues(ceiling);
      if (issues.length > 0) {
        throw new GraphTemplateError(
          "invalid-ceiling",
          issues
            .slice(0, MAX_ERROR_SUMMARY)
            .map((issue) => `${issue.path}: ${issue.message}`)
            .join("; "),
        );
      }
      const valid = ceiling as GraphCapabilityCeiling;
      normalized = {
        deny: [...new Set(valid.deny)].sort(),
        ...(valid.allow && valid.allow.length > 0 ? { allow: [...valid.allow] } : {}),
      };
    }
    this.storage.graphTemplates.setGraphProjectCeiling(projectId, normalized, expectedRevision);
    return this.ceilingView(projectId);
  }

  // ------------------------------------------------------------ internals

  private ceilingView(projectId: string): GraphProjectCeiling {
    const settings = this.storage.graphTemplates.getGraphProjectSettings(projectId);
    const ceiling = settings?.ceiling;
    return {
      projectId,
      ceiling: ceiling ? structuredClone(ceiling) : { deny: [] },
      isDefault: !ceiling,
      revision: settings?.ceilingRevision ?? 0,
      ...(settings?.ceilingUpdatedAt ? { updatedAt: settings.ceilingUpdatedAt } : {}),
    };
  }

  private async requireProject(projectId: string): Promise<Project> {
    const project = await this.storage.getProject(projectId);
    if (!project) throw new GraphTemplateError("not-found", `Project not found: ${projectId}`);
    return project;
  }

  private builtinTemplates(): GraphTemplateV1[] {
    if (this.builtins) return this.builtins;
    const seen = new Set<string>();
    const accepted: GraphTemplateV1[] = [];
    for (const candidate of this.builtinSource()) {
      const guard = validateGraphTemplate(candidate);
      if (!guard.ok || seen.has(guard.value.id)) {
        console.warn(
          `[graphs] Built-in template skipped (${guard.ok ? "duplicate id" : "invalid"}):`,
          guard.ok ? guard.value.id : String((candidate as { id?: unknown })?.id).slice(0, 64),
        );
        continue;
      }
      seen.add(guard.value.id);
      accepted.push(Object.freeze(structuredClone(guard.value)) as GraphTemplateV1);
    }
    this.builtins = accepted;
    return accepted;
  }

  private resolvedBuiltin(template: GraphTemplateV1): ResolvedTemplate {
    return {
      ref: { scope: "builtin", id: template.id },
      template,
      digest: graphTemplateDigest(template),
      revision: template.revision,
      readOnly: true,
      trust: "trusted",
    };
  }

  private resolvedUser(record: {
    id: string;
    revision: number;
    template: GraphTemplateV1;
    updatedAt: string;
  }): ResolvedTemplate {
    return {
      ref: { scope: "user", id: record.id },
      template: record.template,
      digest: graphTemplateDigest(record.template),
      revision: record.revision,
      readOnly: false,
      trust: "trusted",
      updatedAt: record.updatedAt,
    };
  }

  private resolvedProjectFiles(
    projectId: string,
    scan: GraphProjectTemplateScan,
  ): ResolvedTemplate[] {
    const settings = this.storage.graphTemplates.getGraphProjectSettings(projectId);
    const records = new Map((settings?.trust ?? []).map((record) => [record.path, record]));
    return scan.files.map((file) => {
      const record = records.get(file.path);
      const trust = graphTemplateTrustState(record, file.digest);
      return {
        ref: { scope: "project", projectId, path: file.path },
        template: file.template,
        digest: file.digest,
        revision: file.template.revision,
        readOnly: true,
        trust,
        ...(trust === "trusted" && record ? { approvedAt: record.approvedAt } : {}),
      };
    });
  }

  private async resolve(ref: GraphTemplateRef): Promise<ResolvedTemplate> {
    switch (ref.scope) {
      case "builtin": {
        const template = this.builtinTemplates().find((candidate) => candidate.id === ref.id);
        if (!template) throw new GraphTemplateError("not-found", `No built-in template ${ref.id}`);
        return this.resolvedBuiltin(template);
      }
      case "user": {
        const record = this.storage.graphTemplates.getGraphTemplateRecord(ref.id);
        if (!record) throw new GraphTemplateError("not-found", `No user template ${ref.id}`);
        return this.resolvedUser(record);
      }
      case "project": {
        const scan = await this.projectTemplates.scan(ref.projectId);
        const match = this.resolvedProjectFiles(ref.projectId, scan).find(
          (candidate) => candidate.ref.scope === "project" && candidate.ref.path === ref.path,
        );
        if (!match) {
          const problem = scan.source.problems.find((candidate) => candidate.path === ref.path);
          throw new GraphTemplateError(
            problem ? "invalid-template" : "not-found",
            problem ? `${ref.path}: ${problem.message}` : `No project template at ${ref.path}`,
          );
        }
        return match;
      }
    }
  }

  private validUserTemplate(template: unknown, action: string): GraphTemplateV1 {
    const guard = validateGraphTemplate(template);
    if (!guard.ok) {
      const shown = guard.errors
        .slice(0, MAX_ERROR_SUMMARY)
        .map((error) => `${error.path}: ${error.message}`)
        .join("; ");
      const more = guard.errors.length + guard.omittedErrors - MAX_ERROR_SUMMARY;
      throw new GraphTemplateError(
        "invalid-template",
        `Cannot ${action} an invalid template: ${shown}${more > 0 ? ` (and ${more} more)` : ""}`,
      );
    }
    if (guard.value.engine !== undefined) {
      throw new GraphTemplateError(
        "invalid-template",
        "engine is reserved for built-in templates; a user template runs on the graph runtime",
      );
    }
    return guard.value;
  }

  private async userIds(): Promise<Set<string>> {
    return new Set(
      (await this.storage.graphTemplates.listGraphTemplateRecords()).map((record) => record.id),
    );
  }

  private async compileContext(
    projectId: string | undefined,
    environment?: NativeAgentExecutionPolicy,
  ): Promise<CompileContext> {
    let ceiling: GraphCapabilityCeiling = DEFAULT_GRAPH_CAPABILITY_CEILING;
    if (projectId) {
      await this.requireProject(projectId);
      ceiling = this.storage.graphTemplates.getGraphProjectSettings(projectId)?.ceiling ?? ceiling;
    }
    const providers = await this.enabledProviders();
    this.host ??= this.hostSource();
    const host = this.host;
    return {
      ceiling,
      ...(providers ? { providers } : {}),
      host,
      ...(environment ? { environment } : {}),
      key: JSON.stringify([
        ceiling,
        providers ?? null,
        host.claudeSandbox,
        projectId ?? null,
        environment ?? null,
      ]),
      ...(projectId ? { projectId } : {}),
    };
  }

  /**
   * Reads ahead every template the sub-graphs of `template` name, nested ones
   * included (item 402), so the compile can resolve them synchronously:
   * built-ins from code, user templates from the store, and the compile
   * project's templates only while they are trusted at their current digest
   * (an untrusted child resolves as `untrusted`, never as content).
   */
  private async subgraphResolution(
    template: unknown,
    context: CompileContext,
  ): Promise<SubgraphResolution> {
    const resolved = new Map<string, GraphTemplateResolution | undefined>();
    const pending = subgraphRefs(template);
    let projectFiles: ResolvedTemplate[] | null = null;
    const projectTemplates = async (projectId: string) => {
      projectFiles ??= this.resolvedProjectFiles(
        projectId,
        await this.projectTemplates.scan(projectId),
      );
      return projectFiles;
    };
    while (pending.length > 0 && resolved.size < GRAPH_SUBGRAPH_MAX_RESOLUTIONS) {
      const ref = pending.shift()!;
      const key = graphSubgraphRefKey(ref);
      if (resolved.has(key)) continue;
      const resolution = await this.resolveSubgraph(ref, context, projectTemplates);
      resolved.set(key, resolution);
      if (resolution && "template" in resolution)
        pending.push(...subgraphRefs(resolution.template));
    }
    const key = [...resolved]
      .map(([ref, resolution]) => {
        if (!resolution) return `${ref}=?`;
        if ("missing" in resolution) return `${ref}=!${resolution.missing}`;
        return `${ref}=${graphTemplateDigest(resolution.template)}@${resolution.revision ?? ""}`;
      })
      .sort()
      .join(",");
    return {
      resolve: (ref) => {
        const resolution = resolved.get(graphSubgraphRefKey(ref));
        return resolution && "template" in resolution
          ? { ...resolution, template: structuredClone(resolution.template) }
          : resolution;
      },
      key,
    };
  }

  private async resolveSubgraph(
    ref: GraphSubgraphRef,
    context: CompileContext,
    projectTemplates: (projectId: string) => Promise<ResolvedTemplate[]>,
  ): Promise<GraphTemplateResolution | undefined> {
    switch (ref.scope) {
      case "builtin": {
        const template = this.builtinTemplates().find((candidate) => candidate.id === ref.id);
        return template ? { template } : undefined;
      }
      case "user": {
        const record = this.storage.graphTemplates.getGraphTemplateRecord(ref.id);
        return record ? { template: record.template, revision: record.revision } : undefined;
      }
      case "project": {
        if (!context.projectId) return { missing: "no-project" };
        let files: ResolvedTemplate[];
        try {
          files = await projectTemplates(context.projectId);
        } catch {
          return undefined;
        }
        const matches = files.filter((file) =>
          ref.path !== undefined
            ? file.ref.scope === "project" && file.ref.path === ref.path
            : file.template.id === ref.id,
        );
        if (matches.length === 0) return undefined;
        if (matches.length > 1) return { missing: "ambiguous" };
        const match = matches[0]!;
        if (match.trust !== "trusted") return { missing: "untrusted" };
        return {
          template: match.template,
          revision: match.revision,
          ...(match.ref.scope === "project" ? { path: match.ref.path } : {}),
        };
      }
    }
  }

  private async enabledProviders(): Promise<AgentPlatform[] | undefined> {
    try {
      const enabled = (await this.storage.loadConfig()).global.enabledAgentPlatforms;
      const platforms = (enabled ?? []).filter(isAgentPlatform);
      return platforms.length > 0 ? [...new Set(platforms)].sort() : undefined;
    } catch {
      return undefined;
    }
  }

  private async compileResolved(
    resolved: ResolvedTemplate,
    context: CompileContext,
  ): Promise<GraphCompileResult> {
    const subgraphs = await this.subgraphResolution(resolved.template, context);
    const key = `${resolved.digest}|${context.key}|${subgraphs.key}`;
    const cached = this.compiled.get(key);
    if (cached) {
      this.compiled.delete(key);
      this.compiled.set(key, cached);
      return cached;
    }
    const result = compile(resolved.template, compileOptions(context, subgraphs));
    this.compiled.set(key, result);
    while (this.compiled.size > COMPILE_CACHE_ENTRIES) {
      const oldest = this.compiled.keys().next().value;
      if (oldest === undefined) break;
      this.compiled.delete(oldest);
    }
    return result;
  }

  private async summary(
    resolved: ResolvedTemplate,
    context: CompileContext,
  ): Promise<GraphTemplateSummary> {
    const result = await this.compileResolved(resolved, context);
    const compileSummary = summarizeCompile(result);
    const template = resolved.template;
    return {
      ref: resolved.ref,
      scope: resolved.ref.scope,
      id: template.id,
      name: template.name,
      ...(template.description !== undefined ? { description: template.description } : {}),
      ...(template.engine !== undefined ? { engine: template.engine } : {}),
      ...(resolved.ref.scope === "builtin" && graphBuiltinEngineStatus(template.id)
        ? { engineStatus: graphBuiltinEngineStatus(template.id) }
        : {}),
      revision: resolved.revision,
      digest: resolved.digest,
      readOnly: resolved.readOnly,
      trust: resolved.trust,
      ...(resolved.approvedAt ? { approvedAt: resolved.approvedAt } : {}),
      launchable:
        resolved.trust === "trusted" && template.engine === undefined && compileSummary.launchable,
      compile: compileSummary,
      ...(resolved.updatedAt ? { updatedAt: resolved.updatedAt } : {}),
    };
  }
}

function projectIdFor(ref: GraphTemplateRef, projectId: string | undefined): string | undefined {
  return ref.scope === "project" ? ref.projectId : projectId;
}

function compileOptions(context: CompileContext, subgraphs: SubgraphResolution) {
  return {
    ceiling: context.ceiling,
    host: context.host,
    ...(context.providers ? { providers: context.providers } : {}),
    resolveTemplate: subgraphs.resolve,
    ...(context.environment ? { environment: context.environment } : {}),
  };
}

/** The sub-graph references of a template (any JSON value; the compiler guards it). */
function subgraphRefs(template: unknown): GraphSubgraphRef[] {
  const nodes = (template as { nodes?: unknown } | null)?.nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes.flatMap((node) => {
    const candidate = node as { kind?: unknown; template?: unknown } | null;
    const ref = candidate?.template as Partial<GraphSubgraphRef> | undefined;
    return candidate?.kind === "subgraph" &&
      ref &&
      typeof ref.scope === "string" &&
      typeof ref.id === "string"
      ? [ref as GraphSubgraphRef]
      : [];
  });
}

function summarizeCompile(result: GraphCompileResult): GraphTemplateCompileSummary {
  let errors = 0;
  let warnings = 0;
  let infos = 0;
  for (const diagnostic of result.diagnostics) {
    if (diagnostic.severity === "error") errors += 1;
    else if (diagnostic.severity === "warning") warnings += 1;
    else infos += 1;
  }
  return {
    ok: result.ok,
    launchable: result.launchable,
    errors,
    warnings,
    infos,
    pendingAcknowledgements: result.pendingAcknowledgements.length,
    planDigest: result.plan?.digest ?? null,
    cost: result.cost
      ? {
          agentSessions: { ...result.cost.agentSessions },
          peakParallelism: result.cost.peakParallelism,
        }
      : null,
  };
}

function compileResponse(
  summary: GraphTemplateSummary | null,
  result: GraphCompileResult,
  context: CompileContext,
  trust: GraphTemplateTrustState,
  includePlan: boolean | undefined,
): GraphTemplateCompileResponse {
  return {
    summary,
    ok: result.ok,
    launchable: result.launchable && trust === "trusted",
    ...(trust !== "trusted" ? { blockedBy: trust } : {}),
    diagnostics: result.diagnostics,
    omittedDiagnostics: result.omittedDiagnostics,
    cost: result.cost,
    pendingAcknowledgements: result.pendingAcknowledgements,
    planDigest: result.plan?.digest ?? null,
    // Results are cached and shared: the caller gets its own copy of the plan.
    ...(includePlan ? { plan: result.plan ? structuredClone(result.plan) : null } : {}),
    ceiling: context.ceiling,
  };
}

/** `base`, or `base-2`, `base-3`, … : the first id no user template has. */
function uniqueId(base: string, taken: ReadonlySet<string>): string {
  const max = GRAPH_TEMPLATE_BOUNDS.maxIdChars;
  const root = GRAPH_ID_PATTERN.test(base) && base.length <= max ? base : "template";
  if (!taken.has(root)) return root;
  for (let index = 2; index < 10_000; index += 1) {
    const suffix = `-${index}`;
    const stem = root.slice(0, max - suffix.length).replace(/-+$/, "");
    const candidate = `${stem}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new GraphTemplateError("limit", "No free template id");
}

/** `<name> (copy)`, shortened to the label bound on a character boundary. */
function copyName(name: string): string {
  const suffix = " (copy)";
  let stem = name;
  while (
    stem.length > 0 &&
    graphUtf8Bytes(`${stem}${suffix}`) > GRAPH_TEMPLATE_BOUNDS.maxNameBytes
  ) {
    stem = Array.from(stem).slice(0, -1).join("");
  }
  return `${stem.trimEnd()}${suffix}`;
}
