import { describe, expect, mock, test } from "bun:test";
import type {
  DesignSessionLink,
  DesignSessionResumeResult,
} from "@orkestrator/protocol/design-operations";
import type { CreatableTabType, CreateTabOptions } from "@/contexts/TerminalContext";
import { DesignClientError } from "@/lib/design-client";
import {
  createDesignLinkResumer,
  designLinkCheckFailure,
  designLinkStatus,
  designResumeTabId,
  resumeDesignLink,
  type DesignLinkCheck,
} from "./design-session-links";

const TAB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

function link(overrides: Partial<DesignSessionLink> = {}): DesignSessionLink {
  return {
    id: "link-1",
    tabId: "design-chat-1-1",
    platform: "claude",
    role: "design",
    createdAt: "2026-10-24T00:00:00Z",
    ...overrides,
  };
}

const ready = (session: "retained" | "missing"): DesignLinkCheck => ({
  kind: "ready",
  states: new Map([["link-1", session]]),
});

describe("designLinkStatus", () => {
  const base = { hydrated: true, tabOpen: false, canResume: true };

  test("an open tab is open whatever the backend says", () => {
    expect(designLinkStatus(link(), { ...base, tabOpen: true, check: ready("missing") })).toBe(
      "open",
    );
    expect(designLinkStatus(link(), { ...base, hydrated: false, check: ready("retained") })).toBe(
      "checking",
    );
  });

  test("a closed tab follows the backend's retained mapping", () => {
    expect(designLinkStatus(link(), { ...base, check: { kind: "pending" } })).toBe("checking");
    expect(designLinkStatus(link(), { ...base, check: ready("retained") })).toBe("retained");
    expect(designLinkStatus(link(), { ...base, check: ready("missing") })).toBe("missing");
    expect(
      designLinkStatus(link({ sessionId: "s-1" }), { ...base, check: ready("retained") }),
    ).toBe("retained");
    // A recorded identity is enough: the resumed tab refuses a lost session itself.
    expect(designLinkStatus(link({ sessionId: "s-1" }), { ...base, check: ready("missing") })).toBe(
      "resumable",
    );
  });

  test("a disconnected backend is unavailable, never a guess", () => {
    const failed = designLinkCheckFailure(new Error("Failed to fetch"));
    expect(failed.kind).toBe("failed");
    expect(designLinkStatus(link({ sessionId: "s-1" }), { ...base, check: failed })).toBe(
      "unavailable",
    );
  });

  test("an older backend or an agent without resume reads as closed", () => {
    const unsupported = designLinkCheckFailure(new Error("Unknown backend command: x"));
    expect(unsupported).toEqual({ kind: "unsupported" });
    expect(designLinkStatus(link(), { ...base, check: unsupported })).toBe("closed");
    expect(designLinkStatus(link({ sessionId: "s-1" }), { ...base, check: unsupported })).toBe(
      "closed",
    );
    expect(
      designLinkStatus(link({ sessionId: "s-1" }), {
        ...base,
        canResume: false,
        check: ready("retained"),
      }),
    ).toBe("closed");
    expect(
      designLinkCheckFailure(
        new DesignClientError({ code: "not-found", message: "gone", retry: "never" }),
      ),
    ).toEqual({ kind: "failed", message: "gone" });
  });
});

describe("designResumeTabId", () => {
  test("is a valid tab id derived only from the link", () => {
    const id = designResumeTabId(link());
    expect(id).toMatch(TAB_ID_PATTERN);
    expect(designResumeTabId(link())).toBe(id);
    // A second resume after the resumed tab closes gets a fresh tab.
    expect(designResumeTabId(link({ tabId: id }))).not.toBe(id);
  });
});

/**
 * A backend that serializes resumes per canvas, like the design lane: the
 * first resume reopens the session (minting a live id, as Codex does) and
 * moves the link; a repeat for the same tab returns what is already mapped.
 */
function fakeBackend(initial: DesignSessionLink) {
  let current = { ...initial };
  let tail = Promise.resolve();
  let moves = 0;
  const live = new Map<string, string>();
  const claim = mock(
    (input: { linkId: string; expectedTabId: string; tabId: string }) =>
      new Promise<DesignSessionResumeResult>((resolve, reject) => {
        tail = tail.then(async () => {
          await Promise.resolve();
          if (current.tabId === input.tabId)
            return resolve({ link: { ...current }, providerSessionId: live.get(input.tabId)! });
          if (current.tabId !== input.expectedTabId) return reject(new Error("conflict"));
          current = { ...current, tabId: input.tabId };
          moves++;
          live.set(input.tabId, `live-${moves}`);
          resolve({ link: { ...current }, providerSessionId: `live-${moves}` });
        });
      }),
  );
  return { claim, current: () => current, moves: () => moves };
}

/** One client's pane layout. */
function fakeClient() {
  const tabs = new Set<string>();
  const createTab = mock((_type: CreatableTabType, options: CreateTabOptions) => {
    tabs.add(options.tabId!);
    return true;
  });
  const focus = mock((tabId: string) => tabs.has(tabId));
  return { tabs, createTab, focus, hasTab: (tabId: string) => tabs.has(tabId) };
}

