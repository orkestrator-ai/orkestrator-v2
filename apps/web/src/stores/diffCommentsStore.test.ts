import { beforeEach, describe, expect, test } from "bun:test";
import { appCommandStore } from "@/test/app-command-store";
import {
  MAX_DIFF_COMMENT_BODY,
  MAX_DIFF_COMMENT_EXCERPT_LINES,
  MAX_DIFF_COMMENT_LINE_CHARACTERS,
  MAX_DIFF_COMMENTS_PER_ENVIRONMENT,
  diffCommentsStore,
  environmentDiffComments,
  diffCommentFreshness,
  type DiffCommentAnchor,
} from "./diffCommentsStore";

const ENV = "env-1";

function anchor(overrides: Partial<DiffCommentAnchor> = {}): DiffCommentAnchor {
  return {
    source: "live",
    diffIdentityId: "diff-1",
    measurementId: "m-1",
    scope: "environment-net",
    pathId: "p:src/app.ts",
    path: "src/app.ts",
    contentKey: "blob:a|blob:b",
    kind: "line",
    side: "new",
    line: 4,
    hunkHeader: "@@ -1,3 +1,4 @@",
    excerpt: [{ type: "add", text: "const x = 1;", oldLine: null, newLine: 4 }],
    excerptTruncated: false,
    ...overrides,
  };
}

const store = () => appCommandStore(diffCommentsStore);
const env = () => environmentDiffComments(store().getState(), ENV);

beforeEach(() => {
  store().setState({ environments: new Map() });
});

