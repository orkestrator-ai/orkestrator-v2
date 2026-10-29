/**
 * A world for system-node tests (item 207): a real store with a project, a
 * local environment in a real Git worktree and a stored run of a template
 * holding every system action, plus fakes for everything outside the
 * backend — the remote and GitHub (`FakeGraphShell`), backend commands
 * (`FakeGraphInvoke`), the PR monitor and agent mail. Each fake counts the
 * side effects it performed, so tests can prove one never happens twice.
 * Test-only.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { compile, type CompiledGraphPlan } from "@orkestrator/protocol/graphs/compile";
import { graphPullRequestStateType } from "@orkestrator/protocol/graphs/system-actions";
import {
  GRAPH_RUN_INPUT_PRODUCER,
  graphActivationKey,
  type GraphRewind,
  type GraphRun,
  type NodeActivation,
} from "@orkestrator/protocol/graphs/run";
import type { GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";
import { graphBuiltInType } from "@orkestrator/protocol/graphs/types";
import type { AgentMailMessage, AgentMailSendInput } from "@orkestrator/protocol/agent-mail";
import type { PrMonitorEnvironmentState } from "@orkestrator/protocol/pr-monitor";
import { reviewPackageArtifactPath } from "@orkestrator/protocol/review-artifacts";
import type { ReviewValidationRun } from "@orkestrator/protocol/review-workflow";
import { GraphArtifactStore } from "./graph-artifacts.js";
import { GraphNodeSystemExecutor } from "./graph-node-system.js";
import type { GraphExecutorContext } from "./graph-run-executors.js";
import { graphEnvironmentFixture, graphRunFixture } from "./graph-run-test-support.js";
import type { GraphSystemDependencies, GraphSystemStorage } from "./graph-system-action.js";
import type { GraphEnvironmentShell, GraphShellOptions } from "./graph-system-environment.js";
import type { Environment } from "./models.js";
import { runCommand } from "./shell.js";
import type { AgentMailSender } from "./storage-agent-mail-store.js";
import { StorageService } from "./storage.js";

export const SYSTEM_BRANCH = "feature/csv";
export const SYSTEM_REPO = "acme/widgets";

const port = (node: string, name: string) => ({ node, port: name });

/** Every system action but `prepare-environment` (which writes; see {@link prepareTemplate}). */
export function systemTemplate(): GraphTemplateV1 {
  const input = (id: string, name: string, node: string, to: string) => ({
    id,
    from: { input: name },
    to: port(node, to),
  });
  return {
    format: "orkestrator.graph",
    formatVersion: 1,
    id: "system-actions",
    revision: 1,
    name: "System actions",
    parameters: [],
    roles: [],
    types: [graphPullRequestStateType()],
    inputs: [
      { name: "code", type: "workspace@1" },
      { name: "description", type: "pr-description@1" },
      { name: "plan", type: "validation-plan@1" },
      { name: "verdict", type: "verification-verdict@1" },
      { name: "pr", type: "pr-result@1" },
      { name: "ticket", type: "ticket@1" },
      { name: "note", type: "text@1" },
    ],
    workspace: { kind: "environment" },
    nodes: [
      {
        id: "validate",
        kind: "system",
        action: "run-validation",
        inputs: [
          { name: "plan", type: "validation-plan@1" },
          { name: "code", type: "workspace@1" },
        ],
        outputs: [
          { name: "results", type: "validation-results@1" },
          { name: "code", type: "workspace@1" },
        ],
      },
      {
        id: "seal",
        kind: "system",
        action: "run-validation-and-seal",
        inputs: [
          { name: "plan", type: "validation-plan@1" },
          { name: "code", type: "workspace@1" },
        ],
        outputs: [{ name: "package", type: "review-package@2" }],
      },
      {
        id: "push",
        kind: "system",
        action: "push-branch",
        inputs: [{ name: "code", type: "workspace@1" }],
        outputs: [{ name: "code", type: "workspace@1" }],
      },
      {
        id: "pr",
        kind: "system",
        action: "open-pull-request",
        inputs: [
          { name: "code", type: "workspace@1" },
          { name: "description", type: "pr-description@1" },
        ],
        outputs: [
          { name: "pr", type: "pr-result@1" },
          { name: "state", type: "pull-request-state@1" },
        ],
      },
      {
        id: "checks",
        kind: "system",
        action: "wait-for-checks",
        params: { timeoutMinutes: 30 },
        inputs: [
          { name: "pr", type: "pr-result@1" },
          { name: "code", type: "workspace@1" },
        ],
        outputs: [{ name: "summary", type: "check-summary@1" }],
      },
      {
        id: "move",
        kind: "system",
        action: "update-ticket",
        params: { status: "in-progress", comment: "Graph run started" },
      },
      {
        id: "criteria",
        kind: "system",
        action: "update-ticket",
        params: { record: "criteria" },
        inputs: [
          { name: "verdict", type: "verification-verdict@1" },
          { name: "ticket", type: "ticket@1" },
        ],
      },
      {
        id: "raised",
        kind: "system",
        action: "update-ticket",
        params: { lifecycle: "pr-raised" },
        inputs: [{ name: "pr", type: "pr-result@1" }],
      },
      {
        id: "started",
        kind: "system",
        action: "update-ticket",
        params: { lifecycle: "build-started" },
      },
      {
        id: "validated",
        kind: "system",
        action: "update-ticket",
        params: { lifecycle: "validation-complete" },
      },
      {
        id: "completed",
        kind: "system",
        action: "update-ticket",
        params: { lifecycle: "complete" },
      },
      { id: "failed", kind: "system", action: "update-ticket", params: { lifecycle: "failed" } },
      {
        id: "notify",
        kind: "system",
        action: "notify",
        params: { to: "coordinator", subject: "Graph run", message: "The run reached notify." },
        inputs: [{ name: "note", type: "text@1" }],
      },
    ],
    edges: [
      input("plan-validate", "plan", "validate", "plan"),
      input("code-validate", "code", "validate", "code"),
      input("plan-seal", "plan", "seal", "plan"),
      input("code-seal", "code", "seal", "code"),
      input("code-push", "code", "push", "code"),
      input("code-pr", "code", "pr", "code"),
      input("description-pr", "description", "pr", "description"),
      input("pr-checks", "pr", "checks", "pr"),
      input("code-checks", "code", "checks", "code"),
      input("verdict-criteria", "verdict", "criteria", "verdict"),
      input("ticket-criteria", "ticket", "criteria", "ticket"),
      input("pr-raised", "pr", "raised", "pr"),
      input("note-notify", "note", "notify", "note"),
    ],
    limits: { maxAgentSessions: 1, maxConcurrentAgents: 1 },
  };
}

