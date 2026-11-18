import { AGENT_MAIL_MAX_MAILBOXES } from "@orkestrator/protocol/agent-mail";
import type {
  AgentMailMailboxSnapshot,
  AgentMailMessage,
  AgentMailInboxSnapshot,
  AgentMailSummaryEntry,
  AgentMailSummarySnapshot,
} from "@orkestrator/protocol/agent-mail";
import * as backend from "@/lib/backend";
import { createAgentMailApi } from "@/lib/backend/agent-mail";
import { backendApiForScope } from "@/lib/backend/client";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { defineScopedStore } from "@/lib/node-scope/scoped-store";
import { scopedStoreHook } from "@/lib/node-scope/scoped-store";
import { appCommandScope } from "@/lib/node-scope-slots";

export interface AgentMailState {
  revision: number;
  summary: Map<string, AgentMailSummaryEntry>;
  mailboxes: Map<string, AgentMailMailboxSnapshot>;
  bodies: Map<string, AgentMailMessage>;
  setSummary: (snapshot: AgentMailSummarySnapshot) => void;
  setMailbox: (snapshot: AgentMailMailboxSnapshot) => void;
  setMailboxes: (snapshots: AgentMailMailboxSnapshot[]) => void;
  adoptInbox: (snapshot: AgentMailInboxSnapshot) => void;
  removeMailbox: (mailboxId: string) => void;
  clear: () => void;
  refreshSummary: () => Promise<void>;
  refreshMailbox: (environmentId: string, tabId: string) => Promise<void>;
  refreshMailboxes: (addresses: Array<{ environmentId: string; tabId: string }>) => Promise<void>;
  refreshInbox: () => Promise<AgentMailInboxSnapshot>;
  /** Reconcile cached transcript mailboxes after missed events. */
  refreshObservedMailboxes: () => Promise<void>;
  /** See `requestAgentMailMailbox`. */
  requestMailbox: (environmentId: string, tabId: string) => void;
}

function adoptMailbox(
  state: Pick<AgentMailState, "mailboxes" | "bodies">,
  snapshot: AgentMailMailboxSnapshot,
): Pick<AgentMailState, "mailboxes" | "bodies"> {
  const mailboxId = snapshot.descriptor.mailboxId;
  const previous = state.mailboxes.get(mailboxId);
  if (previous && previous.revision > snapshot.revision) {
    return { mailboxes: state.mailboxes, bodies: state.bodies };
  }
  const mailboxes = new Map(state.mailboxes);
  mailboxes.set(mailboxId, snapshot);
  const summaries = new Map(snapshot.messages.map((message) => [message.id, message]));
  const previousMessageIds = new Set(previous?.messages.map((message) => message.id) ?? []);
  const bodies = new Map(state.bodies);
  for (const messageId of previousMessageIds) {
    const summary = summaries.get(messageId);
    const body = bodies.get(messageId);
    if (!summary || (body && body.revision < summary.revision)) bodies.delete(messageId);
  }
  return { mailboxes, bodies };
}

/**
 * `scope`'s mail reads: the `@/lib/backend` named exports (which suites mock)
 * on the app's command scope, otherwise the scope's own node.
 */
function agentMailApi(scope: NodeScope) {
  return backendApiForScope(scope, createAgentMailApi, {
    getAgentMailInboxSnapshot: backend.getAgentMailInboxSnapshot,
    getAgentMailMailbox: backend.getAgentMailMailbox,
    getAgentMailMailboxes: backend.getAgentMailMailboxes,
    getAgentMailSummary: backend.getAgentMailSummary,
  });
}

/** Reconcile cached transcript mailboxes after missed events. */
export function refreshObservedAgentMailMailboxes(
  scope: NodeScope = appCommandScope(),
): Promise<void> {
  return scope.store(agentMailStore).getState().refreshObservedMailboxes();
}

/**
 * A node's agent mail: its mailboxes and summary, for transcript mail tiles
 * and the delivery banner.
 * One instance per node scope (plan item 3010): mailbox ids are environment
 * and tab ids, which only mean something on the node that holds them.
 */
