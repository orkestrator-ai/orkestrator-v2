import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { DesignSessionLink } from "@orkestrator/protocol/design-operations";
import { DesignService } from "./service.js";
import { isDesignError } from "./errors.js";
import type { DesignNativeSessionLookup, DesignSessionResumer } from "./session-links.js";
import {
  createDesignHarness,
  createTestRenderer,
  deferred,
  trackUnhandledRejections,
  type DesignHarness,
} from "./test-support.js";

describe("design session links: recorded identities and resume", () => {
  let harness: DesignHarness;
  const rejections = trackUnhandledRejections();
  const service = () => harness.service;

  beforeEach(async () => {
    rejections.install();
    harness = await createDesignHarness({ prefix: "ork-design-links-" });
  });
  afterEach(async () => {
    await harness.close();
    rejections.remove();
    expect(rejections.seen).toEqual([]);
    rejections.seen.length = 0;
  });

  const setup = async () => (await service().create("env-1", "Links", undefined, "user")).id;
  const workspace = async (canvasId: string) => {
    const snapshot = await service().snapshot("env-1", canvasId);
    if (snapshot.kind !== "snapshot") throw new Error(`unexpected ${snapshot.kind}`);
    return snapshot.workspace;
  };
  const failureCode = (promise: Promise<unknown>) =>
    promise.then(
      () => undefined,
      (error: unknown) => (isDesignError(error) ? error.failure.code : String(error)),
    );
  /** Native-session mappings by tab, as the backend's storage would hold them. */
  const lookupFrom =
    (byTab: Record<string, string>): DesignNativeSessionLookup =>
    async (link: DesignSessionLink) =>
      byTab[link.tabId] ? { providerSessionId: byTab[link.tabId]! } : null;

  /** A provider that reopens `sessionId` as a fresh live session, like Codex. */
  const fakeResumer = (lost: ReadonlySet<string> = new Set()) => {
    const mappings = new Map<string, string>();
    let minted = 0;
    const resume = mock(async (link: DesignSessionLink, tabId: string) => {
      await Bun.sleep(5);
      if (!link.sessionId || lost.has(link.sessionId))
        throw new Error("Native agent provider session was not found");
      const live = `live-${++minted}`;
      mappings.set(tabId, live);
      return live;
    });
    const resumer: DesignSessionResumer = {
      resume,
      mapped: async (_link, tabId) => mappings.get(tabId) ?? null,
    };
    return { resumer, resume, mappings };
  };

  test("reports which links' tabs are mapped without writing anything", async () => {
    const canvasId = await setup();
    const started = await service().linkSession("env-1", canvasId, {
      tabId: "design-chat-1",
      platform: "claude",
      role: "design",
    });
    const unsent = await service().linkSession("env-1", canvasId, {
      tabId: "design-chat-2",
      platform: "codex",
      role: "implementation",
    });
    const before = (await workspace(canvasId)).statusVersion;

    const report = await service().sessionLinkStates(
      "env-1",
      canvasId,
      lookupFrom({ "design-chat-1": "provider-1" }),
    );
    expect(report.states).toEqual([
      { linkId: started.id, session: "retained" },
      { linkId: unsent.id, session: "missing" },
    ]);
    // A link only ever stores the association, and a check never commits.
    expect(report.sessions.map((link) => link.sessionId)).toEqual([undefined, undefined]);
    expect((await workspace(canvasId)).statusVersion).toBe(before);
    expect(Object.keys(report.sessions[0]!).sort()).toEqual(
      ["createdAt", "id", "platform", "role", "tabId"].sort(),
    );
  });

  test("a resume reopens the session once and moves the link, even when two clients resume together", async () => {
    const canvasId = await setup();
    const link = await service().linkSession("env-1", canvasId, {
      tabId: "design-chat-1",
      sessionId: "thread-1",
      platform: "codex",
      role: "design",
    });
    const before = (await workspace(canvasId)).statusVersion;
    const { resumer, resume } = fakeResumer();
    const input = { linkId: link.id, expectedTabId: "design-chat-1", tabId: "design-resume-a" };

    const [first, second] = await Promise.all([
      service().resumeSessionLink("env-1", canvasId, input, resumer),
      service().resumeSessionLink("env-1", canvasId, input, resumer),
    ]);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      link: { id: link.id, tabId: "design-resume-a", sessionId: "thread-1" },
      providerSessionId: "live-1",
    });
    // One provider resume: the second caller got the first one's session.
    expect(resume).toHaveBeenCalledTimes(1);
    const after = await workspace(canvasId);
    expect(after.sessions).toHaveLength(1);
    expect(after.statusVersion).toBe(before + 1);
  });

  test("a conversation the provider lost is reported and the link stays put", async () => {
    const canvasId = await setup();
    const link = await service().linkSession("env-1", canvasId, {
      tabId: "design-chat-1",
      sessionId: "thread-gone",
      platform: "codex",
      role: "design",
    });
    const before = await workspace(canvasId);
    const { resumer } = fakeResumer(new Set(["thread-gone"]));
    expect(
      await failureCode(
        service().resumeSessionLink(
          "env-1",
          canvasId,
          { linkId: link.id, expectedTabId: "design-chat-1", tabId: "design-resume-a" },
          resumer,
        ),
      ),
    ).toBe("not-found");
    const after = await workspace(canvasId);
    expect(after.sessions[0]?.tabId).toBe("design-chat-1");
    expect(after.statusVersion).toBe(before.statusVersion);
  });

  test("refuses a stale, unknown or session-less resume", async () => {
    const canvasId = await setup();
    const link = await service().linkSession("env-1", canvasId, {
      tabId: "design-chat-1",
      sessionId: "provider-1",
      platform: "claude",
      role: "design",
    });
    const { resumer } = fakeResumer();
    await service().resumeSessionLink(
      "env-1",
      canvasId,
      { linkId: link.id, expectedTabId: "design-chat-1", tabId: "design-resume-a" },
      resumer,
    );
    // Another client resumed it into a different tab since this one read it.
    expect(
      await failureCode(
        service().resumeSessionLink(
          "env-1",
          canvasId,
          { linkId: link.id, expectedTabId: "design-chat-1", tabId: "design-resume-b" },
          resumer,
        ),
      ),
    ).toBe("conflict");
    expect(
      await failureCode(
        service().resumeSessionLink(
          "env-1",
          canvasId,
          { linkId: "missing", expectedTabId: "design-chat-1", tabId: "design-resume-b" },
          resumer,
        ),
      ),
    ).toBe("not-found");
    const unsent = await service().linkSession("env-1", canvasId, {
      tabId: "design-chat-2",
      platform: "claude",
      role: "design",
    });
    expect(
      await failureCode(
        service().resumeSessionLink(
          "env-1",
          canvasId,
          { linkId: unsent.id, expectedTabId: "design-chat-2", tabId: "design-resume-c" },
          resumer,
        ),
      ),
    ).toBe("invalid-input");
    // Another environment cannot read or move this canvas's links.
    expect(await failureCode(service().sessionLinkStates("env-2", canvasId, lookupFrom({})))).toBe(
      "not-found",
    );
  });

  test("a closing tab's session is recorded once, only on its own environment's links", async () => {
    const canvasId = await setup();
    const elsewhere = (await service().create("env-2", "Elsewhere", undefined, "user")).id;
    const link = await service().linkSession("env-1", canvasId, {
      tabId: "design-chat-1",
      platform: "claude",
      role: "design",
    });
    await service().linkSession("env-2", elsewhere, {
      tabId: "design-chat-1",
      platform: "claude",
      role: "design",
    });
    const close = {
      environmentId: "env-1",
      tabId: "design-chat-1",
      platform: "claude",
      providerSessionId: "provider-1",
    };
    expect(await service().recordTabSession(close)).toBe(1);
    expect(await service().recordTabSession(close)).toBe(0);
    // A different agent's tab with the same id is not this link's conversation.
    expect(await service().recordTabSession({ ...close, platform: "codex" })).toBe(0);
    expect((await workspace(canvasId)).sessions).toEqual([
      expect.objectContaining({ id: link.id, sessionId: "provider-1" }),
    ]);
    const other = await service().snapshot("env-2", elsewhere);
    if (other.kind !== "snapshot") throw new Error(other.kind);
    expect(other.workspace.sessions[0]?.sessionId).toBeUndefined();
  });
  test("a blocked provider leaves canvas reads and edits available and preserves those edits", async () => {
    const canvasId = await setup();
    const link = await service().linkSession("env-1", canvasId, {
      tabId: "old",
      sessionId: "thread-1",
      platform: "codex",
      role: "design",
    });
    const started = deferred();
    const release = deferred();
    const { resumer } = fakeResumer();
    resumer.resume = async () => {
      started.resolve();
      await release.promise;
      return "live";
    };
    const attempt = service().resumeSessionLink(
      "env-1",
      canvasId,
      {
        linkId: link.id,
        expectedTabId: "old",
        tabId: "new",
      },
      resumer,
    );
    try {
      await started.promise;
      await service().sessionLinkStates("env-1", canvasId, lookupFrom({}));
      await service().linkSession("env-1", canvasId, {
        tabId: "another",
        platform: "claude",
        role: "design",
      });
    } finally {
      release.resolve();
    }
    await attempt;
    expect((await workspace(canvasId)).sessions.map((link) => link.tabId)).toEqual([
      "new",
      "another",
    ]);
  });

  test.each([undefined, "thread-1"])(
    "retained mappings are adopted without moving or resuming (identity %s)",
    async (sessionId) => {
      const canvasId = await setup();
      const link = await service().linkSession("env-1", canvasId, {
        tabId: "in-use",
        sessionId,
        platform: "codex",
        role: "design",
      });
      const { resumer, resume, mappings } = fakeResumer();
      mappings.set("in-use", "live-existing");
      expect(
        await failureCode(
          service().resumeSessionLink(
            "env-1",
            canvasId,
            {
              linkId: link.id,
              expectedTabId: "in-use",
              tabId: "second-tab",
            },
            resumer,
          ),
        ),
      ).toBe("conflict");
      const result = await service().resumeSessionLink(
        "env-1",
        canvasId,
        {
          linkId: link.id,
          expectedTabId: "in-use",
          tabId: "in-use",
        },
        resumer,
      );
      expect(result).toMatchObject({
        link: { tabId: "in-use" },
        providerSessionId: "live-existing",
      });
      expect(resume).not.toHaveBeenCalled();
    },
  );

  test("records a peer-created canvas absent from an initialized service's index", async () => {
    await service().initialize();
    const peer = new DesignService(harness.dir, () => undefined, createTestRenderer());
    try {
      const canvas = await peer.create("env-1", "Peer", undefined, "user");
      await peer.linkSession("env-1", canvas.id, {
        tabId: "peer-tab",
        platform: "claude",
        role: "design",
      });
      expect(
        await service().recordTabSession({
          environmentId: "env-1",
          tabId: "peer-tab",
          platform: "codex",
          providerSessionId: "peer-thread",
        }),
      ).toBe(1);
      expect((await workspace(canvas.id)).sessions[0]).toMatchObject({
        platform: "codex",
        sessionId: "peer-thread",
      });
    } finally {
      await peer.close();
    }
  });

  test("records a deleted canvas before restore and resume", async () => {
    const canvasId = await setup();
    const link = await service().linkSession("env-1", canvasId, {
      tabId: "deleted-tab",
      platform: "claude",
      role: "design",
    });
    await service().delete(canvasId, "env-1", "user");
    expect(
      await service().recordTabSession({
        environmentId: "env-1",
        tabId: "deleted-tab",
        platform: "codex",
        providerSessionId: "thread-kept",
      }),
    ).toBe(1);
    await service().runOnce("env-1", "user", {
      canvasId,
      input: { kind: "restore_canvas" },
      preconditions: {},
    });
    const { resumer } = fakeResumer();
    expect(
      await service().resumeSessionLink(
        "env-1",
        canvasId,
        { linkId: link.id, expectedTabId: "deleted-tab", tabId: "restored-tab" },
        resumer,
      ),
    ).toMatchObject({
      link: { platform: "codex", sessionId: "thread-kept", tabId: "restored-tab" },
    });
  });

  test("one unreadable canvas does not prevent recording the remaining links", async () => {
    const bad = await setup();
    const good = await setup();
    for (const id of [bad, good])
      await service().linkSession("env-1", id, {
        tabId: "shared-tab",
        platform: "codex",
        role: "design",
      });
    const original = service().loadFor.bind(service());
    const read = spyOn(service(), "loadFor").mockImplementation(async (...args) => {
      if (args[0] === bad) throw new Error("unreadable");
      return original(...args);
    });
    try {
      expect(
        await service().recordTabSession({
          environmentId: "env-1",
          tabId: "shared-tab",
          platform: "codex",
          providerSessionId: "thread-good",
        }),
      ).toBe(1);
    } finally {
      read.mockRestore();
    }
    expect((await workspace(good)).sessions[0]?.sessionId).toBe("thread-good");
  });

  test("an existing identity cannot be replaced by another identity or provider", async () => {
    const canvasId = await setup();
    await service().linkSession("env-1", canvasId, {
      tabId: "verified",
      sessionId: "thread-verified",
      platform: "codex",
      role: "design",
    });
    expect(
      await service().recordTabSession({
        environmentId: "env-1",
        tabId: "verified",
        platform: "claude",
        providerSessionId: "unverified",
      }),
    ).toBe(0);
    expect((await workspace(canvasId)).sessions[0]).toMatchObject({
      platform: "codex",
      sessionId: "thread-verified",
    });
  });
});
