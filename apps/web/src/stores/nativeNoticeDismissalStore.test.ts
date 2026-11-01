import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ClientStateCapabilities } from "@orkestrator/protocol/client-state";
import { NOTICE_DISMISSAL_LIMITS } from "@orkestrator/protocol/notice-dismissals";
import type { NoticeDismissalSession } from "@orkestrator/protocol/notice-dismissals";
import { resetClientStateCapabilitiesForTests } from "@/lib/client-state-capabilities";
import { invoke as nativeInvoke } from "@/lib/native/backend";
import { dispatchResourceChange } from "@/lib/resource-sync";
import {
  LEGACY_NOTICE_DISMISSAL_KEY,
  useNativeNoticeDismissalStore as store,
} from "./nativeNoticeDismissalStore";

const invokeMock = nativeInvoke as unknown as ReturnType<typeof mock>;
const key = LEGACY_NOTICE_DISMISSAL_KEY;

const capabilities = (noticeDismissals: boolean): ClientStateCapabilities => ({
  coordinatorPaneLayouts: false,
  coordinatorUpstreamMerge: false,
  noticeDismissals,
  environmentAttention: false,
});

async function flushPromises() {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

/** Resource hints are coalesced for a short window before delivery. */
const hintDelivered = () => new Promise((resolve) => setTimeout(resolve, 70));

function fakeBackend() {
  const server = { revision: 0, sessions: [] as NoticeDismissalSession[] };
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  invokeMock.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    calls.push({ command, args });
    if (command === "list_notice_dismissals") return { ...server };
    if (command === "dismiss_notices") {
      for (const session of args.sessions as NoticeDismissalSession[]) {
        const existing = server.sessions.find(
          (item) => item.sessionIdentity === session.sessionIdentity,
        );
        if (existing) {
          existing.occurrenceIds = [
            ...new Set([...existing.occurrenceIds, ...session.occurrenceIds]),
          ];
        } else {
          server.sessions.push({ ...session });
        }
      }
      server.revision += 1;
      return { ...server };
    }
    if (command === "reconcile_notice_dismissals") {
      const active = new Set(args.activeOccurrenceIds as string[]);
      server.sessions = server.sessions
        .map((item) =>
          item.sessionIdentity === args.sessionIdentity
            ? { ...item, occurrenceIds: item.occurrenceIds.filter((id) => active.has(id)) }
            : item,
        )
        .filter((item) => item.occurrenceIds.length > 0);
      server.revision += 1;
      return { ...server };
    }
    return undefined;
  });
  return { server, calls };
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(() => Promise.resolve());
  store.getState().clear();
});

afterEach(() => {
  store.getState().clear();
  resetClientStateCapabilitiesForTests();
  invokeMock.mockImplementation(() => Promise.resolve());
});