export const agentMailStore = defineScopedStore<AgentMailState>(
  "agent-mail",
  (scope) => (set, get) => {
    /** Read per call, so a suite's module mock installed later is seen. */
    const api = () => agentMailApi(scope);
    let mailboxGeneration = 0;
    const requestedMailboxes = new Set<string>();
    const pendingMailboxes = new Map<string, { environmentId: string; tabId: string }>();
    return {
      revision: 0,
      summary: new Map(),
      mailboxes: new Map(),
      bodies: new Map(),
      setSummary: (snapshot) =>
        set((state) => {
          if (snapshot.revision < state.revision) return state;
          const summary = new Map(snapshot.mailboxes.map((entry) => [entry.mailboxId, entry]));
          const mailboxes = new Map(state.mailboxes);
          const bodies = new Map(state.bodies);
          for (const [mailboxId, mailbox] of state.mailboxes) {
            if (summary.has(mailboxId)) continue;
            mailboxes.delete(mailboxId);
            for (const message of mailbox.messages) bodies.delete(message.id);
          }
          return { revision: snapshot.revision, summary, mailboxes, bodies };
        }),
      setMailbox: (snapshot) => set((state) => adoptMailbox(state, snapshot)),
      setMailboxes: (snapshots) =>
        set((state) => {
          let next = { mailboxes: state.mailboxes, bodies: state.bodies };
          for (const snapshot of snapshots) next = adoptMailbox(next, snapshot);
          return next;
        }),
      adoptInbox: (snapshot) => {
        get().setSummary(snapshot.summary);
        get().setMailboxes(snapshot.mailboxes);
      },
      removeMailbox: (mailboxId) =>
        set((state) => {
          const mailbox = state.mailboxes.get(mailboxId);
          if (!mailbox) return state;
          const mailboxes = new Map(state.mailboxes);
          const bodies = new Map(state.bodies);
          mailboxes.delete(mailboxId);
          for (const message of mailbox.messages) bodies.delete(message.id);
          return { mailboxes, bodies };
        }),
      clear: () => {
        requestedMailboxes.clear();
        pendingMailboxes.clear();
        mailboxGeneration += 1;
        set({ revision: 0, summary: new Map(), mailboxes: new Map(), bodies: new Map() });
      },
      refreshSummary: async () => {
        const generation = mailboxGeneration;
        const snapshot = await api().getAgentMailSummary();
        if (!snapshot || generation !== mailboxGeneration) return;
        get().setSummary(snapshot);
        await get().refreshObservedMailboxes();
      },
      refreshMailbox: async (environmentId, tabId) => {
        const generation = mailboxGeneration;
        const snapshot = await api().getAgentMailMailbox(environmentId, tabId);
        if (generation === mailboxGeneration) get().setMailbox(snapshot);
      },
      refreshMailboxes: async (addresses) => {
        const generation = mailboxGeneration;
        for (let offset = 0; offset < addresses.length; offset += AGENT_MAIL_MAX_MAILBOXES) {
          const snapshot = await api().getAgentMailMailboxes(
            addresses.slice(offset, offset + AGENT_MAIL_MAX_MAILBOXES),
          );
          if (generation !== mailboxGeneration) return;
          get().setMailboxes(snapshot.mailboxes);
        }
      },
      refreshInbox: async () => {
        const generation = mailboxGeneration;
        const snapshot = await api().getAgentMailInboxSnapshot();
        if (generation === mailboxGeneration) get().adoptInbox(snapshot);
        return snapshot;
      },
      refreshObservedMailboxes: async () => {
        const store = get();
        const addresses = new Map<string, { environmentId: string; tabId: string }>();
        for (const [id, mailbox] of store.mailboxes) {
          const entry = store.summary.get(id);
          if (entry && entry.revision > mailbox.revision)
            addresses.set(id, {
              environmentId: mailbox.descriptor.environmentId,
              tabId: mailbox.descriptor.tabId,
            });
        }
        if (addresses.size) await store.refreshMailboxes(Array.from(addresses.values()));
      },
      requestMailbox: (environmentId, tabId) => {
        const mailboxId = `${environmentId}\0${tabId}`;
        if (requestedMailboxes.has(mailboxId) || get().mailboxes.has(mailboxId)) return;
        requestedMailboxes.add(mailboxId);
        pendingMailboxes.set(mailboxId, { environmentId, tabId });
        if (pendingMailboxes.size > 1) return;
        queueMicrotask(() => {
          const batch = Array.from(pendingMailboxes.values());
          pendingMailboxes.clear();
          if (batch.length === 0 || scope.disposed) return;
          const generation = mailboxGeneration;
          void get()
            .refreshMailboxes(batch)
            .catch(() => {
              if (generation !== mailboxGeneration) return;
              for (const address of batch)
                requestedMailboxes.delete(`${address.environmentId}\0${address.tabId}`);
            });
        });
      },
    };
  },
);

/** Reads the nearest node scope's agent mail; other code uses `scope.store(agentMailStore)`. */
export const useAgentMailStore = scopedStoreHook(agentMailStore);

/**
 * Load a mailbox a transcript names, so its tile can show the recipient's name
 * and the message's live delivery state. Each mailbox is asked for once per
 * node, and every request made in the same tick goes out as one batch;
 * resource events keep loaded mailboxes current after that.
 */
export function requestAgentMailMailbox(
  environmentId: string,
  tabId: string,
  scope: NodeScope = appCommandScope(),
): void {
  scope.store(agentMailStore).getState().requestMailbox(environmentId, tabId);
}
