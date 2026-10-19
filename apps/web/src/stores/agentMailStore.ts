import { create } from "zustand";
import { AGENT_MAIL_MAX_MAILBOXES } from "@orkestrator/protocol/agent-mail";
import type {
  AgentMailMailboxSnapshot,
  AgentMailMessage,
  AgentMailInboxSnapshot,
  AgentMailSummaryEntry,
  AgentMailSummarySnapshot,
} from "@orkestrator/protocol/agent-mail";
import {
  getAgentMailInboxSnapshot,
  getAgentMailMailbox,
  getAgentMailMailboxes,
  getAgentMailSummary,
} from "@/lib/backend";

/**
 * What the messages panel shows. Absent `conversation` is the list: every
 * pair, or only `focus`'s. A conversation is its two participant keys
 * (`agentMailParticipantKey`).
 */
export interface AgentMailPanelState {
  focus?: string;
  conversation?: [string, string];
}

export interface AgentMailDraft {
  subject: string;
  body: string;
  sending: boolean;
  attempts: Record<string, string>;
}
export const EMPTY_AGENT_MAIL_DRAFT: AgentMailDraft = {
  subject: "",
  body: "",
  sending: false,
  attempts: {},
};

interface AgentMailState {
  drafts: Map<string, AgentMailDraft>;
  updateDraft: (key: string, patch: Partial<AgentMailDraft>) => void;
  revision: number;
  panel: AgentMailPanelState | null;
  openPanel: (panel: AgentMailPanelState) => void;
  closePanel: () => void;
  summary: Map<string, AgentMailSummaryEntry>;
  mailboxes: Map<string, AgentMailMailboxSnapshot>;
  bodies: Map<string, AgentMailMessage>;
  sent: Map<
    string,
    { environmentId: string; tabId: string; placement: string; message: AgentMailMessage }
  >;
  failedSent: Map<string, AgentMailMessage>;
  setSummary: (snapshot: AgentMailSummarySnapshot) => void;
  setMailbox: (snapshot: AgentMailMailboxSnapshot) => void;
  setMailboxes: (snapshots: AgentMailMailboxSnapshot[]) => void;
  adoptInbox: (snapshot: AgentMailInboxSnapshot) => void;
  removeMailbox: (mailboxId: string) => void;
  clear: () => void;
  trackSent: (message: AgentMailMessage) => void;
  clearFailedSent: () => void;
  refreshSummary: () => Promise<void>;
  refreshMailbox: (environmentId: string, tabId: string) => Promise<void>;
  refreshMailboxes: (addresses: Array<{ environmentId: string; tabId: string }>) => Promise<void>;
  refreshInbox: () => Promise<AgentMailInboxSnapshot>;
}

function adoptMailbox(
  state: Pick<AgentMailState, "mailboxes" | "bodies" | "sent" | "failedSent">,
  snapshot: AgentMailMailboxSnapshot,
): Pick<AgentMailState, "mailboxes" | "bodies" | "sent" | "failedSent"> {
  const mailboxId = snapshot.descriptor.mailboxId;
  const previous = state.mailboxes.get(mailboxId);
  if (previous && previous.revision > snapshot.revision) {
    return {
      mailboxes: state.mailboxes,
      bodies: state.bodies,
      sent: state.sent,
      failedSent: state.failedSent,
    };
  }
  const mailboxes = new Map(state.mailboxes);
  mailboxes.set(mailboxId, snapshot);
  const summaries = new Map(snapshot.messages.map((message) => [message.id, message]));
  const previousMessageIds = new Set(previous?.messages.map((message) => message.id) ?? []);
  const bodies = new Map(state.bodies);
  const sent = new Map(state.sent);
  const failedSent = new Map(state.failedSent);
  for (const message of snapshot.messages) {
    const tracked = state.sent.get(message.id);
    if (tracked && tracked.placement !== "inject_failed" && message.placement === "inject_failed") {
      failedSent.set(message.id, { ...tracked.message, ...message });
    }
    if (tracked) {
      if (message.placement === "pending-inject" || message.placement === "inject-held") {
        sent.set(message.id, {
          ...tracked,
          placement: message.placement,
          message: { ...tracked.message, ...message },
        });
      } else {
        sent.delete(message.id);
      }
    }
  }
  for (const messageId of previousMessageIds) {
    const summary = summaries.get(messageId);
    const body = bodies.get(messageId);
    if (!summary || (body && body.revision < summary.revision)) bodies.delete(messageId);
  }
  return { mailboxes, bodies, sent, failedSent };
}