/** `prepare-environment` alone, on a run that creates a worktree. */
export function prepareTemplate(): GraphTemplateV1 {
  return {
    format: "orkestrator.graph",
    formatVersion: 1,
    id: "prepare",
    revision: 1,
    name: "Prepare",
    parameters: [],
    roles: [],
    inputs: [{ name: "ticket", type: "ticket@1" }],
    workspace: { kind: "environment", create: { kind: "worktree" } },
    nodes: [
      {
        id: "setup",
        kind: "system",
        action: "prepare-environment",
        inputs: [{ name: "ticket", type: "ticket@1" }],
        outputs: [{ name: "code", type: "workspace@1" }],
      },
    ],
    edges: [{ id: "ticket-setup", from: { input: "ticket" }, to: port("setup", "ticket") }],
    limits: { maxAgentSessions: 1, maxConcurrentAgents: 1 },
  };
}

export function compiled(template: GraphTemplateV1): CompiledGraphPlan {
  const result = compile(template);
  if (!result.plan) {
    throw new Error(
      result.diagnostics
        .filter((diagnostic) => diagnostic.severity === "error")
        .map((diagnostic) => `${diagnostic.code} ${diagnostic.path ?? ""} ${diagnostic.message}`)
        .join("; "),
    );
  }
  return result.plan;
}

// ------------------------------------------------------------------ fakes

