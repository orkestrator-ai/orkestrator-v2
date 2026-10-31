import { createHash, randomUUID } from "node:crypto";
import {
  AGENT_MAIL_MAX_BODY_BYTES,
  AGENT_MAIL_MAX_IDEMPOTENCY_ROWS,
  AGENT_MAIL_MAX_MESSAGES_PER_MAILBOX,
  AGENT_MAIL_MAX_REQUEST_ID_LENGTH,
  AGENT_MAIL_MAX_SUBJECT_LENGTH,
  AGENT_MAIL_HOURLY_LIMIT_REASON,
  AGENT_MAIL_LOOP_BUDGET_REASON,
  AGENT_MAIL_MAX_THREAD_HOPS,
  AgentMailError,
  agentMailCapabilities,
  agentMailRouteWakes,
  agentMailboxId,
  classifyAgentMailRoute,
  normalizeAgentMailNotice,
  normalizeAgentMessagingSettings,
  type AgentMailConversation,
  type AgentMailConversationList,
  type AgentMailMessage,
  type AgentMailMessageSummary,
  type AgentMailNotice,
  type AgentMailSendInput,
  type AgentMailTrust,
  type MailActor,
  nodeMailSenderKey,
} from "@orkestrator/protocol/agent-mail";
import {
  agentMailConversationBetween,
  isAgentMailConversationMessage,
  listAgentMailConversations,
  type ConversationMailbox,
} from "./agent-mail-conversations.js";
import {
  COORDINATOR_DELEGATION_HOLD_REASON,
  COORDINATOR_MAIL_ADDRESS,
  coordinatorConversationIdFromRuntimeId,
  coordinatorIdFromRuntimeId,
  coordinatorMainConversation,
  coordinatorRuntimeId,
} from "@orkestrator/protocol/coordinator";
import type { StorageContext } from "./storage-context.js";
import type { StorageFiles } from "./storage-files.js";
import type { StorageRepositories } from "./storage-repositories.js";
import {
  AgentMailStore,
  exceedsThreadHops,
  findMessage,
  metadataMessage,
  type AgentMailSender,
  type PersistedAgentMailStore,
  type PersistedMailbox,
} from "./storage-agent-mail-store.js";
import {
  latestMailboxPairDepth,
  pairBudgetEpoch,
  pairMessagesInLastHour,
} from "./storage-agent-mail-budgets.js";
import { coalescingWindow } from "./storage-agent-mail-injects.js";

const SETTLED_PLACEMENTS = new Set(["undeliverable", "bounced", "expired"]);

function idempotencyKey(senderScope: string, requestId: string): string {
  return createHash("sha256").update(senderScope).update("\0").update(requestId).digest("hex");
}

function sendFingerprint(input: AgentMailSendInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        toEnvironmentId: input.toEnvironmentId,
        toTabId: input.toTabId,
        subject: input.subject ?? null,
        body: input.body,
        replyToMessageId: input.replyToMessageId ?? null,
      }),
    )
    .digest("hex");
}

/**
 * Process-wide on purpose: one clock orders ids across every repository in the
 * process, so two on one database cannot interleave within a millisecond
 * (docs/architecture/backend-runtime.md).
 */
let lastIdTime = 0;

let idSequence = 0;

/**
 * Ids sort in send order: a clock that never runs backwards, then a sequence
 * within one millisecond, then a random suffix. Without the sequence, two
 * sends in the same millisecond ordered by their random suffixes.
 */
function sortableId(): string {
  const now = Date.now();
  if (now > lastIdTime) {
    lastIdTime = now;
    idSequence = 0;
  } else {
    idSequence += 1;
  }
  return `${lastIdTime.toString(36).padStart(10, "0")}-${idSequence.toString(36).padStart(4, "0")}-${randomUUID()}`;
}

/**
 * Agent mail (`agent-mail.json`): sending and replying, per-message state,
 * conversations, and deletion and retention. Mailbox synchronisation, inject
 * scheduling and budgets are collaborators sharing one {@link AgentMailStore}
 * (`storage-agent-mail-directory.ts`, `-injects.ts`, `-budgets.ts`).
 */
export class AgentMailRepository {
  constructor(
    private readonly context: StorageContext,
    private readonly files: StorageFiles,
    private readonly repos: StorageRepositories,
    private readonly store: AgentMailStore,
  ) {}

  private coordinatorMailResolver:
    ((projectId: string) => Promise<{ environmentId: string; tabId: string } | null>) | null = null;

  /** Set by the coordinator service, which can start a main conversation. */
  setCoordinatorMailResolver(resolver: AgentMailRepository["coordinatorMailResolver"]): void {
    this.coordinatorMailResolver = resolver;
  }

  /**
   * Rewrite a coordinator address to the project's current main conversation.
   *
   * Applies to the `"coordinator"` alias, a coordinator's bare runtime id, and
   * the address of a conversation that has since closed — which is what a
   * worker launched by a replaced main still holds. Redirected mail starts a
   * new message rather than replying into the closed conversation's thread,
   * whose other end no longer exists. Open conversations, side agents
   * included, are left alone; who may mail them is checked at send.
   */
  private async resolveCoordinatorAddress(
    sender: AgentMailSender,
    input: AgentMailSendInput,
  ): Promise<AgentMailSendInput> {
    const alias = input.toEnvironmentId === COORDINATOR_MAIL_ADDRESS;
    const coordinatorId = alias ? null : coordinatorIdFromRuntimeId(input.toEnvironmentId);
    if (!alias && !coordinatorId) {
      return input.toTabId
        ? input
        : { ...input, toTabId: await this.repos.agentMailboxes.recipientTab(sender, input) };
    }
    const workspaces = await this.repos.coordinators.listCoordinatorWorkspaces();
    const projectId =
      sender.kind === "tab" || sender.kind === "coordinator" || sender.kind === "system"
        ? sender.projectId
        : undefined;
    const workspace = alias
      ? workspaces.find((candidate) => candidate.projectId === projectId)
      : workspaces.find((candidate) => candidate.id === coordinatorId);
    if (!workspace) {
      if (alias) throw new AgentMailError("recipient-not-found", "This project has no coordinator");
      return input;
    }
    if (!alias) {
      const conversationId = coordinatorConversationIdFromRuntimeId(input.toEnvironmentId);
      const conversation = workspace.conversations.find((item) => item.id === conversationId);
      // One mailbox per conversation, so its tab id is never in doubt.
      if (conversation && !conversation.closedAt) return { ...input, toTabId: conversation.tabId };
    }
    const open = coordinatorMainConversation(workspace);
    const address = open
      ? { environmentId: coordinatorRuntimeId(workspace.id, open.id), tabId: open.tabId }
      : await this.coordinatorMailResolver?.(workspace.projectId);
    if (!address)
      throw new AgentMailError("recipient-not-found", "The project coordinator is not open");
    const { replyToMessageId: _replyToMessageId, ...rest } = input;
    return { ...rest, toEnvironmentId: address.environmentId, toTabId: address.tabId };
  }

