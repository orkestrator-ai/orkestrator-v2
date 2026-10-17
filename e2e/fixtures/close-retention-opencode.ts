/**
 * A stateful in-memory OpenCode server for the close-retention browser host.
 *
 * Built on the SDK client fake the provider suites use, with the session
 * group replaced by a small conversation store: `create` mints distinct ids,
 * `list` and `get` answer from what was created, `messages` returns the turns
 * each session actually ran, and `promptAsync` answers and announces the turn
 * on the event stream the way `opencode serve` does. `delete` would remove a
 * conversation, so a close that called it would fail the spec. Like OpenCode,
 * it keeps the title a session was created with until `update` changes it;
 * it never derives one from the first prompt.
 *
 * Prompts containing `HOLD` stay busy until `abort`.
 */
import { openCodeFake } from "../../apps/backend/src/core/agent-provider-test-support";
import { OPENCODE_PROVIDER_LIST_RESPONSE } from "../../apps/backend/src/core/opencode-provider-list-test-fixtures";

type Message = { info: Record<string, unknown>; parts: Array<Record<string, unknown>> };
type Session = {
  id: string;
  directory: string;
  title: string;
  time: { created: number; updated: number };
  busy: boolean;
  messages: Message[];
  /** `metadata` and `permission`, as `session.update` last left them. */
  settings: Record<string, unknown>;
  /** Releases a held turn. */
  release?: () => void;
};

export type OpenCodeVendorView = {
  sessions: Array<{ id: string; title: string; prompts: string[]; replies: string[] }>;
  deleted: string[];
  /** Every session `abort` reached, in order; a retaining close aborts. */
  aborted: string[];
};