interface FakePullRequest {
  url: string;
  number: number;
  state: "OPEN" | "CLOSED" | "MERGED";
  title: string;
  body: string;
  base: string;
  head: string;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
}

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

/** The remote, the worktree's refs and GitHub, as `git` and `gh` see them. */
export class FakeGraphShell implements GraphEnvironmentShell {
  head: string;
  readonly commits = new Set<string>();
  readonly remote = new Map<string, string>();
  readonly tracking = new Map<string, string>();
  readonly pulls: FakePullRequest[] = [];
  /** Every push, with its arguments. */
  readonly pushes: string[][] = [];
  readonly creates: string[][] = [];
  readonly edits: string[][] = [];
  readonly reopens: string[] = [];
  readonly rollupReads: string[] = [];
  readonly calls: string[][] = [];
  /** The remote branch moved: a plain push is refused as non-fast-forward. */
  diverged = false;
  /** The next `gh pr create` fails (once). */
  failNextCreate = false;
  /** Mergeability reads that answer UNKNOWN before the stored value. */
  unknownMergeabilityReads = 0;
  rollup: unknown[] = [];
  readonly files = new Map<string, Buffer>();

  constructor(head: string) {
    this.head = head;
    this.commits.add(head);
  }

  async git(_environment: Environment, args: string[]): Promise<string> {
    this.calls.push(["git", ...args]);
    if (args[0] === "rev-parse" && args.at(-1) === "HEAD^{commit}") return `${this.head}\n`;
    if (args[0] === "rev-parse" && args.at(-1)?.startsWith("refs/remotes/origin/")) {
      const value = this.tracking.get(args.at(-1)!.slice("refs/remotes/origin/".length));
      if (!value) throw new Error("fatal: Needed a single revision");
      return `${value}\n`;
    }
    if (args[0] === "cat-file") {
      const sha = args[2]!.replace("^{commit}", "");
      if (!this.commits.has(sha)) throw new Error("fatal: Not a valid object name");
      return "";
    }
    if (args[0] === "branch") return "";
    throw new Error(`unexpected git ${args.join(" ")}`);
  }

  async remoteGit(
    _environment: Environment,
    command: "push" | "ls-remote" | "fetch",
    args: string[],
    _options?: GraphShellOptions,
  ): Promise<string> {
    this.calls.push(["git", command, ...args]);
    if (command === "ls-remote") {
      const branch = args[1]!.slice("refs/heads/".length);
      const sha = this.remote.get(branch);
      return sha ? `${sha}\trefs/heads/${branch}\n` : "";
    }
    if (command === "push") {
      this.pushes.push(args);
      const refspec = args.at(-1)!;
      const [sha, ref] = refspec.split(":");
      const branch = ref!.slice("refs/heads/".length);
      const forced = args.some((arg) => arg.startsWith("--force-with-lease"));
      if (this.diverged && !forced) {
        throw new Error(
          ` ! [rejected]        ${sha} -> ${branch} (non-fast-forward)\nerror: failed to push some refs to 'https://user:secret@github.com/acme/widgets'`,
        );
      }
      this.remote.set(branch, sha!);
      this.tracking.set(branch, sha!);
      this.diverged = false;
      return "";
    }
    throw new Error(`unexpected git ${command}`);
  }

  private view(pull: FakePullRequest, fields: string): string {
    if (fields === "title,body") return JSON.stringify({ title: pull.title, body: pull.body });
    if (fields === "headRefOid,statusCheckRollup") {
      this.rollupReads.push(pull.url);
      return JSON.stringify({
        headRefOid: this.remote.get(pull.head) ?? null,
        statusCheckRollup: this.rollup,
      });
    }
    let mergeable: string = pull.mergeable;
    if (this.unknownMergeabilityReads > 0 && pull.state === "OPEN") {
      this.unknownMergeabilityReads--;
      mergeable = "UNKNOWN";
    }
    return JSON.stringify({
      url: pull.url,
      state: pull.state,
      mergeable,
      mergeStateStatus: "CLEAN",
      isDraft: false,
      baseRefName: pull.base,
    });
  }