  /**
   * Whether a coordinator request is still sitting undelivered in this worker's
   * inbox.
   *
   * A delegation opened by messaging a worker that was already mid-turn would
   * otherwise be settled by that in-flight turn ending — the worker has not
   * read the request yet, so reporting it as finished is a lie, and it is
   * exactly the kind of unsolicited "done" this design exists to prevent.
   *
   * Deliberately not filtered by time. The obvious version compares against the
   * delegation's `requestedAt`, but the request is *sent* before the delegation
   * is opened, so its `createdAt` is at best equal and usually earlier — the
   * comparison decides on a millisecond boundary and drops the very case it was
   * written for. Delivery state alone is the evidence, and it is unambiguous:
   * an uninjected request has not reached any turn.
   *
   * A worker started by `launch_environment` receives its request as the
   * startup tab's initial prompt rather than as mail. That prompt is pending
   * until the provider accepts it, which can be minutes after the delegation
   * opened (setup) and seconds after the tab's session exists and already
   * reads idle. `pendingAgentLaunch` is cleared only after acceptance, so it
   * is the same delivery evidence for that path.
   */
  async hasUndeliveredCoordinatorRequest(
    workerEnvironmentId: string,
    workerTabId: string,
  ): Promise<boolean> {
    if (
      workerTabId === "startup-agent" &&
      (await this.repos.projects.getEnvironment(workerEnvironmentId))?.pendingAgentLaunch === true
    ) {
      return true;
    }
    const store = await this.store.snapshot();
    const mailbox = store.mailboxes[agentMailboxId(workerEnvironmentId, workerTabId)];
    if (!mailbox) return false;
    return mailbox.messages.some(
      (message) =>
        (message.from.kind === "coordinator" ||
          (message.from.kind === "node" && message.from.role === "coordinator")) &&
        !message.injectedAt &&
        !message.ackedAt &&
        !message.discardedAt &&
        (message.placement === "pending-inject" || message.placement === "inject-held"),
    );
  }

  async getAgentMailMessage(
    environmentId: string,
    tabId: string,
    messageId: string,
  ): Promise<AgentMailMessage> {
    const store = await this.store.snapshot();
    const mailbox = store.mailboxes[agentMailboxId(environmentId, tabId)];
    const message = mailbox?.messages.find((candidate) => candidate.id === messageId);
    if (!message)
      throw new AgentMailError("message-not-found", "Message not found in this mailbox");
    return structuredClone(message);
  }

  /** Serializes follow-up admission with worker completion, including periodic recovery. */
  withAgentMailWorkerAdmission<T>(environmentId: string, operation: () => Promise<T>): Promise<T> {
    return this.context.serialize(
      `${this.files.agentMailFile()}:worker-admission:${environmentId}`,
      "worker mail admission",
      operation,
    );
  }

  private authenticateMailSender(
    store: PersistedAgentMailStore,
    sender: AgentMailSender,
  ): { actor: MailActor; senderScope: string; senderMailbox: PersistedMailbox | undefined } {
    let actor: MailActor;
    let senderScope: string;
    let senderMailbox: PersistedMailbox | undefined;
    if (sender.kind === "tab" || sender.kind === "coordinator") {
      senderMailbox = store.mailboxes[agentMailboxId(sender.environmentId, sender.tabId)];
      if (
        !senderMailbox ||
        senderMailbox.tombstonedAt ||
        senderMailbox.projectId !== sender.projectId
      ) {
        throw new AgentMailError("sender-not-found", "Sender tab is not an active mailbox");
      }
      if (
        sender.kind === "coordinator" &&
        (senderMailbox.ownerKind !== "coordinator" ||
          senderMailbox.coordinatorId !== sender.coordinatorId ||
          senderMailbox.conversationId !== sender.conversationId)
      ) {
        throw new AgentMailError(
          "capability-denied",
          "Coordinator identity does not own this mailbox",
        );
      }
      const capabilities = agentMailCapabilities(
        senderMailbox.tabType,
        senderMailbox.agent,
        senderMailbox.locked,
      );
      if (!capabilities.canSend)
        throw new AgentMailError("capability-denied", "This tab cannot send agent mail");
      if (senderMailbox.mutedOutbound)
        throw new AgentMailError("policy-denied", "Outbound messaging is muted for this mailbox");
      actor =
        sender.kind === "coordinator"
          ? {
              kind: "coordinator",
              projectId: senderMailbox.projectId,
              coordinatorId: sender.coordinatorId,
              conversationId: sender.conversationId,
              environmentId: senderMailbox.environmentId,
              tabId: senderMailbox.tabId,
              incarnationId: senderMailbox.incarnationId,
              agent: senderMailbox.agent!,
              title: senderMailbox.title,
            }
          : {
              kind: "tab",
              projectId: senderMailbox.projectId,
              environmentId: senderMailbox.environmentId,
              tabId: senderMailbox.tabId,
              incarnationId: senderMailbox.incarnationId,
              agent: senderMailbox.agent,
              title: senderMailbox.title,
            };
      senderScope = `${sender.kind}:${senderMailbox.mailboxId}`;
    } else if (sender.kind === "node") {
      actor = { ...sender, title: sender.title ?? null };
      senderScope = nodeMailSenderKey(sender);
    } else {
      actor = sender;
      senderScope =
        sender.kind === "system"
          ? `system:${sender.projectId}:${sender.source}:${sender.resourceId}`
          : sender.kind;
    }

    return { actor, senderScope, senderMailbox };
  }

