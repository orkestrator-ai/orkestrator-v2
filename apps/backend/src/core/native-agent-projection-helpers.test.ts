/**
 * The projection's pure helpers, through their own module. The projection
 * module re-exports the four that existing importers use, so those must stay
 * the same functions.
 */
import { describe, expect, test } from "bun:test";
import * as helpers from "./native-agent-projection-helpers.js";
import * as projection from "./native-agent-transcript-projection.js";

describe("native agent projection helpers", () => {
  test("the projection module re-exports the shared helpers unchanged", () => {
    expect(projection.attachProgressToToolRows).toBe(helpers.attachProgressToToolRows);
    expect(projection.mergeContextUsageTurns).toBe(helpers.mergeContextUsageTurns);
    expect(projection.mergeNativeAgentQueueItems).toBe(helpers.mergeNativeAgentQueueItems);
    expect(projection.withProviderContextWindow).toBe(helpers.withProviderContextWindow);
  });

  test("a title names the first user message only when the read reaches the start", () => {
    const messages = [
      { role: "assistant", content: "hello" },
      { role: "user", content: "Fix the login bug" },
    ];
    expect(helpers.firstUserMessageOf(messages, undefined)).toEqual({
      firstUserMessage: "Fix the login bug",
      reachesStart: true,
    });
    expect(
      helpers.firstUserMessageOf(messages, { truncated: true, omittedMessages: 3 }).reachesStart,
    ).toBe(false);
  });

  test("a title never comes from a row a provider bound may have cut the head off", () => {
    // What a bridge's bound leaves of an oversized first prompt: the tail of
    // its annotation envelope, without the opening fence.
    const trimmed = {
      id: "user-1",
      role: "user",
      content: '"userComment":null}]\n</orkestrator_transcript_annotations>',
    };
    expect(helpers.firstUserMessageOf([trimmed], undefined).firstUserMessage).toBe(trimmed.content);
    expect(helpers.firstUserMessageOf([trimmed], undefined, "user-1")).toEqual({
      reachesStart: true,
    });
    // A later user message still names the session.
    expect(
      helpers.firstUserMessageOf(
        [trimmed, { id: "user-2", role: "user", content: "Fix the login bug" }],
        undefined,
        "user-1",
      ).firstUserMessage,
    ).toBe("Fix the login bug");
  });

  test("a title never comes from a goal carrier", () => {
    const carrier = '<orkestrator-goal version="1">\n<orkestrator-goal-payload-json>\n{}';
    expect(
      helpers.firstUserMessageOf(
        [
          { role: "user", content: carrier },
          { role: "user", content: "Fix the login bug" },
        ],
        undefined,
      ).firstUserMessage,
    ).toBe("Fix the login bug");
    expect(helpers.firstUserMessageOf([{ role: "user", content: carrier }], undefined)).toEqual({
      reachesStart: true,
    });
    // Carrier-like text in the middle is still the user's own message.
    const quoted = `Why does ${carrier} show up here?`;
    expect(
      helpers.firstUserMessageOf([{ role: "user", content: quoted }], undefined).firstUserMessage,
    ).toBe(quoted);
  });

  test("provider-reported image paths come from images and successful reads only", () => {
    expect(helpers.providerReportedImagePath({ type: "image", fileUrl: "file:///tmp/a.png" })).toBe(
      "/tmp/a.png",
    );
    expect(
      helpers.providerReportedImagePath({
        type: "tool-invocation",
        toolName: "Read",
        toolState: "success",
        toolArgs: { file_path: "/tmp/b.jpg" },
      }),
    ).toBe("/tmp/b.jpg");
    expect(
      helpers.providerReportedImagePath({
        type: "tool-invocation",
        toolName: "Read",
        toolState: "error",
        toolArgs: { file_path: "/tmp/b.jpg" },
      }),
    ).toBeUndefined();
    expect(helpers.providerReportedImagePath({ type: "image", fileUrl: "relative.png" })).toBe(
      undefined,
    );
    expect(helpers.imageMimeType("/tmp/b.JPG")).toBe("image/jpeg");
    expect(helpers.imageMimeType("/tmp/unknown.xyz")).toBe("image/png");
  });

  test("visible notices drop errors and stops and append the owned notices", () => {
    const notices = helpers.visibleProjectionNotices(
      "codex",
      [
        { kind: "error", message: "boom" },
        { kind: "stopped", message: "stopped" },
        { kind: "warning", message: "kept" },
      ] as never,
      { kind: "failed" } as never,
    );
    expect(notices.map((notice) => notice.kind)).toEqual(["warning", "incomplete-turn"]);
  });

  test("a new session's model substitution is a notice while it is news", () => {
    const createdAt = "2026-11-09T10:00:00.000Z";
    const created = Date.parse(createdAt);
    const substitution = {
      requestedModelId: "opencode-go/beam-free",
      modelId: "opencode/beam-free",
      message: "beam-free isn't available in OpenCode 2 with your sign-ins; using Beam Free.",
    };
    const session = {
      createdAt,
      controls: { modelId: "opencode/beam-free" },
      modelSubstitutionNotice: substitution,
    };
    const notice = helpers.sessionModelSubstitutionNotice(session, created + 1_000);
    expect(notice).toEqual({
      kind: "advisory",
      severity: "info",
      message: substitution.message,
      occurrenceId: `model-substitution:${createdAt}`,
    });
    expect(
      helpers
        .visibleProjectionNotices("opencode", [], undefined, undefined, notice)
        .map((entry) => entry.message),
    ).toEqual([substitution.message]);
    // Old news, a later pick of another model, or no substitution: nothing.
    expect(
      helpers.sessionModelSubstitutionNotice(
        session,
        created + helpers.MODEL_SUBSTITUTION_NOTICE_MS,
      ),
    ).toBeUndefined();
    expect(
      helpers.sessionModelSubstitutionNotice(
        { ...session, controls: { modelId: "opencode/other" } },
        created + 1_000,
      ),
    ).toBeUndefined();
    expect(
      helpers.sessionModelSubstitutionNotice({ createdAt, controls: session.controls }, created),
    ).toBeUndefined();
    expect(
      helpers.sessionModelSubstitutionNotice(
        { ...session, modelSubstitutionNotice: { modelId: "opencode/beam-free" } as never },
        created,
      ),
    ).toBeUndefined();
  });

  test("interaction kinds keep known kinds once and distinguish empty from absent", () => {
    expect(helpers.normalizeInteractionKinds(undefined)).toBeUndefined();
    expect(helpers.normalizeInteractionKinds([])).toEqual([]);
    expect(helpers.normalizeInteractionKinds(["question", "question", "bogus"])).toEqual([
      "question",
    ]);
  });

  test("progressive messages must all be normalized rows", () => {
    const row = { id: "m1", role: "user", content: "hi", parts: [], createdAt: "now" };
    expect(helpers.normalizedProgressiveMessages([row])).toEqual([row]);
    expect(helpers.normalizedProgressiveMessages([row, { id: "m2" }])).toBeNull();
    expect(helpers.normalizedProgressiveMessages("not a list")).toBeNull();
  });

  test("discovery and model keys ignore drift counts and answer order", () => {
    expect(
      helpers.discoveryAnnouncementKey({ drift: { unknownEvents: 1, unknownKinds: ["b", "a"] } }),
    ).toBe(
      helpers.discoveryAnnouncementKey({ drift: { unknownEvents: 9, unknownKinds: ["a", "b"] } }),
    );
    const first = { id: "a", platform: "codex" };
    const second = { id: "b", platform: "claude" };
    expect(helpers.modelCatalogKey([first, second] as never)).toBe(
      helpers.modelCatalogKey([second, first] as never),
    );
  });
});