  async gh(_environment: Environment, args: string[]): Promise<string> {
    this.calls.push(["gh", ...args]);
    const [, verb] = args;
    expectRepo(args);
    if (verb === "list") {
      const head = flag(args, "--head");
      const state = flag(args, "--state");
      return JSON.stringify(
        this.pulls
          .filter((pull) => pull.head === head && (state !== "open" || pull.state === "OPEN"))
          .map((pull) => ({
            url: pull.url,
            state: pull.state,
            mergeable: pull.mergeable,
            mergeStateStatus: "CLEAN",
            isDraft: false,
            updatedAt: `2026-10-29T00:00:0${pull.number}.000Z`,
            baseRefName: pull.base,
          })),
      );
    }
    if (verb === "create") {
      this.creates.push(args);
      if (this.failNextCreate) {
        this.failNextCreate = false;
        throw new Error("HTTP 502: Bad Gateway (https://api.github.com/graphql)");
      }
      const number = this.pulls.length + 1;
      const pull: FakePullRequest = {
        url: `https://github.com/${SYSTEM_REPO}/pull/${number}`,
        number,
        state: "OPEN",
        title: flag(args, "--title")!,
        body: flag(args, "--body")!,
        base: flag(args, "--base")!,
        head: flag(args, "--head")!,
        mergeable: "MERGEABLE",
      };
      this.pulls.push(pull);
      return `Creating pull request\n${pull.url}\n`;
    }
    const pull = this.pulls.find((candidate) => candidate.url === args[2]);
    if (!pull) throw new Error("GraphQL: Could not resolve to a PullRequest");
    if (verb === "view") return this.view(pull, flag(args, "--json")!);
    if (verb === "edit") {
      this.edits.push(args);
      pull.title = flag(args, "--title") ?? pull.title;
      pull.body = flag(args, "--body") ?? pull.body;
      return "";
    }
    if (verb === "reopen") {
      this.reopens.push(pull.url);
      pull.state = "OPEN";
      return "";
    }
    throw new Error(`unexpected gh ${args.join(" ")}`);
  }

  async readFile(_environment: Environment, relativePath: string): Promise<Buffer> {
    const file = this.files.get(relativePath);
    if (!file) throw new Error(`Review artifact was not written by preparation: ${relativePath}`);
    return file;
  }

  /** Adds a pull request GitHub already has. */
  addPull(state: FakePullRequest["state"], overrides: Partial<FakePullRequest> = {}): string {
    const number = this.pulls.length + 1;
    const url = `https://github.com/${SYSTEM_REPO}/pull/${number}`;
    this.pulls.push({
      url,
      number,
      state,
      title: "Old title",
      body: "Old body",
      base: "main",
      head: SYSTEM_BRANCH,
      mergeable: "MERGEABLE",
      ...overrides,
    });
    return url;
  }
}

function expectRepo(args: readonly string[]): void {
  if (flag(args, "--repo") !== SYSTEM_REPO) throw new Error("gh must name the repository");
}

/** Backend commands: environment lifecycle, the validation worker and package sealing. */
export class FakeGraphInvoke {
  readonly calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  /** Validation runs the worker holds, by id. */
  readonly validations = new Map<string, ReviewValidationRun>();
  /** Status reads before a started validation settles. */
  validationReadsToSettle = 1;
  /** How each validation command ends. */
  validationOutcome: Record<string, "passed" | "failed" | "incomplete"> = {};
  /** A started validation ends cancelled (the worker stopped). */
  cancelValidations = false;
  readonly packages: string[] = [];
  onCommand?: (command: string, args: Record<string, unknown>) => unknown;
  private readonly reads = new Map<string, number>();

  constructor(private readonly world: { storage: StorageService; shell: FakeGraphShell }) {}

  count(command: string): number {
    return this.calls.filter((call) => call.command === command).length;
  }