describe("resumeDesignLink", () => {
  const resumable = link({ sessionId: "provider-session-1", label: "Design chat" });

  test("moves the link, then reopens the session without an initial prompt", async () => {
    const backend = fakeBackend(resumable);
    const client = fakeClient();
    const order: string[] = [];
    backend.claim.mockImplementationOnce(async (input) => {
      order.push("claim");
      return { link: { ...resumable, tabId: input.tabId }, providerSessionId: "live-codex-1" };
    });
    client.createTab.mockImplementationOnce((_type, options) => {
      order.push("create");
      client.tabs.add(options.tabId!);
      return true;
    });
    const result = await resumeDesignLink({
      environmentId: "env-1",
      canvasId: "canvas-1",
      link: resumable,
      ...client,
      claim: backend.claim,
    });

    expect(order).toEqual(["claim", "create"]);
    expect(result).toMatchObject({ tabId: designResumeTabId(resumable), created: true });
    const [type, options] = client.createTab.mock.calls[0]!;
    expect(type).toBe("claude");
    expect(options).toEqual({
      tabId: designResumeTabId(resumable),
      agentLaunchMode: "native",
      displayTitle: "Design chat",
      // The live session the backend resumed, not the recorded identity.
      resumeSessionId: "live-codex-1",
      requireExistingResumeSession: true,
    });
    expect(options.initialPrompt).toBeUndefined();
    expect(client.focus).toHaveBeenCalledWith(designResumeTabId(resumable));
  });

  test("two clicks in one client share one attempt", async () => {
    const backend = fakeBackend(resumable);
    const client = fakeClient();
    const input = {
      environmentId: "env-1",
      canvasId: "canvas-1",
      link: resumable,
      ...client,
      claim: backend.claim,
    };
    const [first, second] = await Promise.all([resumeDesignLink(input), resumeDesignLink(input)]);
    expect(first).toBe(second);
    expect(backend.claim).toHaveBeenCalledTimes(1);
    expect(client.createTab).toHaveBeenCalledTimes(1);
  });

  test("two clients resuming at once reuse one association and dispatch nothing", async () => {
    const backend = fakeBackend(resumable);
    const clients = [fakeClient(), fakeClient()];
    const results = await Promise.all(
      clients.map((client) =>
        // Each client is its own renderer, with its own in-flight table.
        createDesignLinkResumer()({
          environmentId: "env-1",
          canvasId: "canvas-1",
          link: resumable,
          ...client,
          claim: backend.claim,
        }),
      ),
    );

    const tabId = designResumeTabId(resumable);
    expect(results.map((result) => result.tabId)).toEqual([tabId, tabId]);
    expect(results.map((result) => result.link)).toEqual([backend.current(), backend.current()]);
    // The session was resumed and the link moved once; the second claim found both done.
    expect(backend.claim).toHaveBeenCalledTimes(2);
    expect(backend.moves()).toBe(1);
    expect(backend.current()).toMatchObject({ tabId, sessionId: "provider-session-1" });
    for (const client of clients) {
      expect(client.createTab).toHaveBeenCalledTimes(1);
      const options = client.createTab.mock.calls[0]![1];
      // Same tab id, so both map to the one native session for
      // `env-env-1:<tabId>`; neither carries a prompt to dispatch.
      expect(options).toMatchObject({ tabId, resumeSessionId: "live-1" });
      expect(options.initialPrompt).toBeUndefined();
      expect(client.focus).toHaveBeenCalledWith(tabId);
    }
  });

  test("an already open resume tab is focused, not recreated", async () => {
    const backend = fakeBackend(resumable);
    const client = fakeClient();
    client.tabs.add(designResumeTabId(resumable));
    const result = await resumeDesignLink({
      environmentId: "env-1",
      canvasId: "canvas-1",
      link: resumable,
      ...client,
      claim: backend.claim,
    });
    expect(result.created).toBe(false);
    expect(client.createTab).not.toHaveBeenCalled();
    expect(client.focus).toHaveBeenCalledWith(designResumeTabId(resumable));
  });

  test("a link moved elsewhere is refused before any tab opens", async () => {
    const backend = fakeBackend({ ...resumable, tabId: "someone-else" });
    const client = fakeClient();
    await expect(
      resumeDesignLink({
        environmentId: "env-1",
        canvasId: "canvas-1",
        link: resumable,
        ...client,
        claim: backend.claim,
      }),
    ).rejects.toThrow("conflict");
    expect(client.createTab).not.toHaveBeenCalled();
  });

  test("a failed tab creation is recovered by adopting the projected mapping without resuming again", async () => {
    const backend = fakeBackend(resumable);
    const client = fakeClient();
    const resume = createDesignLinkResumer();
    client.createTab.mockImplementationOnce(() => false);
    const input = {
      environmentId: "env-1",
      canvasId: "canvas-1",
      link: resumable,
      ...client,
      claim: backend.claim,
    };
    await expect(resume(input)).rejects.toThrow("Could not reopen");
    const claimedTab = backend.current().tabId;
    await resume({ ...input, link: backend.current(), retainTab: true });
    expect(backend.moves()).toBe(1);
    expect(client.tabs.size).toBe(1);
    expect(client.tabs.has(claimedTab)).toBe(true);
    expect(backend.claim.mock.calls[1]?.[0].tabId).toBe(claimedTab);
  });

  test("refuses an agent it cannot resume and a tab that did not open", async () => {
    const client = fakeClient();
    const claim = mock(async () => ({ link: resumable, providerSessionId: "live-1" }));
    await expect(
      resumeDesignLink({
        environmentId: "env-1",
        canvasId: "canvas-1",
        link: { ...resumable, platform: "opencode" },
        ...client,
        claim,
      }),
    ).rejects.toThrow("cannot be resumed");
    expect(claim).not.toHaveBeenCalled();

    const backend = fakeBackend(resumable);
    const blocked = fakeClient();
    blocked.createTab.mockImplementation(() => false);
    await expect(
      resumeDesignLink({
        environmentId: "env-1",
        canvasId: "canvas-1",
        link: resumable,
        ...blocked,
        claim: backend.claim,
      }),
    ).rejects.toThrow("Could not reopen");
  });
});
