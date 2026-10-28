import { createCommandRegistry } from "./commands-registry.js";
import type { CommandContext } from "./commands-context.js";
/**
 * A small, real mail world for multi-actor tests.
 *
 * Everything that decides delivery is the production code — storage, routes,
 * budgets, the coordinator service, the injection drain. Only the agents are
 * simulated: each one is idle until mail is delivered to it, then busy until
 * the test finishes its turn, exactly the edge the real activity observer
 * reports. Scenarios read like the conversation they exercise.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { COORDINATOR_MAIL_ADDRESS, coordinatorRuntimeId } from "@orkestrator/protocol/coordinator";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import type { AgentMailMessage, AgentMailNotice } from "@orkestrator/protocol/agent-mail";
import { AgentMailService } from "./agent-mail-service.js";
import { CoordinatorService, type CoordinatorDelegationOptions } from "./coordinator-service.js";
import type { CoordinatorDeliverNowResult } from "./coordinator-deliver-now.js";
import type { MailSteerDispatchOutcome } from "./native-agent-service-shared.js";
import type { CoordinatorStatusWakeOptions } from "./coordinator-status-wakes.js";
import { runCommand } from "./shell.js";
import type { AgentMailSender } from "./storage-agent-mail-store.js";
import { createEnvironment, createProject, StorageService } from "./storage.js";

export type MailActor = {
  name: string;
  environmentId: string;
  tabId: string;
  logicalSessionKey: string;
  role: "coordinator" | "side" | "worker" | "peer";
  conversationId?: string;
};

type Address = MailActor | typeof COORDINATOR_MAIL_ADDRESS | { environmentId: string };

const BASE_COMMIT = "a".repeat(40);

export type MailWorldOptions = {
  /** Status-wake collaborators for the coordinator service, kept across restarts. */
  statusWakes?: CoordinatorStatusWakeOptions;
  delegations?: CoordinatorDelegationOptions;
};

/** One carrier's JSON payload, the structured part of an injected mail prompt. */
export type DeliveredCarrier = {
  kind?: string;
  from: { kind: string };
  messageId: string;
  subject?: string;
  notice?: AgentMailNotice;
  body: string;
};

export class MailWorld {
  private readonly busy = new Set<string>();
  private readonly prompts = new Map<string, string[]>();
  /** Actors whose next dispatch is refused, as a bridge that will not start would. */
  readonly refuseNext = new Set<string>();
  /** Simulate the dispatch gate finding a busy session after the presence read. */
  readonly holdNext = new Set<string>();
  /** Force the next steer offered to an actor to end this way (by actor key). */
  readonly steerNext = new Map<string, MailSteerDispatchOutcome>();
  /** What the steer journal answers when an unanswered steer is verified. */
  steerJournal: "dispatched" | "not-dispatched" | "unknown" = "unknown";
  /** Steer request ids the drain asked the journal about. */
  readonly reconciledSteers: string[] = [];
  /** Lifecycle barriers for completion races, without waiting on the active drain. */
  afterSteer?: () => Promise<void>;
  beforeSteerJournal?: () => Promise<void>;
  private readonly steers = new Map<string, string[]>();
  private requestCounter = 0;

  /** Environments the drain asked to start because coordinator mail was waiting. */
  readonly startRequests: string[] = [];

  private constructor(
    readonly root: string,
    public storage: StorageService,
    public coordinator: CoordinatorService,
    public mail: AgentMailService,
    readonly projectId: string,
    readonly coordinatorId: string,
    private readonly options: MailWorldOptions,
  ) {}

  private static services(
    world: () => MailWorld,
    storage: StorageService,
    options: MailWorldOptions = {},
  ) {
    const { workerActivity, ...statusWakes } = options.statusWakes ?? {};
    const coordinator = new CoordinatorService(
      storage,
      () => ({
        enabled: true,
        running: true,
        error: null,
      }),
      undefined,
      workerActivity,
      { ...statusWakes, ...options.delegations },
    );
    const mail = new AgentMailService(
      storage,
      {
        reconcileMailInject: async () => "not-dispatched",
        sessionActivitySnapshot: (environmentId, _agent, key) =>
          world().busy.has(`${environmentId}\0${key}`) ? "working" : "idle",
        mailInjectPresence: async ({ environmentId, logicalSessionKey }) =>
          world().busy.has(`${environmentId}\0${logicalSessionKey}`) ? "working" : "idle",
        dispatchMailInject: async (input) => world().dispatch(input),
        steerMailInject: async (input) => world().steer(input),
        reconcileMailSteer: async ({ requestId }) => {
          world().reconciledSteers.push(requestId);
          await world().beforeSteerJournal?.();
          return world().steerJournal;
        },
      },
      {
        // A terminal agent's session key is the default one for its tab.
        mailInjectPresence: async ({ environmentId, tabId }) =>
          world().busy.has(`${environmentId}\0env-${environmentId}:${tabId}`) ? "working" : "idle",
        dispatchMailInject: async ({ environmentId, tabId, text }) => {
          const sent = await world().dispatch({
            environmentId,
            logicalSessionKey: `env-${environmentId}:${tabId}`,
            prompt: text,
            requestId: `tmux-${environmentId}-${tabId}`,
          });
          return sent.outcome === "rejected" ? { outcome: "unknown" as const } : sent;
        },
      },
      {
        coordinatorMailForStoppedEnvironment: async (environmentId) => {
          world().startRequests.push(environmentId);
        },
      },
    );
    return { coordinator, mail };
  }

