import { create } from "zustand";
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

interface AgentMailState {
  revision: number;
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

async function refreshTrackedSentMailboxes(): Promise<void> {
  const addresses = Array.from(useAgentMailStore.getState().sent.values()).map(
    ({ environmentId, tabId }) => ({ environmentId, tabId }),
  );
  if (addresses.length === 0) return;
  const unique = Array.from(
    new Map(
      addresses.map((address) => [`${address.environmentId}\0${address.tabId}`, address]),
    ).values(),
  );
  const snapshot = await getAgentMailMailboxes(unique);
  useAgentMailStore.getState().setMailboxes(snapshot.mailboxes);
}

export const useAgentMailStore = create<AgentMailState>()((set) => ({
  revision: 0,
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
  clear: () =>
    set({
      revision: 0,
      summary: new Map(),
      mailboxes: new Map(),
      bodies: new Map(),
      sent: new Map(),
      failedSent: new Map(),
    }),
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
    const snapshot = await getAgentMailSummary();
    if (!snapshot) return;
    useAgentMailStore.getState().setSummary(snapshot);
    await refreshTrackedSentMailboxes();
  },
  refreshMailbox: async (environmentId, tabId) => {
    const snapshot = await getAgentMailMailbox(environmentId, tabId);
    useAgentMailStore.getState().setMailbox(snapshot);
  },
  refreshMailboxes: async (addresses) => {
    const snapshot = await getAgentMailMailboxes(addresses);
    useAgentMailStore.getState().setMailboxes(snapshot.mailboxes);
  },
  refreshInbox: async () => {
    const snapshot = await getAgentMailInboxSnapshot();
    useAgentMailStore.getState().adoptInbox(snapshot);
    return snapshot;
  },
}));
