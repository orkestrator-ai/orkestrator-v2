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
}

function adoptMailbox(
  state: Pick<AgentMailState, "mailboxes" | "bodies">,
  snapshot: AgentMailMailboxSnapshot,
): { mailboxes: Map<string, AgentMailMailboxSnapshot>; bodies: Map<string, AgentMailMessage> } {
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

export const useAgentMailStore = create<AgentMailState>()((set) => ({
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
  clear: () => set({ revision: 0, summary: new Map(), mailboxes: new Map(), bodies: new Map() }),
  refreshSummary: async () => {
    const snapshot = await getAgentMailSummary();
    useAgentMailStore.getState().setSummary(snapshot);
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