export function createOpenCodeEngine(directory: string) {
  const fake = openCodeFake();
  const sessions = new Map<string, Session>();
  const deleted: string[] = [];
  const aborted: string[] = [];
  let sequence = 0;
  const nextId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${(sequence += 1)}`;
  const emit = (type: string, properties: Record<string, unknown>) => {
    const event = structuredClone({ type, properties });
    for (const subscription of fake.subscriptions) subscription.push(event);
  };
  const sessionInfo = (session: Session) => ({
    id: session.id,
    slug: session.id,
    projectID: "close-retention",
    directory: session.directory,
    title: session.title,
    version: "1.19.0",
    time: { ...session.time },
    ...structuredClone(session.settings),
  });
  const notFound = { error: { name: "NotFound", data: {} }, response: { status: 404 } };
  const settle = (session: Session, assistant: Message, text: string, error?: unknown) => {
    const now = Date.now();
    assistant.info.time = {
      created: (assistant.info.time as { created: number }).created,
      completed: now,
    };
    if (error) assistant.info.error = error;
    if (text) {
      assistant.parts.push({
        id: nextId("prt"),
        sessionID: session.id,
        messageID: assistant.info.id,
        type: "text",
        text,
        time: { start: now, end: now },
      });
    }
    session.busy = false;
    session.release = undefined;
    session.time.updated = now;
    emit("message.updated", { sessionID: session.id, info: assistant.info });
    for (const part of assistant.parts)
      emit("message.part.updated", { sessionID: session.id, part });
    emit("session.status", { sessionID: session.id, status: { type: "idle" } });
    emit("session.idle", { sessionID: session.id });
  };

  Object.assign(fake.client.session, {
    async create(parameters?: Record<string, unknown>) {
      const now = Date.now();
      const session: Session = {
        id: nextId("ses"),
        directory: String(parameters?.directory ?? directory),
        title: String(parameters?.title ?? "New session"),
        time: { created: now, updated: now },
        busy: false,
        messages: [],
        settings: {},
      };
      sessions.set(session.id, session);
      return { data: sessionInfo(session) };
    },
    async update(parameters: Record<string, unknown>) {
      const session = sessions.get(String(parameters.sessionID ?? ""));
      if (!session) return notFound;
      if (typeof parameters.title === "string") session.title = parameters.title;
      // OpenCode replaces a supplied metadata object and appends permission
      // rules, the later rule winning.
      if (parameters.metadata !== undefined) session.settings.metadata = parameters.metadata;
      if (Array.isArray(parameters.permission)) {
        const current = Array.isArray(session.settings.permission)
          ? session.settings.permission
          : [];
        session.settings.permission = [...current, ...parameters.permission];
      }
      return { data: sessionInfo(session) };
    },
    async get(parameters: Record<string, unknown>) {
      const session = sessions.get(String(parameters.sessionID ?? ""));
      return session ? { data: sessionInfo(session) } : notFound;
    },
    async list() {
      return {
        data: [...sessions.values()]
          .filter((session) => session.messages.length > 0)
          .map(sessionInfo),
      };
    },
    async status() {
      return {
        data: Object.fromEntries(
          [...sessions.values()].map((session) => [
            session.id,
            { type: session.busy ? "busy" : "idle" },
          ]),
        ),
      };
    },
    async messages(parameters?: Record<string, unknown>) {
      const session = sessions.get(String(parameters?.sessionID ?? ""));
      if (!session) return notFound;
      const limit = Number(parameters?.limit ?? 0);
      const messages = limit > 0 ? session.messages.slice(-limit) : session.messages;
      return { data: structuredClone(messages) };
    },
    async promptAsync(parameters: Record<string, unknown>) {
      const session = sessions.get(String(parameters.sessionID ?? ""));
      if (!session) return notFound;
      const now = Date.now();
      const text = ((parameters.parts as Array<{ type?: string; text?: string }>) ?? [])
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("");
      const model = (parameters.model as { providerID?: string; modelID?: string }) ?? {};
      const userId = String(parameters.messageID ?? nextId("msg"));
      const user: Message = {
        info: {
          id: userId,
          sessionID: session.id,
          role: "user",
          time: { created: now },
          agent: "build",
          model: { providerID: model.providerID ?? "opencode", modelID: model.modelID ?? "fake" },
        },
        parts: [
          { id: nextId("prt"), sessionID: session.id, messageID: userId, type: "text", text },
        ],
      };
      const assistant: Message = {
        info: {
          id: nextId("msg"),
          sessionID: session.id,
          role: "assistant",
          parentID: userId,
          time: { created: now },
          modelID: model.modelID ?? "fake",
          providerID: model.providerID ?? "opencode",
          mode: "build",
          agent: "build",
          path: { cwd: session.directory, root: session.directory },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [],
      };
      session.messages.push(user, assistant);
      session.busy = true;
      session.time.updated = now;
      emit("session.status", { sessionID: session.id, status: { type: "busy" } });
      emit("message.updated", { sessionID: session.id, info: user.info });
      for (const part of user.parts) emit("message.part.updated", { sessionID: session.id, part });
      emit("message.updated", { sessionID: session.id, info: assistant.info });
      if (text.includes("HOLD")) {
        session.release = () =>
          settle(session, assistant, "", { name: "MessageAbortedError", data: {} });
      } else {
        // Answered after the dispatch returns, as a real server answers.
        queueMicrotask(() => settle(session, assistant, `Answer to: ${text}`));
      }
      return { data: true };
    },
    async abort(parameters?: Record<string, unknown>) {
      const session = sessions.get(String(parameters?.sessionID ?? ""));
      if (!session) return notFound;
      aborted.push(session.id);
      session.release?.();
      return { data: true };
    },
    async delete(parameters?: Record<string, unknown>) {
      const id = String(parameters?.sessionID ?? "");
      deleted.push(id);
      sessions.delete(id);
      return { data: true };
    },
  });
  Object.assign(fake.client as object, {
    provider: { list: async () => ({ data: OPENCODE_PROVIDER_LIST_RESPONSE }) },
  });

  const textsOf = (session: Session, role: string) =>
    session.messages
      .filter((message) => message.info.role === role)
      .map((message) =>
        message.parts
          .filter((part) => part.type === "text")
          .map((part) => String(part.text))
          .join(""),
      );

  return {
    client: fake.client,
    view(): OpenCodeVendorView {
      return {
        sessions: [...sessions.values()].map((session) => ({
          id: session.id,
          title: session.title,
          prompts: textsOf(session, "user"),
          replies: textsOf(session, "assistant").filter(Boolean),
        })),
        deleted: [...deleted],
        aborted: [...aborted],
      };
    },
  };
}