  async sendAgentMail(
    sender: AgentMailSender,
    input: AgentMailSendInput,
    options: {
      newDelegation?: boolean;
      /** Structured facts for a workflow notice; ignored for any other sender. */
      notice?: AgentMailNotice;
      /**
       * Budget a workflow status notice as this stand-in sender
       * (`agentMailStatusBudgetKey`). Ignored for any other sender.
       */
      statusBudgetKey?: string;
      /**
       * Hold a scheduled wake this long so notices that land together are
       * delivered as one batch. A notice joins a window already open for the
       * recipient rather than starting its own.
       */
      coalesceMs?: number;
      /**
       * The coordinator's `deliverNow`: if the message is scheduled for
       * delivery, mark its pending entry `steerRequested`, exactly as Deliver
       * now does, so a recipient mid-turn has it steered into that turn.
       * Honoured only for a coordinator sender: one on this node, or a
       * command node's coordinator whose mail its node link delivered.
       */
      steer?: boolean;
    } = {},
  ): Promise<AgentMailMessage> {
    const requestId = input.requestId.trim();
    const notice = sender.kind === "system" ? normalizeAgentMailNotice(options.notice) : null;
    const statusBudgetKey =
      sender.kind === "system" && options.statusBudgetKey ? options.statusBudgetKey : undefined;
    if (!requestId || requestId.length > AGENT_MAIL_MAX_REQUEST_ID_LENGTH)
      throw new Error("requestId must be 1-256 characters");
    const bodyBytes = Buffer.byteLength(input.body, "utf8");
    if (!input.body.trim() || bodyBytes > AGENT_MAIL_MAX_BODY_BYTES)
      throw new Error("body must be non-empty and at most 32 KiB UTF-8");
    const subject = input.subject?.trim() || undefined;
    if (subject && subject.length > AGENT_MAIL_MAX_SUBJECT_LENGTH)
      throw new Error("subject must be at most 200 characters");
    // Idempotency keys on what the sender asked for, so a retry still matches
    // after "coordinator" has come to mean a different conversation.
    const requested = input;
    await this.repos.agentMailboxes.ensureAgentMailDirectoryFresh([
      sender.kind === "tab" || sender.kind === "coordinator" ? sender.environmentId : "",
    ]);
    const replay = await this.store.enqueue(async () => {
      const store = await this.store.snapshot();
      const { senderScope } = this.authenticateMailSender(store, sender);
      const key = idempotencyKey(senderScope, requestId);
      const fingerprint = sendFingerprint({ ...requested, subject });
      const prior = store.idempotency[key];
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw new AgentMailError(
            "idempotency-conflict",
            "requestId was already used with different content",
          );
        if (prior.bounce) return prior.bounce;
        const located = prior.messageId ? findMessage(store, prior.messageId) : null;
        if (located) return located.message;
        const counterpart = prior.messageId ? store.counterparts[prior.messageId] : undefined;
        if (counterpart) return { ...counterpart, body: "" };
        throw new AgentMailError(
          "message-not-found",
          "Idempotent message record is no longer retained",
        );
      }
      return null;
    });
    // A copy: the snapshot is shared and frozen, and a send returns its own message.
    if (replay) return structuredClone(replay);
    input = await this.resolveCoordinatorAddress(sender, input);
    await this.repos.agentMailboxes.ensureAgentMailDirectoryFresh([
      input.toEnvironmentId,
      sender.kind === "tab" || sender.kind === "coordinator" ? sender.environmentId : "",
    ]);
    const recipientEnvironment = await this.repos.projects.getEnvironment(input.toEnvironmentId);
    const config = await this.repos.config.loadConfig();
    const settings = normalizeAgentMessagingSettings(config.global.agentMessaging);
    if (!settings.enabled)
      throw new AgentMailError("messaging-disabled", "Agent messaging is disabled");