  readonly invoke = async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    this.calls.push({ command, args });
    const custom = this.onCommand?.(command, args);
    if (custom !== undefined) return (await custom) as T;
    const environmentId = args.environmentId as string;
    switch (command) {
      case "start_environment":
        await this.world.storage.updateEnvironment(environmentId, { status: "running" });
        return undefined as T;
      case "run_environment_setup":
        await this.world.storage.updateEnvironment(environmentId, {
          setupScriptsComplete: true,
          setupPhase: "ready",
        });
        return undefined as T;
      case "pr_monitor_watch":
      case "start_environment_background":
        return undefined as T;
      case "start_review_validation":
      case "status_review_validation": {
        const planned = args.run as ReviewValidationRun;
        let run = this.validations.get(planned.id);
        if (!run) {
          if (command === "status_review_validation") {
            throw new Error(
              "Validation state is missing; execution will not be automatically repeated",
            );
          }
          run = { ...planned, status: "running" };
          this.validations.set(planned.id, run);
        }
        const reads = (this.reads.get(planned.id) ?? 0) + 1;
        this.reads.set(planned.id, reads);
        if (run.status === "running" && reads > this.validationReadsToSettle) {
          run = this.settle(run);
          this.validations.set(run.id, run);
        }
        return structuredClone(run) as T;
      }
      case "cancel_review_validation": {
        const planned = args.run as ReviewValidationRun;
        const run = this.validations.get(planned.id);
        if (run && run.status === "running") {
          this.validations.set(run.id, {
            ...run,
            status: "cancelled",
            error: "Validation was cancelled",
          });
        }
        return (this.validations.get(planned.id) ?? planned) as T;
      }
      case "get_review_validation_output":
        return {
          resultId: args.resultId,
          status: "failed",
          stdout: {
            contentBase64: Buffer.from("stdout line\n").toString("base64"),
            totalBytes: 12,
            startOffset: 0,
          },
          stderr: {
            contentBase64: Buffer.from(
              `${"x".repeat(20_000)}\nexpected 3 rows, received 2\n`,
            ).toString("base64"),
            totalBytes: 20_030,
            startOffset: 0,
          },
        } as T;
      case "generate_review_package": {
        const id = args.packageId as string;
        this.packages.push(id);
        const contents = Buffer.from(JSON.stringify({ format: "review-package/2", id }));
        const sha = createHash("sha256").update(contents).digest("hex");
        const filePath = reviewPackageArtifactPath(id, sha);
        this.world.shell.files.set(filePath, contents);
        return {
          kind: "file",
          id,
          round: args.round,
          preparedAt: "2026-10-29T09:00:00.000Z",
          targetBranch: args.targetBranch,
          baseRef: "b".repeat(40),
          headRef: args.expectedHead,
          filePath,
          sha256: sha,
          bytes: contents.byteLength,
          changedFileCount: 2,
          limitations: [],
        } as T;
      }
      default:
        throw new Error(`unexpected command ${command}`);
    }
  };

  private settle(run: ReviewValidationRun): ReviewValidationRun {
    if (this.cancelValidations) {
      return { ...run, status: "cancelled", error: "Validation worker stopped" };
    }
    return {
      ...run,
      status: "completed",
      completedAt: "2026-10-29T09:01:00.000Z",
      results: run.results.map((result) => {
        const status = this.validationOutcome[result.id] ?? "passed";
        return {
          ...result,
          status,
          exitCode: status === "passed" ? 0 : status === "failed" ? 1 : null,
          stdoutPath:
            status === "incomplete" ? null : `.orkestrator/review-artifacts/${run.id}/out`,
          stderrPath:
            status === "incomplete" ? null : `.orkestrator/review-artifacts/${run.id}/err`,
          durationMs: 1_000,
          limitation:
            status === "incomplete" ? "Validation was stopped before this command completed" : null,
        };
      }),
    };
  }
}

/** The PR monitor's in-memory state and its event stream. */
export class FakePrMonitor {
  readonly states = new Map<string, PrMonitorEnvironmentState>();
  readonly listeners = new Set<(environmentId: string) => void>();
  watches = 0;

  set(environmentId: string, state: Partial<PrMonitorEnvironmentState>): void {
    this.states.set(environmentId, {
      environmentId,
      mode: "normal",
      checkInProgress: false,
      consecutiveErrors: 0,
      lastCheckAt: null,
      prUrl: null,
      prState: "open",
      hasMergeConflicts: false,
      checkSummary: null,
      ...this.states.get(environmentId),
      ...state,
    });
    for (const listener of this.listeners) listener(environmentId);
  }