describe("against a backend that owns dismissals", () => {
  beforeEach(() => resetClientStateCapabilitiesForTests(capabilities(true)));

  test("a dismissal is applied at once and saved; other clients' changes arrive by hint", async () => {
    const { server, calls } = fakeBackend();
    await store.getState().ensureHydrated();
    store.getState().dismiss("s", "n1");
    expect(store.getState().sessions).toEqual([{ sessionIdentity: "s", occurrenceIds: ["n1"] }]);
    await flushPromises();
    expect(calls.some((call) => call.command === "dismiss_notices")).toBe(true);
    expect(server.sessions).toEqual([{ sessionIdentity: "s", occurrenceIds: ["n1"] }]);
    expect(localStorage.getItem(key)).toBeNull();

    server.sessions = [{ sessionIdentity: "s", occurrenceIds: ["n1", "from-elsewhere"] }];
    server.revision += 1;
    dispatchResourceChange({ resource: "notice-dismissal", id: "notice-dismissals", revision: 9 });
    await hintDelivered();
    expect(store.getState().sessions).toEqual(server.sessions);
  });

  test("reconcile retires recovered dismissals on the backend, and no-ops send nothing", async () => {
    const { server, calls } = fakeBackend();
    server.sessions = [{ sessionIdentity: "s", occurrenceIds: ["active", "recovered"] }];
    server.revision = 1;
    await store.getState().ensureHydrated();

    store.getState().reconcile("s", ["active", "recovered"]);
    store.getState().reconcile("unknown", []);
    await flushPromises();
    expect(calls.some((call) => call.command === "reconcile_notice_dismissals")).toBe(false);

    store.getState().reconcile("s", ["active"]);
    await flushPromises();
    expect(server.sessions).toEqual([{ sessionIdentity: "s", occurrenceIds: ["active"] }]);
    expect(store.getState().sessions).toEqual(server.sessions);
  });

  test("a write answer overtaken by another client's change is replaced by a fresh read", async () => {
    const { server } = fakeBackend();
    await store.getState().ensureHydrated();
    const base = invokeMock.getMockImplementation()!;
    let releaseWrite: () => void = () => undefined;
    invokeMock.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command !== "dismiss_notices") return base(command, args);
      const answer = (await base(command, args)) as { revision: number };
      await new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      return answer;
    });
    store.getState().dismiss("s", "mine");
    await flushPromises();

    server.sessions = [
      { sessionIdentity: "s", occurrenceIds: ["mine"] },
      { sessionIdentity: "t", occurrenceIds: ["theirs"] },
    ];
    server.revision += 1;
    dispatchResourceChange({ resource: "notice-dismissal", id: "notice-dismissals", revision: 2 });
    await hintDelivered();

    releaseWrite();
    await flushPromises();
    expect(store.getState().sessions).toEqual(server.sessions);
  });

  test("imports the browser copy once and deletes it", async () => {
    const { server } = fakeBackend();
    localStorage.setItem(
      key,
      JSON.stringify({
        state: { sessions: [{ sessionIdentity: "old", occurrenceIds: ["n"] }] },
        version: 0,
      }),
    );
    expect(store.getState().sessions).toEqual([]);
    await store.getState().ensureHydrated();
    expect(server.sessions).toEqual([{ sessionIdentity: "old", occurrenceIds: ["n"] }]);
    expect(store.getState().sessions).toEqual(server.sessions);
    expect(localStorage.getItem(key)).toBeNull();
  });

  test("a dismissal made while the backend was unknown travels with the import", async () => {
    const { server } = fakeBackend();
    store.getState().dismiss("early", "n");
    await store.getState().ensureHydrated();
    expect(server.sessions).toEqual([{ sessionIdentity: "early", occurrenceIds: ["n"] }]);
    expect(localStorage.getItem(key)).toBeNull();
  });

  test("a failed read still releases notices, and the browser copy survives for a retry", async () => {
    invokeMock.mockImplementation(async () => {
      throw new Error("transport closed");
    });
    localStorage.setItem(
      key,
      JSON.stringify({
        state: { sessions: [{ sessionIdentity: "old", occurrenceIds: ["n"] }] },
        version: 0,
      }),
    );
    await store.getState().ensureHydrated();
    expect(store.getState().ready).toBe(true);
    expect(localStorage.getItem(key)).not.toBeNull();
  });
});

describe("against an older backend", () => {
  beforeEach(() => resetClientStateCapabilitiesForTests(capabilities(false)));

  test("keeps dismissals in the browser copy and reads them back", async () => {
    await store.getState().ensureHydrated();
    store.getState().dismiss("codex/session-a", "occurrence-1");
    const persisted = localStorage.getItem(key);
    expect(persisted).not.toBeNull();
    expect(invokeMock).not.toHaveBeenCalledWith("dismiss_notices", expect.anything());

    store.getState().clear();
    localStorage.setItem(key, persisted!);
    await store.getState().ensureHydrated();
    expect(store.getState().sessions).toEqual([
      { sessionIdentity: "codex/session-a", occurrenceIds: ["occurrence-1"] },
    ]);
  });

  test("keeps dismissals for active conditions and retires recovered ones", async () => {
    await store.getState().ensureHydrated();
    const state = store.getState();
    state.dismiss("codex/session-a", "mcp:t1:github");
    state.dismiss("codex/session-a", "mcp:t1:docs");
    state.dismiss("codex/session-b", "mcp:t2:github");

    store.getState().reconcile("codex/session-a", ["mcp:t1:github"]);
    expect(store.getState().sessions).toEqual([
      { sessionIdentity: "codex/session-b", occurrenceIds: ["mcp:t2:github"] },
      { sessionIdentity: "codex/session-a", occurrenceIds: ["mcp:t1:github"] },
    ]);

    store.getState().reconcile("codex/session-a", []);
    expect(store.getState().sessions).toEqual([
      { sessionIdentity: "codex/session-b", occurrenceIds: ["mcp:t2:github"] },
    ]);
  });
});

test("occurrence and session retention stay bounded in memory", () => {
  const sessionCount = NOTICE_DISMISSAL_LIMITS.sessions + 5;
  for (let session = 0; session < sessionCount; session += 1) {
    store.getState().dismiss(`session-${session}`, "occurrence");
  }
  for (let occurrence = 0; occurrence < 25; occurrence += 1) {
    store.getState().dismiss("latest", `occurrence-${occurrence}`);
  }
  const sessions = store.getState().sessions;
  expect(sessions).toHaveLength(NOTICE_DISMISSAL_LIMITS.sessions);
  expect(sessions.at(-1)?.occurrenceIds).toHaveLength(
    NOTICE_DISMISSAL_LIMITS.occurrencesPerSession,
  );
  expect(sessions.at(-1)?.occurrenceIds[0]).toBe("occurrence-5");
});