    const placed = await this.store.enqueue(async () => {
      const store = await this.store.load();
      const { actor, senderScope, senderMailbox } = this.authenticateMailSender(store, sender);
      const key = idempotencyKey(senderScope, requestId);
      const fingerprint = sendFingerprint({ ...requested, subject });
      const prior = store.idempotency[key];
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw new AgentMailError(
            "idempotency-conflict",
            "requestId was already used with different content",
          );
        if (prior.bounce) return prior.bounce;
        const located = prior.messageId ? findMessage(store, prior.messageId) : null;
        if (located) return located.message;
        const counterpart = prior.messageId ? store.counterparts[prior.messageId] : undefined;
        if (counterpart) return { ...counterpart, body: "" };
        throw new AgentMailError(
          "message-not-found",
          "Idempotent message record is no longer retained",
        );
      }
      if (Object.keys(store.idempotency).length >= AGENT_MAIL_MAX_IDEMPOTENCY_ROWS) {
        throw new AgentMailError("store-full", "Agent mail idempotency store is full");
      }

      const destinationId = agentMailboxId(input.toEnvironmentId, input.toTabId);
      const recipient = store.mailboxes[destinationId];
      if (!recipient || recipient.tombstonedAt)
        throw new AgentMailError("recipient-not-found", "Recipient mailbox is not active");
      // A mailbox is a tab, so a subagent or background task inside that tab
      // shares its address. Mail it sends "to the parent" would land back in
      // its own inbox and only surface when the whole tab next goes idle —
      // usually after the subagent that needed an answer has finished.
      if (senderMailbox?.mailboxId === destinationId)
        throw new AgentMailError(
          "policy-denied",
          "A tab cannot message its own mailbox. Subagents and background tasks share their parent tab's address, so this would only reach you; report to the parent session in your final result instead.",
        );
      // A side agent talks to its main coordinator and nobody else; only the
      // main (or the user) may talk to it. Everything else in the project
      // addresses the main, so a side agent is never a second coordinator.
      if (
        senderMailbox?.coordinatorRole === "side" &&
        !(
          recipient.ownerKind === "coordinator" &&
          recipient.coordinatorRole === "main" &&
          recipient.coordinatorId === senderMailbox.coordinatorId
        )
      ) {
        throw new AgentMailError(
          "policy-denied",
          'A side agent can only message the main coordinator. Send to "coordinator".',
        );
      }
      if (
        recipient.coordinatorRole === "side" &&
        sender.kind !== "user" &&
        !(
          senderMailbox?.coordinatorRole === "main" &&
          senderMailbox.coordinatorId === recipient.coordinatorId
        )
      ) {
        throw new AgentMailError(
          "policy-denied",
          'Side agents only receive mail from the main coordinator. Send to "coordinator" instead.',
        );
      }
      const crossProject = senderMailbox && senderMailbox.projectId !== recipient.projectId;
      if (crossProject && !settings.allowCrossProject)
        throw new AgentMailError("policy-denied", "Cross-project messaging is disabled");

      let parent: AgentMailMessage | undefined;
      if (input.replyToMessageId) {
        parent = findMessage(store, input.replyToMessageId)?.message;
        if (!parent) throw new AgentMailError("message-not-found", "Reply parent was not found");
        if (exceedsThreadHops(parent))
          throw new AgentMailError("hop-limit", "Thread hop limit reached");
        if (sender.kind === "tab" || sender.kind === "coordinator") {
          const senderIsParentSource =
            (parent.from.kind === "tab" || parent.from.kind === "coordinator") &&
            parent.from.environmentId === sender.environmentId &&
            parent.from.tabId === sender.tabId;
          const senderIsParentRecipient =
            parent.toEnvironmentId === sender.environmentId && parent.toTabId === sender.tabId;
          const senderParticipates = senderIsParentSource || senderIsParentRecipient;
          if (!senderParticipates)
            throw new AgentMailError("policy-denied", "Sender is not a participant in this thread");
          const senderIncarnationMatches = senderIsParentSource
            ? (parent.from.kind === "tab" || parent.from.kind === "coordinator") &&
              parent.from.incarnationId === senderMailbox?.incarnationId
            : parent.toIncarnationId === senderMailbox?.incarnationId;
          if (!senderIncarnationMatches) {
            throw new AgentMailError(
              "recipient-superseded",
              "This thread belongs to a prior incarnation of the sender tab",
            );
          }
          const expectedOther =
            (parent.from.kind === "tab" || parent.from.kind === "coordinator") &&
            parent.toEnvironmentId === sender.environmentId &&
            parent.toTabId === sender.tabId
              ? agentMailboxId(parent.from.environmentId, parent.from.tabId)
              : agentMailboxId(parent.toEnvironmentId, parent.toTabId);
          if (expectedOther !== destinationId)
            throw new AgentMailError("policy-denied", "A reply cannot redirect the thread");
          const expectedIncarnation =
            (parent.from.kind === "tab" || parent.from.kind === "coordinator") &&
            expectedOther === agentMailboxId(parent.from.environmentId, parent.from.tabId)
              ? parent.from.incarnationId
              : parent.toIncarnationId;
          if (recipient.incarnationId !== expectedIncarnation) {
            throw new AgentMailError(
              "recipient-superseded",
              "The other thread participant was closed and recreated",
            );
          }
        }
      }

      if (recipient.messages.length >= AGENT_MAIL_MAX_MESSAGES_PER_MAILBOX) {
        const eligible = recipient.messages
          .map((message, index) => ({ message, index }))
          .filter(
            ({ message }) =>
              message.ackedAt || message.discardedAt || SETTLED_PLACEMENTS.has(message.placement),
          )
          .sort((a, b) => a.message.createdAt.localeCompare(b.message.createdAt))[0];
        if (!eligible)
          throw new AgentMailError(
            "mailbox-backlog-full",
            "Recipient mailbox has too many unsettled messages",
          );
        recipient.messages.splice(eligible.index, 1);
      }

      const now = new Date().toISOString();
      const id = sortableId();
      const trust: AgentMailTrust =
        sender.kind === "user"
          ? "user"
          : sender.kind === "system" || sender.kind === "node"
            ? sender.projectId === recipient.projectId
              ? "same-project"
              : "cross-project"
            : sender.kind === "external"
              ? "external"
              : sender.environmentId === recipient.environmentId
                ? "same-environment"
                : sender.projectId === recipient.projectId
                  ? "same-project"
                  : "cross-project";
      const lineageCutoff = Date.now() - settings.retentionDays * 86_400_000;
      // Acknowledging a carrier must not reset its injection lineage: the
      // carrier itself asks the recipient to ack, and replies ack implicitly.
      // Retention bounds how long the lineage suppresses autonomous delivery.
      const recentlyInjected =
        senderMailbox?.messages.some(
          (message) =>
            message.injectedAt !== undefined && Date.parse(message.injectedAt) >= lineageCutoff,
        ) ?? false;
      const injectDepth =
        sender.kind === "tab" || sender.kind === "coordinator"
          ? parent?.injectedAt
            ? parent.injectDepth + 1
            : recentlyInjected
              ? 1
              : 0
          : 0;
      const effectivePolicy =
        recipient.injectOverride === "inherit"
          ? settings.defaultInjectPolicy
          : recipient.injectOverride;
      const route = classifyAgentMailRoute({
        trust,
        sender:
          sender.kind === "tab"
            ? { kind: "tab", coordinatorOrigin: senderMailbox?.coordinatorOrigin }
            : sender.kind === "coordinator"
              ? { kind: "coordinator", environmentId: senderMailbox!.environmentId }
              : { kind: sender.kind },
        recipient,
      });
      // Coordinator ↔ its workers, and peer ↔ peer, wake the recipient whatever
      // the default inject policy is. Only an explicit per-tab Off or a mute
      // stops them; the pair hop budget below bounds an unattended exchange.
      const routeWakes = agentMailRouteWakes(route, recipient.injectOverride, settings);
      // The pair a routed budget counts: the sending tab, the remote sender of
      // node mail, or for a workflow status notice the resource it reports on.
      const budgetSenderId =
        senderMailbox?.mailboxId ??
        (sender.kind === "node" ? nodeMailSenderKey(sender) : statusBudgetKey);
      const pairDepth =
        routeWakes && budgetSenderId
          ? latestMailboxPairDepth(store, budgetSenderId, destinationId, lineageCutoff)
          : null;
      // Only admission of a new delegation, a user prompt, or Resume resets
      // the pair budget. Follow-ups and main/side mail consume the same lineage.
      const startsBudget =
        options.newDelegation === true &&
        (sender.kind === "coordinator" ||
          (sender.kind === "node" && sender.role === "coordinator")) &&
        recipient.ownerKind !== "coordinator";
      const pairEpoch = startsBudget
        ? store.revision
        : budgetSenderId
          ? pairBudgetEpoch(store, budgetSenderId, destinationId)
          : 0;
      const parentDepthInEpoch =
        parent?.autonomousSequence !== undefined && parent.autonomousSequence > pairEpoch
          ? parent.threadDepth
          : -1;
      const nextThreadDepth = !routeWakes
        ? (parent?.threadDepth ?? -1) + 1
        : startsBudget
          ? 0
          : Math.max(parentDepthInEpoch, pairDepth ?? -1) + 1;
      const depthLimit = routeWakes ? settings.autonomousWakeBudget : AGENT_MAIL_MAX_THREAD_HOPS;
      const overHourlyLimit =
        routeWakes &&
        budgetSenderId !== undefined &&
        pairMessagesInLastHour(store, budgetSenderId, destinationId, Date.now()) >=
          settings.hourlyWakeLimit;
      const canInject = agentMailCapabilities(
        recipient.tabType,
        recipient.agent,
        recipient.locked,
      ).canInject;
      /*
       * A worker reporting to the coordinator that is currently waiting on it
       * does not get to interrupt. The coordinator asked for one answer and is
       * woken once, when the worker's turn ends; anything the worker sends
       * before then — a progress note, a partial finding, a second thought — is
       * stored and released together with that wake.
       *
       * This is the difference between a dispatcher and a chat room. Without it
       * a chatty worker turns one delegation into a turn per message, each one
       * billable and each one interrupting whatever the user is doing with the
       * coordinator. The message is never lost: it is readable immediately
       * through the mail tools and delivered in full on completion.
       */
      const holdingDelegation =
        (sender.kind === "tab" || (sender.kind === "node" && sender.role === "agent")) &&
        recipient.ownerKind === "coordinator" &&
        trust === "same-project"
          ? (await this.repos.coordinators.listOpenCoordinatorDelegations()).find(
              (association) =>
                // A worker on another node is the same worker only on that node.
                (sender.kind === "node"
                  ? association.nodeId === sender.nodeId
                  : association.nodeId === undefined) &&
                association.resourceId === sender.environmentId &&
                association.delegation?.workerTabId === sender.tabId &&
                // The delegation has to belong to *this* conversation. A second
                // conversation that never asked this worker for anything is not
                // waiting on it, so holding its mail would silence a message
                // nothing will ever release.
                association.conversationId !== undefined &&
                (coordinatorRuntimeId(association.coordinatorId, association.conversationId) ===
                  recipient.environmentId ||
                  // Work moves to the main coordinator; so does the hold.
                  (recipient.coordinatorRole === "main" &&
                    recipient.coordinatorId === association.coordinatorId)),
            )
          : undefined;
      const heldForDelegation =
        Boolean(holdingDelegation) && nextThreadDepth < depthLimit && !overHourlyLimit;
      const shouldScheduleInject =
        (effectivePolicy === "idle" || routeWakes) &&
        !recipient.mutedInbound &&
        !heldForDelegation &&
        trust !== "cross-project" &&
        trust !== "external" &&
        (injectDepth === 0 || routeWakes) &&
        nextThreadDepth < depthLimit &&
        !overHourlyLimit &&
        canInject;
      const heldForLoopBudget =
        routeWakes && !recipient.mutedInbound && nextThreadDepth >= depthLimit && canInject;
      const heldForHourlyLimit =
        routeWakes && !recipient.mutedInbound && !heldForLoopBudget && overHourlyLimit && canInject;
      const message: AgentMailMessage = {
        version: 1,
        id,
        threadId: parent?.threadId ?? id,
        ...(parent ? { replyToMessageId: parent.id } : {}),
        requestId,
        createdAt: now,
        from: actor,
        toEnvironmentId: recipient.environmentId,
        toTabId: recipient.tabId,
        toIncarnationId: recipient.incarnationId,
        ...(subject ? { subject } : {}),
        body: input.body,
        bodyBytes,
        trust,
        injectDepth,
        threadDepth: nextThreadDepth,
        ...(routeWakes
          ? { autonomousSequence: store.revision + 1, autonomousBudgetEpoch: pairEpoch }
          : {}),
        ...((shouldScheduleInject || heldForDelegation) && routeWakes
          ? { wakeAdmittedAt: now }
          : {}),
        ...(sender.kind === "coordinator" && recipientEnvironment?.status === "stopped"
          ? {
              recipientStoppedAtSend: true,
              recipientStopGeneration: recipientEnvironment.stopGeneration ?? 0,
            }
          : {}),
        ...(route ? { route } : {}),
        ...(notice ? { notice } : {}),
        ...(statusBudgetKey ? { statusBudgetKey } : {}),
        placement: shouldScheduleInject
          ? "pending-inject"
          : heldForDelegation || heldForLoopBudget || heldForHourlyLimit
            ? "inject-held"
            : "stored",
        ...(shouldScheduleInject
          ? {
              injectRequestId: `mail-inject-${id}`,
              ...(settings.paused ? { placementReason: "paused" } : {}),
            }
          : heldForDelegation
            ? {
                // Minted now, not on release: the delegation's completion
                // pushes this straight onto the pending index, and an inject
                // identity invented at that point would differ across a retry.
                injectRequestId: `mail-inject-${id}`,
                placementReason: COORDINATOR_DELEGATION_HOLD_REASON,
                coordinatorDelegationId: holdingDelegation!.id,
              }
            : heldForLoopBudget
              ? { placementReason: AGENT_MAIL_LOOP_BUDGET_REASON }
              : heldForHourlyLimit
                ? { placementReason: AGENT_MAIL_HOURLY_LIMIT_REASON }
                : {
                    // Stored is a decision, not a default: name why nobody will
                    // be woken so the sender and the user can see it.
                    placementReason:
                      trust === "cross-project" || trust === "external"
                        ? "untrusted-sender"
                        : !canInject
                          ? "recipient-cannot-inject"
                          : effectivePolicy !== "idle" && !routeWakes
                            ? route === "isolated"
                              ? "isolated-route"
                              : "inject-policy-off"
                            : injectDepth !== 0 && !routeWakes
                              ? "reply-to-injected-turn"
                              : "hop-limit",
                  }),
        revision: 1,
      };
      if (recipient.mutedInbound) {
        message.placement = "bounced";
        message.placementReason = "recipient-muted";
        store.idempotency[key] = {
          senderScope,
          requestId,
          fingerprint,
          createdAt: now,
          bounce: message,
        };
      } else {
        recipient.messages.push(message);
        recipient.revision += 1;
        store.idempotency[key] = {
          senderScope,
          requestId,
          fingerprint,
          createdAt: now,
          mailboxId: destinationId,
          messageId: id,
        };
        if (shouldScheduleInject) {
          store.pendingInject.push({
            mailboxId: destinationId,
            messageId: id,
            ...(options.coalesceMs && options.coalesceMs > 0
              ? {
                  retryAt: coalescingWindow(store, destinationId, options.coalesceMs),
                  coalescing: true as const,
                }
              : {}),
            // Only the placement above decides whether it is delivered at all;
            // this only lets an admitted delivery skip the wait for idle.
            ...(options.steer === true &&
            (sender.kind === "coordinator" ||
              (sender.kind === "node" && sender.role === "coordinator"))
              ? { steerRequested: true as const }
              : {}),
          });
        }
      }
      store.revision += 1;
      await this.store.save(store);
      // Ids and decisions only: never subjects or bodies.
      console.info("[agent-mail] placed", {
        messageId: message.id,
        from: message.from.kind,
        toEnvironmentId: message.toEnvironmentId,
        toTabId: message.toTabId,
        route: route ?? "none",
        trust,
        placement: message.placement,
        reason: message.placementReason ?? null,
        injectDepth,
        threadDepth: nextThreadDepth,
      });
      this.context.changes.announce("agent-mail", destinationId, recipient.projectId);
      this.context.changes.announce("agent-mail-summary", "all");
      return message;
    });
    await this.repos.agentMailBudgets.noticeCoordinatorBudgetHold(placed);
    return placed;
  }

  async replyAgentMail(
    sender: Extract<AgentMailSender, { kind: "tab" }>,
    parentMessageId: string,
    requestId: string,
    body: string,
    subject?: string,
  ): Promise<AgentMailMessage> {
    const parent = await this.getAgentMailMessage(
      sender.environmentId,
      sender.tabId,
      parentMessageId,
    );
    if (parent.from.kind !== "tab" && parent.from.kind !== "coordinator")
      throw new AgentMailError("policy-denied", "This sender cannot receive a tab reply");
    return this.sendAgentMail(sender, {
      requestId,
      toEnvironmentId: parent.from.environmentId,
      toTabId: parent.from.tabId,
      body,
      subject,
      replyToMessageId: parent.id,
    });
  }

  private async mutateMessage(
    environmentId: string,
    tabId: string,
    messageId: string,
    mutation: (message: AgentMailMessage) => boolean,
  ): Promise<AgentMailMessage> {
    return this.store.enqueue(async () => {
      const store = await this.store.load();
      const mailbox = store.mailboxes[agentMailboxId(environmentId, tabId)];
      const message = mailbox?.messages.find((candidate) => candidate.id === messageId);
      if (!mailbox || !message)
        throw new AgentMailError("message-not-found", "Message not found in this mailbox");
      if (!mutation(message)) return message;
      message.revision += 1;
      mailbox.revision += 1;
      store.revision += 1;
      await this.store.save(store);
      this.context.changes.announce("agent-mail", mailbox.mailboxId, mailbox.projectId);
      this.context.changes.announce("agent-mail-summary", "all");
      return message;
    });
  }

  ackAgentMail(environmentId: string, tabId: string, messageId: string): Promise<AgentMailMessage> {
    return this.mutateMessage(environmentId, tabId, messageId, (message) => {
      if (message.ackedAt) return false;
      message.ackedAt = new Date().toISOString();
      return true;
    });
  }

  markAgentMailSeen(
    environmentId: string,
    tabId: string,
    messageId: string,
  ): Promise<AgentMailMessage> {
    return this.mutateMessage(environmentId, tabId, messageId, (message) => {
      if (message.userSeenAt) return false;
      message.userSeenAt = new Date().toISOString();
      return true;
    });
  }

  discardAgentMail(
    environmentId: string,
    tabId: string,
    messageId: string,
  ): Promise<AgentMailMessage> {
    return this.mutateMessage(environmentId, tabId, messageId, (message) => {
      if (message.discardedAt) return false;
      if (message.placement === "inject-held" && message.placementReason === "submitting") {
        throw new AgentMailError(
          "policy-denied",
          "Delivery is currently being submitted; wait for it to settle before discarding",
        );
      }
      message.discardedAt = new Date().toISOString();
      if (message.placement === "pending-inject" || message.placement === "inject_failed") {
        message.placement = "expired";
        message.placementReason = "discarded";
      }
      return true;
    });
  }

  async getAgentMailStatus(messageId: string): Promise<AgentMailMessageSummary> {
    const store = await this.store.snapshot();
    const located = findMessage(store, messageId);
    if (located) return metadataMessage(located.message);
    const counterpart = store.counterparts[messageId];
    if (counterpart) return counterpart;
    for (const row of Object.values(store.idempotency)) {
      if (row.bounce?.id === messageId) return metadataMessage(row.bounce);
    }
    throw new AgentMailError("message-not-found", "Message status is no longer retained");
  }

  async listAgentMailSentByMailbox(
    environmentId: string,
    tabId: string,
  ): Promise<AgentMailMessageSummary[]> {
    const [store, config] = await Promise.all([
      this.store.snapshot(),
      this.repos.config.loadConfig(),
    ]);
    const cutoff =
      Date.now() -
      normalizeAgentMessagingSettings(config.global.agentMessaging).retentionDays * 86_400_000;
    const mailboxId = agentMailboxId(environmentId, tabId);
    return Object.values(store.mailboxes)
      .flatMap((mailbox) => mailbox.messages)
      .filter(
        (message) =>
          Date.parse(message.createdAt) >= cutoff &&
          (message.from.kind === "tab" || message.from.kind === "coordinator") &&
          agentMailboxId(message.from.environmentId, message.from.tabId) === mailboxId,
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, AGENT_MAIL_MAX_MESSAGES_PER_MAILBOX)
      .map(metadataMessage);
  }

  async listUserSentAgentMail(): Promise<AgentMailMessageSummary[]> {
    const [store, config] = await Promise.all([
      this.store.snapshot(),
      this.repos.config.loadConfig(),
    ]);
    const cutoff =
      Date.now() -
      normalizeAgentMessagingSettings(config.global.agentMessaging).retentionDays * 86_400_000;
    return Object.values(store.mailboxes)
      .flatMap((mailbox) => mailbox.messages)
      .filter((message) => message.from.kind === "user" && Date.parse(message.createdAt) >= cutoff)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, AGENT_MAIL_MAX_MESSAGES_PER_MAILBOX)
      .map(metadataMessage);
  }

  private async conversationMailboxes(): Promise<{
    revision: number;
    cutoff: number;
    mailboxes: ConversationMailbox[];
  }> {
    const [store, config] = await Promise.all([
      this.store.snapshot(),
      this.repos.config.loadConfig(),
    ]);
    const settings = normalizeAgentMessagingSettings(config.global.agentMessaging);
    return {
      revision: store.revision,
      cutoff: Date.now() - settings.retentionDays * 86_400_000,
      mailboxes: Object.values(store.mailboxes).map((mailbox) => ({
        descriptor: this.repos.agentMailboxes.descriptor(mailbox, settings.defaultInjectPolicy),
        messages: mailbox.messages,
      })),
    };
  }

  /** Every pair that has exchanged mail, or only `participant`'s; see `agent-mail-conversations.ts`. */
  async listAgentMailConversations(
    options: { participant?: string } = {},
  ): Promise<AgentMailConversationList> {
    const { revision, cutoff, mailboxes } = await this.conversationMailboxes();
    return {
      revision,
      conversations: listAgentMailConversations(mailboxes, { cutoff, ...options }),
    };
  }

  async getAgentMailConversation(
    a: string,
    b: string,
    options: { limit?: number } = {},
  ): Promise<AgentMailConversation> {
    const { revision, cutoff, mailboxes } = await this.conversationMailboxes();
    return agentMailConversationBetween(mailboxes, a, b, { cutoff, revision, ...options });
  }

  /** Stamp only messages present in the conversation snapshot the person displayed. */
  async markAgentMailConversationSeen(a: string, b: string, messageIds: string[]): Promise<number> {
    const displayed = new Set(messageIds);
    return this.store.enqueue(async () => {
      const store = await this.store.load();
      const seenAt = new Date().toISOString();
      const changed: PersistedMailbox[] = [];
      let marked = 0;
      for (const key of new Set([a, b])) {
        const mailbox = store.mailboxes[key];
        if (!mailbox) continue;
        let mailboxMarked = false;
        for (const message of mailbox.messages) {
          if (
            !displayed.has(message.id) ||
            message.userSeenAt ||
            !isAgentMailConversationMessage(key, message, a, b)
          )
            continue;
          message.userSeenAt = seenAt;
          message.revision += 1;
          mailboxMarked = true;
          marked += 1;
        }
        if (mailboxMarked) {
          mailbox.revision += 1;
          changed.push(mailbox);
        }
      }
      if (marked === 0) return 0;
      store.revision += 1;
      await this.store.save(store);
      for (const mailbox of changed)
        this.context.changes.announce("agent-mail", mailbox.mailboxId, mailbox.projectId);
      this.context.changes.announce("agent-mail-summary", "all");
      return marked;
    });
  }

  async deleteAgentMailByProject(projectId: string): Promise<void> {
    await this.store.enqueue(async () => {
      const store = await this.store.load();
      const mailboxIds = new Set(
        Object.values(store.mailboxes)
          .filter((mailbox) => mailbox.projectId === projectId)
          .map((mailbox) => mailbox.mailboxId),
      );
      if (mailboxIds.size === 0) return;
      const changedMailboxes = new Map<string, string | undefined>();
      for (const mailboxId of mailboxIds) {
        const mailbox = store.mailboxes[mailboxId];
        if (mailbox) {
          for (const message of mailbox.messages) {
            store.counterparts[message.id] = {
              ...metadataMessage(message),
              placement: "undeliverable",
              placementReason: "recipient-deleted",
              revision: message.revision + 1,
            };
          }
          changedMailboxes.set(mailboxId, mailbox.projectId);
        }
        delete store.mailboxes[mailboxId];
      }
      for (const mailbox of Object.values(store.mailboxes)) {
        for (const message of mailbox.messages) {
          if (
            (message.from.kind !== "tab" &&
              message.from.kind !== "coordinator" &&
              message.from.kind !== "system" &&
              message.from.kind !== "node") ||
            message.from.projectId !== projectId
          ) {
            continue;
          }
          message.body = "";
          message.bodyBytes = 0;
          delete message.subject;
          message.placement = "expired";
          message.placementReason = "sender-deleted";
          message.revision += 1;
          mailbox.revision += 1;
          changedMailboxes.set(mailbox.mailboxId, mailbox.projectId);
        }
      }
      store.pendingInject = store.pendingInject.filter((item) => !mailboxIds.has(item.mailboxId));
      for (const [key, row] of Object.entries(store.idempotency)) {
        if (
          (row.mailboxId && mailboxIds.has(row.mailboxId)) ||
          Array.from(mailboxIds).some(
            (mailboxId) =>
              row.senderScope === `tab:${mailboxId}` ||
              row.senderScope === `coordinator:${mailboxId}`,
          ) ||
          row.senderScope.startsWith(`system:${projectId}:`)
        ) {
          delete store.idempotency[key];
        }
      }
      store.revision += 1;
      await this.store.save(store);
      await this.context.transformSensitiveJsonBackups(this.files.agentMailFile(), (record) => {
        const backup = record as unknown as PersistedAgentMailStore;
        if (backup.version !== 1 || !backup.mailboxes) return record;
        for (const [mailboxId, mailbox] of Object.entries(backup.mailboxes)) {
          if (mailbox.projectId === projectId) delete backup.mailboxes[mailboxId];
          else
            for (const message of mailbox.messages ?? []) {
              if (
                (message.from.kind === "tab" ||
                  message.from.kind === "coordinator" ||
                  message.from.kind === "system" ||
                  message.from.kind === "node") &&
                message.from.projectId === projectId
              ) {
                message.body = "";
                message.bodyBytes = 0;
                delete message.subject;
              }
            }
        }
        return backup as unknown as Record<string, unknown>;
      });
      for (const [mailboxId, affectedProjectId] of changedMailboxes) {
        this.context.changes.announce("agent-mail", mailboxId, affectedProjectId);
      }
      this.context.changes.announce("agent-mail-summary", "all");
    });
  }

  async deleteAgentMailByEnvironment(environmentId: string): Promise<void> {
    if (!environmentId.trim()) throw new Error("environmentId is required");
    await this.store.enqueue(async () => {
      const store = await this.store.load();
      let changed = false;
      const changedMailboxes = new Map<string, string | undefined>();
      for (const [mailboxId, mailbox] of Object.entries(store.mailboxes)) {
        if (mailbox.environmentId === environmentId) {
          for (const message of mailbox.messages) {
            store.counterparts[message.id] = {
              ...metadataMessage(message),
              placement: "undeliverable",
              placementReason: "recipient-deleted",
              revision: message.revision + 1,
            };
          }
          changedMailboxes.set(mailboxId, mailbox.projectId);
          delete store.mailboxes[mailboxId];
          changed = true;
          continue;
        }
        for (const message of mailbox.messages) {
          if (message.from.kind !== "tab" || message.from.environmentId !== environmentId) continue;
          message.body = "";
          message.bodyBytes = 0;
          delete message.subject;
          message.placement = "expired";
          message.placementReason = "sender-deleted";
          message.revision += 1;
          mailbox.revision += 1;
          changedMailboxes.set(mailboxId, mailbox.projectId);
          changed = true;
        }
      }
      for (const [key, row] of Object.entries(store.idempotency)) {
        if (row.senderScope.startsWith(`tab:${environmentId}\0`)) {
          delete store.idempotency[key];
          changed = true;
        }
      }
      const pendingInject = store.pendingInject.filter(
        ({ mailboxId }) => !mailboxId.startsWith(`${environmentId}\0`),
      );
      if (pendingInject.length !== store.pendingInject.length) changed = true;
      store.pendingInject = pendingInject;
      if (!changed) return;
      store.revision += 1;
      await this.store.save(store);
      await this.context.transformSensitiveJsonBackups(this.files.agentMailFile(), (record) => {
        const backup = record as unknown as PersistedAgentMailStore;
        if (backup.version !== 1 || !backup.mailboxes) return record;
        for (const [mailboxId, mailbox] of Object.entries(backup.mailboxes)) {
          if (mailbox.environmentId === environmentId) delete backup.mailboxes[mailboxId];
          else
            for (const message of mailbox.messages ?? []) {
              if (message.from.kind === "tab" && message.from.environmentId === environmentId) {
                message.body = "";
                message.bodyBytes = 0;
                delete message.subject;
              }
            }
        }
        return backup as unknown as Record<string, unknown>;
      });
      for (const [mailboxId, projectId] of changedMailboxes) {
        this.context.changes.announce("agent-mail", mailboxId, projectId);
      }
      this.context.changes.announce("agent-mail-summary", "all");
    });
  }

  async pruneAgentMail(retentionDays: number): Promise<void> {
    const cutoff = Date.now() - Math.max(1, retentionDays) * 86_400_000;
    await this.store.enqueue(async () => {
      const store = await this.store.load();
      let changed = false;
      const changedMailboxes = new Map<string, string | undefined>();
      for (const [mailboxId, mailbox] of Object.entries(store.mailboxes)) {
        const retained = mailbox.messages.filter((message) => {
          const old = Date.parse(message.createdAt) < cutoff;
          // Retention is the hard bound for message content. It applies even
          // when a recipient disappeared without acknowledging the message;
          // otherwise tombstoned mailboxes grow forever and can make the
          // bounded store impossible to write or prune.
          return !old;
        });
        if (retained.length !== mailbox.messages.length) {
          mailbox.messages = retained;
          mailbox.revision += 1;
          changedMailboxes.set(mailboxId, mailbox.projectId);
          changed = true;
        }
        if (mailbox.tombstonedAt && mailbox.messages.length === 0) {
          changedMailboxes.set(mailboxId, mailbox.projectId);
          delete store.mailboxes[mailboxId];
          changed = true;
        }
      }
      for (const [key, row] of Object.entries(store.idempotency)) {
        if (Date.parse(row.createdAt) < cutoff) {
          delete store.idempotency[key];
          changed = true;
        }
      }
      for (const [messageId, counterpart] of Object.entries(store.counterparts)) {
        if (Date.parse(counterpart.createdAt) < cutoff) {
          delete store.counterparts[messageId];
          changed = true;
        }
      }
      const pendingInject = store.pendingInject.filter(({ mailboxId, messageId }) =>
        store.mailboxes[mailboxId]?.messages.some((message) => message.id === messageId),
      );
      if (pendingInject.length !== store.pendingInject.length) {
        store.pendingInject = pendingInject;
        changed = true;
      }
      if (!changed) return;
      store.revision += 1;
      await this.store.save(store);
      for (const [mailboxId, projectId] of changedMailboxes) {
        this.context.changes.announce("agent-mail", mailboxId, projectId);
      }
      this.context.changes.announce("agent-mail-summary", "all");
    });
  }
}