  readonly port = {
    state: (environmentId: string) => this.states.get(environmentId) ?? null,
    subscribe: (listener: (environmentId: string) => void) => {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    },
    watch: async () => {
      this.watches++;
    },
  };
}

/** Agent mail with its request-id idempotency. */
export class FakeAgentMail {
  readonly sent: Array<{ sender: AgentMailSender; input: AgentMailSendInput }> = [];
  readonly delivered = new Map<string, AgentMailMessage>();

  readonly send = async (sender: AgentMailSender, input: AgentMailSendInput) => {
    this.sent.push({ sender, input });
    const prior = this.delivered.get(input.requestId);
    if (prior) return prior;
    const message = { id: `message-${this.delivered.size + 1}` } as AgentMailMessage;
    this.delivered.set(input.requestId, message);
    return message;
  };
}

// ------------------------------------------------------------------ world

export interface SystemWorld {
  root: string;
  worktree: string;
  storage: StorageService;
  artifacts: GraphArtifactStore;
  shell: FakeGraphShell;
  commands: FakeGraphInvoke;
  monitor: FakePrMonitor;
  mail: FakeAgentMail;
  observations: string[];
  run: GraphRun;
  /** Run input artifact ids, by input name. */
  inputs: Record<string, string>;
  head: string;
  now: Date;
  deps(overrides?: Partial<GraphSystemDependencies>): GraphSystemDependencies;
  executor(overrides?: Partial<GraphSystemDependencies>): GraphNodeSystemExecutor;
  activation(
    nodeId: string,
    options?: { attempt?: number; iteration?: number; state?: NodeActivation["state"] },
  ): NodeActivation;
  context(activation: NodeActivation): GraphExecutorContext;
  /** Saves new rewinds on the stored run (and the world's copy). */
  setRewinds(rewinds: GraphRewind[]): Promise<void>;
  cleanup(): Promise<void>;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await runCommand("git", args, { cwd })).stdout.trim();
}

/**
 * A run of {@link systemTemplate} (or `options.template`) on environment
 * `e1` (branch {@link SYSTEM_BRANCH}) in a real worktree with one commit.
 */