describe("diffCommentsStore", () => {
  test("adds, edits and removes comments, bumping the revision on each edit", () => {
    const id = store().getState().addComment(ENV, anchor(), "  Handle null here.  ");
    expect(id).not.toBeNull();
    expect(env().comments).toHaveLength(1);
    expect(env().comments[0]).toMatchObject({
      body: "Handle null here.",
      revision: 1,
      selected: true,
    });

    store().getState().editComment(ENV, id!, "Handle undefined too.");
    expect(env().comments[0]).toMatchObject({ body: "Handle undefined too.", revision: 2 });
    // The same text is not an edit.
    store().getState().editComment(ENV, id!, "Handle undefined too.");
    expect(env().comments[0]!.revision).toBe(2);
    // A blank edit is ignored rather than erasing the comment.
    store().getState().editComment(ENV, id!, "   ");
    expect(env().comments[0]!.body).toBe("Handle undefined too.");

    store().getState().removeComment(ENV, id!);
    expect(env().comments).toHaveLength(0);
  });

  test("refuses blank comments and bounds bodies, excerpts and the count", () => {
    expect(store().getState().addComment(ENV, anchor(), "   ")).toBeNull();

    const long = "x".repeat(MAX_DIFF_COMMENT_BODY + 50);
    const longLine = "y".repeat(MAX_DIFF_COMMENT_LINE_CHARACTERS + 50);
    const excerpt = Array.from({ length: MAX_DIFF_COMMENT_EXCERPT_LINES + 5 }, (_, index) => ({
      type: "context" as const,
      text: longLine,
      oldLine: index + 1,
      newLine: index + 1,
    }));
    store()
      .getState()
      .addComment(ENV, anchor({ kind: "hunk", line: null, excerpt }), long);
    const [comment] = env().comments;
    expect(comment!.body).toHaveLength(MAX_DIFF_COMMENT_BODY);
    expect(comment!.anchor.excerpt).toHaveLength(MAX_DIFF_COMMENT_EXCERPT_LINES);
    expect(comment!.anchor.excerptTruncated).toBe(true);
    expect(comment!.anchor.excerpt[0]!.text).toHaveLength(MAX_DIFF_COMMENT_LINE_CHARACTERS + 1);

    for (let index = 1; index < MAX_DIFF_COMMENTS_PER_ENVIRONMENT; index++) {
      store().getState().addComment(ENV, anchor(), `comment ${index}`);
    }
    expect(env().comments).toHaveLength(MAX_DIFF_COMMENTS_PER_ENVIRONMENT);
    expect(store().getState().addComment(ENV, anchor(), "one too many")).toBeNull();
  });

  test("keeps environments apart", () => {
    store().getState().addComment(ENV, anchor(), "first");
    store().getState().addComment("env-2", anchor(), "second");
    expect(env().comments.map((comment) => comment.body)).toEqual(["first"]);
    expect(
      environmentDiffComments(store().getState(), "env-2").comments.map((comment) => comment.body),
    ).toEqual(["second"]);
  });

  test("a completed send removes only comments still at the revision it carried", () => {
    const state = () => store().getState();
    const ids = ["one", "two", "three", "four", "five"].map((body) =>
      state().addComment(ENV, anchor(), body)!,
    );
    const items = env().comments.map((comment) => ({ id: comment.id, revision: comment.revision }));
    expect(state().beginSend(ENV, { requestId: "req-1", tabId: "tab-1", items })).toBe(true);
    // Only one send at a time.
    expect(state().beginSend(ENV, { requestId: "req-2", tabId: "tab-1", items })).toBe(false);

    // While the send is in flight: one comment is edited and another is added.
    state().editComment(ENV, ids[2]!, "three, reworded");
    const added = state().addComment(ENV, anchor(), "six");

    expect(state().completeSend(ENV, "req-1")).toEqual({ sent: 5, kept: 1 });
    expect(env().comments.map((comment) => comment.body)).toEqual(["three, reworded", "six"]);
    expect(env().comments.map((comment) => comment.id)).toEqual([ids[2]!, added!]);
    expect(env().sending).toBeNull();
    expect(env().destinationTabId).toBe("tab-1");
  });

  test("a failed send keeps every comment and records why", () => {
    store().getState().addComment(ENV, anchor(), "one");
    const items = env().comments.map((comment) => ({ id: comment.id, revision: comment.revision }));
    store().getState().beginSend(ENV, { requestId: "req-1", tabId: "tab-1", items });
    // A settlement for another request is ignored.
    store().getState().failSend(ENV, "req-other", "nope");
    expect(env().sending?.requestId).toBe("req-1");

    store().getState().failSend(ENV, "req-1", "Environment is stopped");
    expect(env().comments).toHaveLength(1);
    expect(env().sending).toBeNull();
    expect(env().lastError).toBe("Environment is stopped");
    expect(store().getState().completeSend(ENV, "req-1")).toEqual({ sent: 0, kept: 0 });
  });

  test("a live comment is outdated once the view shows other content for its path", () => {
    store().getState().addComment(ENV, anchor(), "live");
    store()
      .getState()
      .addComment(ENV, anchor({ source: "historical", contentKey: null }), "past");
    const [live, past] = env().comments;
    expect(diffCommentFreshness(env(), live!)).toBe("unknown");

    store().getState().observeLiveContent(ENV, "p:src/app.ts", "blob:a|blob:b");
    expect(diffCommentFreshness(env(), live!)).toBe("current");

    store().getState().observeLiveContent(ENV, "p:src/app.ts", "blob:a|blob:c");
    expect(diffCommentFreshness(env(), live!)).toBe("outdated");
    // A historical identity never changes, so it is never outdated.
    expect(diffCommentFreshness(env(), past!)).toBe("current");
  });

  test("live observations evict only environments without pending review work", () => {
    const id = store().getState().addComment(ENV, anchor({}), "In flight")!;
    store()
      .getState()
      .beginSend(ENV, { requestId: "req", tabId: "tab", items: [{ id, revision: 1 }] });
    for (let index = 0; index < 60; index++) {
      store().getState().observeLiveContent(`other-${index}`, "path", "content");
    }
    expect(env().comments[0]?.id).toBe(id);
    expect(env().sending?.items).toEqual([{ id, revision: 1 }]);
    expect(store().getState().environments.size).toBeLessThanOrEqual(50);
    expect(store().getState().completeSend(ENV, "req")).toEqual({ sent: 1, kept: 0 });
  });

  test("selects comments one at a time or all together", () => {
    const first = store().getState().addComment(ENV, anchor(), "one")!;
    store().getState().addComment(ENV, anchor(), "two");
    store().getState().setSelected(ENV, first, false);
    expect(env().comments.map((comment) => comment.selected)).toEqual([false, true]);
    store().getState().setAllSelected(ENV, true);
    expect(env().comments.map((comment) => comment.selected)).toEqual([true, true]);
  });
});