  /**
   * The backend restarts: fresh storage, coordinator and mail services over the
   * same data directory. Agents keep doing what they were doing.
   */
  async restart(): Promise<void> {
    await this.mail.shutdown();
    this.storage = new StorageService(path.join(this.root, "data"));
    await this.storage.init();
    this.coordinator.stopStatusWakes();
    const { coordinator, mail } = MailWorld.services(() => this, this.storage, this.options);
    this.coordinator = coordinator;
    this.mail = mail;
    await this.mail.init();
  }

  async setEnvironmentStatus(actor: MailActor, status: "running" | "stopped"): Promise<void> {
    await this.storage.updateEnvironment(actor.environmentId, { status });
  }

  static async create(options: MailWorldOptions = {}): Promise<MailWorld> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ork-mail-world-"));
    const checkout = path.join(root, "checkout");
    await fs.mkdir(checkout);
    await runCommand("git", ["init", "-b", "main"], { cwd: checkout });
    await runCommand("git", ["config", "user.email", "test@example.invalid"], { cwd: checkout });
    await runCommand("git", ["config", "user.name", "Mail World"], { cwd: checkout });
    await fs.writeFile(path.join(checkout, "README.md"), "initial\n");
    await runCommand("git", ["add", "README.md"], { cwd: checkout });
    await runCommand("git", ["commit", "-m", "initial"], { cwd: checkout });
    const storage = new StorageService(path.join(root, "data"));
    await storage.init();
    const config = await storage.loadConfig();
    await storage.updateGlobalConfig({
      ...config.global,
      agentSettings: { ...config.global.agentSettings, defaultAgent: "codex" },
    });
    const project = await storage.addProject(
      createProject("https://example.invalid/mail-world.git", checkout),
    );
    let world: MailWorld | undefined;
    const { coordinator, mail } = MailWorld.services(() => world!, storage, options);
    const ensured = await coordinator.ensure(project.id);
    const main = ensured.workspace.conversations[0]!;
    await coordinator.assignConversationAgent(project.id, main.id, "codex");
    world = new MailWorld(
      root,
      storage,
      coordinator,
      mail,
      project.id,
      ensured.workspace.id,
      options,
    );
    await mail.init();
    return world;
  }

  private dispatch(input: {
    environmentId: string;
    logicalSessionKey: string;
    prompt: string;
    requestId: string;
  }) {
    const key = `${input.environmentId}\0${input.logicalSessionKey}`;
    if (this.refuseNext.delete(key)) {
      return Promise.resolve({ outcome: "rejected" as const, error: "bridge would not start" });
    }
    if (this.holdNext.delete(key) || this.busy.has(key))
      return Promise.resolve({ outcome: "held" as const, reason: "busy" as const });
    this.busy.add(key);
    this.prompts.set(key, [...(this.prompts.get(key) ?? []), input.prompt]);
    return Promise.resolve({ outcome: "accepted" as const, requestId: input.requestId });
  }

  /** A steer into the actor's running turn: applied if one is running. */
  private async steer(input: {
    environmentId: string;
    logicalSessionKey: string;
    text: string;
  }): Promise<MailSteerDispatchOutcome> {
    const key = `${input.environmentId}\0${input.logicalSessionKey}`;
    const forced = this.steerNext.get(key);
    if (forced) {
      this.steerNext.delete(key);
      return Promise.resolve(forced);
    }
    if (!this.busy.has(key)) return Promise.resolve({ outcome: "idle" });
    this.steers.set(key, [...(this.steers.get(key) ?? []), input.text]);
    await this.afterSteer?.();
    return { outcome: "applied" };
  }

  /** Message bodies steered into this actor's running turns, in order. */
  steered(actor: MailActor): string[] {
    return (this.steers.get(`${actor.environmentId}\0${actor.logicalSessionKey}`) ?? []).flatMap(
      (text) =>
        [
          ...text.matchAll(
            /<orkestrator-peer-payload-json>\n([\s\S]*?)\n<\/orkestrator-peer-payload-json>/g,
          ),
        ].map((match) => (JSON.parse(match[1]!) as DeliveredCarrier).body),
    );
  }

  /** Keys an actor for `steerNext`. */
  key(actor: MailActor): string {
    return `${actor.environmentId}\0${actor.logicalSessionKey}`;
  }

  /** The actor is mid-turn on something else (a user prompt, say). */
  startTurn(actor: MailActor): void {
    this.busy.add(this.key(actor));
  }

  async close(): Promise<void> {
    this.coordinator.stopStatusWakes();
    await this.mail.shutdown();
    await fs.rm(this.root, { recursive: true, force: true });
  }

  /** The project's main coordinator as it stands now. */
  async main(): Promise<MailActor> {
    const workspace = (await this.storage.coordinators.getCoordinatorWorkspace(this.projectId))!;
    const main = workspace.conversations.find((item) => item.role === "main" && !item.closedAt)!;
    return this.conversationActor("coordinator", main.id);
  }

  async addSide(): Promise<MailActor> {
    const snapshot = await this.coordinator.createConversation(this.projectId);
    const side = snapshot.workspace.conversations.find(
      (item) => item.role === "side" && !item.agent && !item.closedAt,
    )!;
    await this.coordinator.assignConversationAgent(this.projectId, side.id, "codex");
    return this.conversationActor("side", side.id);
  }

  async closeMain(): Promise<void> {
    const main = await this.main();
    await this.coordinator.closeConversation(this.projectId, main.conversationId!);
    await this.storage.synchronizeAgentMailboxes();
  }

  private async conversationActor(
    role: "coordinator" | "side",
    conversationId: string,
  ): Promise<MailActor> {
    const workspace = (await this.storage.coordinators.getCoordinatorWorkspace(this.projectId))!;
    const conversation = workspace.conversations.find((item) => item.id === conversationId)!;
    return {
      name: conversation.title,
      environmentId: coordinatorRuntimeId(workspace.id, conversation.id),
      tabId: conversation.tabId,
      logicalSessionKey: conversation.logicalSessionKey,
      role,
      conversationId: conversation.id,
    };
  }

  /**
   * An environment with one native agent tab. `launched` makes the main
   * coordinator its creator and opens the delegation its first turn answers,
   * the way `launch_environment` does.
   */
  async addEnvironment(
    name: string,
    options: { launched?: boolean; terminal?: boolean } = {},
  ): Promise<MailActor> {
    const environment = createEnvironment(this.projectId, { name, environmentType: "local" });
    environment.status = "running";
    environment.setupPhase = "ready";
    environment.setupScriptsComplete = true;
    await this.storage.addEnvironment(environment);
    await this.storage.savePaneLayout(
      environment.id,
      {
        version: PANE_LAYOUT_VERSION,
        containerId: null,
        activePaneId: "pane",
        root: {
          kind: "leaf",
          id: "pane",
          tabs: [
            options.terminal
              ? { id: "startup-agent", type: "claude-tmux" }
              : {
                  id: "startup-agent",
                  type: "agent-native",
                  nativeAgentData: { environmentId: environment.id, platform: "codex" },
                },
          ],
          activeTabId: "startup-agent",
        },
      },
      0,
    );
    const actor: MailActor = {
      name,
      environmentId: environment.id,
      tabId: "startup-agent",
      logicalSessionKey: `env-${environment.id}:startup-agent`,
      role: options.launched ? "worker" : "peer",
    };
    if (options.launched) {
      const main = await this.main();
      const association = await this.storage.coordinators.saveCoordinatorWorkflowAssociation({
        id: `launch-${environment.id}`,
        projectId: this.projectId,
        coordinatorId: this.coordinatorId,
        conversationId: main.conversationId!,
        kind: "environment",
        resourceId: environment.id,
        requestId: `launch-${name}`,
        baseBranch: "main",
        baseCommit: BASE_COMMIT,
        createdAt: new Date().toISOString(),
      });
      await this.storage.coordinators.openCoordinatorDelegation(association.id, "startup-agent");
      // The launch prompt starts its first turn.
      this.busy.add(`${actor.environmentId}\0${actor.logicalSessionKey}`);
    }
    await this.storage.synchronizeAgentMailboxes();
    return actor;
  }

  private sender(actor: MailActor): AgentMailSender {
    if (actor.role === "coordinator" || actor.role === "side") {
      return {
        kind: "coordinator",
        projectId: this.projectId,
        coordinatorId: this.coordinatorId,
        conversationId: actor.conversationId!,
        environmentId: actor.environmentId,
        tabId: actor.tabId,
      };
    }
    return {
      kind: "tab",
      projectId: this.projectId,
      environmentId: actor.environmentId,
      tabId: actor.tabId,
    };
  }

  /** Send as an agent would through its mail tool; `requestId` defaults to a fresh one. */
  send(from: MailActor, to: Address, body: string, requestId?: string): Promise<AgentMailMessage> {
    const destination =
      to === COORDINATOR_MAIL_ADDRESS
        ? { toEnvironmentId: COORDINATOR_MAIL_ADDRESS, toTabId: "" }
        : "tabId" in to
          ? { toEnvironmentId: to.environmentId, toTabId: to.tabId }
          : { toEnvironmentId: to.environmentId, toTabId: "" };
    this.requestCounter += 1;
    return this.storage.sendAgentMail(this.sender(from), {
      requestId: requestId ?? `world-${this.requestCounter}`,
      ...destination,
      body,
    });
  }

  /**
   * A coordinator asks a worker something: a message, plus the delegation it
   * opens — or, while the worker is still on an earlier request, the one it
   * joins (as `send_coordinator_agent_mail` does).
   */
  async delegate(
    from: MailActor,
    worker: MailActor,
    body: string,
    options: { deliverNow?: boolean; requestId?: string; replyToMessageId?: string } = {},
  ): Promise<AgentMailMessage & Partial<CoordinatorDeliverNowResult>> {
    this.requestCounter += 1;
    const send = createCommandRegistry().get("send_coordinator_agent_mail")!;
    return (await send(
      {
        projectId: this.projectId,
        coordinatorId: this.coordinatorId,
        conversationId: from.conversationId!,
        requestId: options.requestId ?? `world-${this.requestCounter}`,
        ...(options.replyToMessageId ? { replyToMessageId: options.replyToMessageId } : {}),
        toEnvironmentId: worker.environmentId,
        toTabId: worker.tabId,
        body,
        ...(options.deliverNow ? { deliverNow: true } : {}),
      },
      {
        storage: this.storage,
        coordinators: this.coordinator,
        drainAgentMail: () => this.mail.drainInjects(),
      } as CommandContext,
    )) as AgentMailMessage & Partial<CoordinatorDeliverNowResult>;
  }

  /** Run the injection drain until nothing more can be delivered. */
  async deliver(): Promise<void> {
    for (let pass = 0; pass < 3; pass += 1) await this.mail.drainInjects();
  }

  /** The agent's turn ends; a worker's end settles what its coordinator was waiting on. */
  async finishTurn(actor: MailActor, options: { deliver?: boolean } = {}): Promise<void> {
    this.busy.delete(`${actor.environmentId}\0${actor.logicalSessionKey}`);
    if (actor.role === "worker" || actor.role === "peer") {
      await this.coordinator.settleWorkerDelegations({
        environmentId: actor.environmentId,
        tabId: actor.tabId,
        state: "completed",
      });
    }
    if (options.deliver !== false) await this.deliver();
  }

  /** Every message body delivered to this actor, in order, across all its turns. */
  received(actor: MailActor): string[] {
    return this.carriers(actor).flatMap((turn) => turn.map((carrier) => carrier.body));
  }

  /** Each wake's carriers, as the agent's transcript would echo them. */
  carriers(actor: MailActor): DeliveredCarrier[][] {
    const prompts = this.prompts.get(`${actor.environmentId}\0${actor.logicalSessionKey}`) ?? [];
    return prompts.map((prompt) =>
      [
        ...prompt.matchAll(
          /<orkestrator-peer-payload-json>\n([\s\S]*?)\n<\/orkestrator-peer-payload-json>/g,
        ),
      ].map((match) => JSON.parse(match[1]!) as DeliveredCarrier),
    );
  }

  /** How many separate turns mail started for this actor. */
  wakes(actor: MailActor): number {
    return this.prompts.get(`${actor.environmentId}\0${actor.logicalSessionKey}`)?.length ?? 0;
  }

  /** Messages in this actor's inbox that ended somewhere other than delivered. */
  async undelivered(actor: MailActor): Promise<AgentMailMessage[]> {
    const inbox = await this.storage.getAgentMailMailbox(actor.environmentId, actor.tabId);
    return inbox.messages.filter(
      (message) => message.placement !== "injected",
    ) as AgentMailMessage[];
  }
}