/** Reconcile cached transcript mailboxes as well as locally sent mail after missed events. */
export async function refreshObservedAgentMailMailboxes(): Promise<void> {
  const store = useAgentMailStore.getState();
  const addresses = new Map<string, { environmentId: string; tabId: string }>();
  for (const { environmentId, tabId } of store.sent.values())
    addresses.set(`${environmentId}\0${tabId}`, { environmentId, tabId });
  for (const [id, mailbox] of store.mailboxes) {
    const entry = store.summary.get(id);
    if (entry && entry.revision > mailbox.revision)
      addresses.set(id, {
        environmentId: mailbox.descriptor.environmentId,
        tabId: mailbox.descriptor.tabId,
      });
  }
  if (addresses.size) await store.refreshMailboxes(Array.from(addresses.values()));
}

export const useAgentMailStore = create<AgentMailState>()((set) => ({
  revision: 0,
  panel: null,
  drafts: new Map(),
  updateDraft: (key, patch) =>
    set((state) => ({
      drafts: new Map(state.drafts).set(key, {
        ...(state.drafts.get(key) ?? EMPTY_AGENT_MAIL_DRAFT),
        ...patch,
      }),
    })),
  openPanel: (panel) => set({ panel }),
  closePanel: () => set({ panel: null }),
  summary: new Map(),
  mailboxes: new Map(),
  bodies: new Map(),
  sent: new Map(),
  failedSent: new Map(),
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
      let next = {
        mailboxes: state.mailboxes,
        bodies: state.bodies,
        sent: state.sent,
        failedSent: state.failedSent,
      };
      for (const snapshot of snapshots) next = adoptMailbox(next, snapshot);
      return next;
    }),
  adoptInbox: (snapshot) => {
    useAgentMailStore.getState().setSummary(snapshot.summary);
    useAgentMailStore.getState().setMailboxes(snapshot.mailboxes);
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
    set({
      panel: null,
      drafts: new Map(),
      revision: 0,
      summary: new Map(),
      mailboxes: new Map(),
      bodies: new Map(),
      sent: new Map(),
      failedSent: new Map(),
    });
  },
  trackSent: (message) =>
    set((state) => {
      const sent = new Map(state.sent);
      if (message.placement === "pending-inject" || message.placement === "inject-held") {
        sent.set(message.id, {
          environmentId: message.toEnvironmentId,
          tabId: message.toTabId,
          placement: message.placement,
          message,
        });
      }
      return { sent, bodies: new Map(state.bodies).set(message.id, message) };
    }),
  clearFailedSent: () => set({ failedSent: new Map() }),
  refreshSummary: async () => {
    const generation = mailboxGeneration;
    const snapshot = await getAgentMailSummary();
    if (!snapshot || generation !== mailboxGeneration) return;
    useAgentMailStore.getState().setSummary(snapshot);
    await refreshObservedAgentMailMailboxes();
  },
  refreshMailbox: async (environmentId, tabId) => {
    const generation = mailboxGeneration;
    const snapshot = await getAgentMailMailbox(environmentId, tabId);
    if (generation === mailboxGeneration) useAgentMailStore.getState().setMailbox(snapshot);
  },
  refreshMailboxes: async (addresses) => {
    const generation = mailboxGeneration;
    for (let offset = 0; offset < addresses.length; offset += AGENT_MAIL_MAX_MAILBOXES) {
      const snapshot = await getAgentMailMailboxes(
        addresses.slice(offset, offset + AGENT_MAIL_MAX_MAILBOXES),
      );
      if (generation !== mailboxGeneration) return;
      useAgentMailStore.getState().setMailboxes(snapshot.mailboxes);
    }
  },
  refreshInbox: async () => {
    const generation = mailboxGeneration;
    const snapshot = await getAgentMailInboxSnapshot();
    if (generation === mailboxGeneration) useAgentMailStore.getState().adoptInbox(snapshot);
    return snapshot;
  },
}));

let mailboxGeneration = 0;
const requestedMailboxes = new Set<string>();
const pendingMailboxes = new Map<string, { environmentId: string; tabId: string }>();

/**
 * Load a mailbox a transcript names, so its tile can show the recipient's name
 * and the message's live delivery state. Each mailbox is asked for once, and
 * every request made in the same tick goes out as one batch; resource events
 * keep loaded mailboxes current after that.
 */
export function requestAgentMailMailbox(environmentId: string, tabId: string): void {
  const mailboxId = `${environmentId}\0${tabId}`;
  if (requestedMailboxes.has(mailboxId) || useAgentMailStore.getState().mailboxes.has(mailboxId))
    return;
  requestedMailboxes.add(mailboxId);
  pendingMailboxes.set(mailboxId, { environmentId, tabId });
  if (pendingMailboxes.size > 1) return;
  queueMicrotask(() => {
    const batch = Array.from(pendingMailboxes.values());
    pendingMailboxes.clear();
    if (batch.length === 0) return;
    const generation = mailboxGeneration;
    void useAgentMailStore
      .getState()
      .refreshMailboxes(batch)
      .catch(() => {
        if (generation !== mailboxGeneration) return;
        for (const address of batch)
          requestedMailboxes.delete(`${address.environmentId}\0${address.tabId}`);
      });
  });
}