export async function systemWorld(
  options: { template?: GraphTemplateV1; environment?: Partial<Environment> } = {},
): Promise<SystemWorld> {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(tmpdir(), "orkestrator-graph-system-")),
  );
  const worktree = path.join(root, "worktree");
  await fs.mkdir(worktree);
  await git(worktree, "init", "-q", "-b", SYSTEM_BRANCH);
  await git(
    worktree,
    "-c",
    "user.email=t@example.com",
    "-c",
    "user.name=T",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "init",
  );
  const head = await git(worktree, "rev-parse", "HEAD");

  const storage = new StorageService(path.join(root, "data"));
  await storage.init();
  await storage.addProject({
    id: "p1",
    name: "Widgets",
    gitUrl: `https://github.com/${SYSTEM_REPO}.git`,
    localPath: null,
    addedAt: "2026-10-29T00:00:00.000Z",
    order: 0,
  });
  await storage.addEnvironment(
    graphEnvironmentFixture({
      branch: SYSTEM_BRANCH,
      worktreePath: worktree,
      ...options.environment,
    }),
  );
  const plan = compiled(options.template ?? systemTemplate());
  let run = await storage.graphRuns.createGraphRun(
    graphRunFixture({
      id: "run-1",
      plan,
      template: {
        id: plan.template.id,
        revision: plan.template.revision,
        digest: plan.templateDigest,
        scope: "user",
      },
      bindings: { roles: {}, params: {}, inputs: {} },
      loopIterations: {},
    }),
  );
  const fence = { beginMutation: () => () => undefined };
  const artifacts = new GraphArtifactStore({ storage, fence });

  const values: Record<string, unknown> = {
    code: { branch: SYSTEM_BRANCH, headRef: head, baseRef: null },
    target: { branch: SYSTEM_BRANCH, headRef: head, baseRef: null },
    description: { title: "Add CSV export", body: "## Summary\n\nExports reports as CSV." },
    plan: { ...(graphBuiltInType("validation-plan@1")!.example as object), headRef: head },
    verdict: graphBuiltInType("verification-verdict@1")!.example,
    pr: { status: "created", url: `https://github.com/${SYSTEM_REPO}/pull/1`, summary: "Opened." },
    ticket: graphBuiltInType("ticket@1")!.example,
    note: { text: "Extra detail." },
  };
  const inputs: Record<string, string> = {};
  for (const input of plan.inputs) {
    const artifact = await artifacts.putValue({
      runId: run.id,
      type: input.type,
      producer: {
        nodeId: GRAPH_RUN_INPUT_PRODUCER,
        activation: GRAPH_RUN_INPUT_PRODUCER,
        port: input.name,
      },
      value: values[input.name],
    });
    inputs[input.name] = artifact.id;
  }
  run = await storage.graphRuns.saveGraphRun(
    { ...run, bindings: { ...run.bindings, inputs: { ...inputs } } },
    run.revision,
  );

  const shell = new FakeGraphShell(head);
  const world = { storage, shell } as { storage: StorageService; shell: FakeGraphShell };
  const commands = new FakeGraphInvoke(world);
  const monitor = new FakePrMonitor();
  const mail = new FakeAgentMail();
  const observations: string[] = [];
  const executors: GraphNodeSystemExecutor[] = [];

  const self: SystemWorld = {
    root,
    worktree,
    storage,
    artifacts,
    shell,
    commands,
    monitor,
    mail,
    observations,
    run,
    inputs,
    head,
    now: new Date("2026-10-29T10:00:00.000Z"),
    deps(overrides = {}) {
      const systemStorage: GraphSystemStorage = {
        getEnvironment: (id) => storage.getEnvironment(id),
        getProject: (id) => storage.getProject(id),
        getRepositoryConfig: (id) => storage.getRepositoryConfig(id),
        updateEnvironment: (id, updates) => storage.updateEnvironment(id, updates),
        graphEffects: storage.graphEffects,
        kanban: storage.kanban,
        sendAgentMail: mail.send,
      };
      return {
        storage: systemStorage,
        invoke: commands.invoke,
        shell,
        prMonitor: monitor.port,
        requestObservation: (runId, key) => observations.push(`${runId} ${key}`),
        owner: "process-1",
        inlineWaitMs: 5_000,
        sleep: async () => undefined,
        ...overrides,
      };
    },
    executor(overrides = {}) {
      const executor = new GraphNodeSystemExecutor(self.deps(overrides));
      executors.push(executor);
      return executor;
    },
    activation(nodeId, activationOptions = {}) {
      const node = run.plan.nodes.find((candidate) => candidate.id === nodeId);
      if (!node) throw new Error(`no node ${nodeId}`);
      const parts = {
        nodeId,
        iteration: activationOptions.iteration ?? 1,
        attempt: activationOptions.attempt ?? 1,
      };
      return {
        key: graphActivationKey(parts),
        ...parts,
        state: activationOptions.state ?? "admitting",
        inputs: Object.fromEntries(node.inputs.map((input) => [input.name, inputs[input.name]!])),
        outputs: {},
        createdAt: self.now.toISOString(),
      };
    },
    context(activation) {
      const node = run.plan.nodes.find((candidate) => candidate.id === activation.nodeId)!;
      return {
        operation: activation.state === "admitting" ? "start" : "observe",
        run: self.run,
        node,
        activation,
        environmentId: "e1",
        artifacts,
        signal: new AbortController().signal,
        wake: () => undefined,
        now: () => self.now,
      };
    },
    async setRewinds(rewinds) {
      run = await storage.graphRuns.saveGraphRun({ ...run, rewinds }, run.revision);
      self.run = run;
    },
    async cleanup() {
      for (const executor of executors) executor.shutdown();
      storage.close();
      await runCommand("chmod", ["-R", "u+w", root]).catch(() => undefined);
      await fs.rm(root, { recursive: true, force: true });
    },
  };
  return self;
}
