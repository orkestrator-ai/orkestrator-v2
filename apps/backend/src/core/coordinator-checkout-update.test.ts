import { describe, expect, test } from "bun:test";
import type { CoordinatorRepositoryContextEvent } from "@orkestrator/protocol/coordinator";
import { pendingCheckoutUpdate, renderCheckoutUpdate } from "./coordinator-checkout-update.js";

const at = new Date(0).toISOString();
const event = (
  revision: number,
  fields: Partial<CoordinatorRepositoryContextEvent>,
): CoordinatorRepositoryContextEvent => ({
  revision,
  branch: "main",
  headCommit: `${revision}`.repeat(40),
  occurredAt: at,
  ...fields,
});

function workspace(revision: number, events: CoordinatorRepositoryContextEvent[]) {
  return {
    repositoryContextRevision: revision,
    repositoryContextEvents: events,
    repositoryStatus: { headCommit: "f".repeat(40), branch: "main" } as never,
  };
}

describe("pendingCheckoutUpdate", () => {
  const upstream = event(2, {
    previousBranch: "main",
    previousHeadCommit: "1".repeat(40),
    source: "upstream",
  });

  test("nothing before a conversation's first turn, or when it is current", () => {
    expect(pendingCheckoutUpdate(workspace(2, [upstream]), {})).toBeNull();
    expect(
      pendingCheckoutUpdate(workspace(2, [upstream]), {
        repositoryContextRevisionAcknowledged: 2,
      }),
    ).toBeNull();
  });

  test("spans every event since the acknowledged revision", () => {
    const update = pendingCheckoutUpdate(
      workspace(3, [
        upstream,
        event(3, { previousHeadCommit: "2".repeat(40), source: "upstream" }),
      ]),
      { repositoryContextRevisionAcknowledged: 1 },
    );
    expect(update).toEqual({
      fromCommit: "1".repeat(40),
      fromBranch: "main",
      toCommit: "3".repeat(40),
      toBranch: "main",
      sources: new Set(["upstream"]),
    });
  });

  test("a checkout that moved and came back has nothing to tell", () => {
    expect(
      pendingCheckoutUpdate(
        workspace(3, [
          event(2, {
            branch: "feature",
            previousBranch: "main",
            previousHeadCommit: "1".repeat(40),
            source: "switch",
          }),
          event(3, { headCommit: "1".repeat(40), previousBranch: "feature", source: "switch" }),
        ]),
        { repositoryContextRevisionAcknowledged: 1 },
      ),
    ).toBeNull();
  });

  test("an evicted start or an older event leaves the start unknown", () => {
    const gap = pendingCheckoutUpdate(workspace(5, [event(5, { source: "upstream" })]), {
      repositoryContextRevisionAcknowledged: 2,
    });
    expect(gap).toMatchObject({ fromCommit: null, toCommit: "5".repeat(40) });
    expect(gap?.sources).toEqual(new Set(["upstream", "unknown"]));
    const legacy = pendingCheckoutUpdate(workspace(2, [event(2, {})]), {
      repositoryContextRevisionAcknowledged: 1,
    });
    expect(legacy).toMatchObject({ fromCommit: null, sources: new Set(["unknown"]) });
  });
});

describe("renderCheckoutUpdate", () => {
  test("a branch switch names both branches", () => {
    expect(
      renderCheckoutUpdate(
        {
          fromCommit: "1".repeat(40),
          fromBranch: "main",
          toCommit: "2".repeat(40),
          toBranch: "feature",
          sources: new Set(["switch"]),
        },
        "origin/main",
        null,
      ),
    ).toStartWith(
      `Checkout update: since your previous turn the project checkout moved from branch main to feature (${"1".repeat(12)} → ${"2".repeat(12)}).`,
    );
  });

  test("bounds its lists and keeps each entry on one line", () => {
    const notice = renderCheckoutUpdate(
      {
        fromCommit: "1".repeat(40),
        fromBranch: "main",
        toCommit: "2".repeat(40),
        toBranch: "main",
        sources: new Set(["external"]),
      },
      null,
      {
        totalCommits: 30,
        commits: [{ sha: "abc1234", subject: "Line one\nline two" }],
        totalFiles: 50,
        files: ["a\nb.ts"],
      },
    );
    expect(notice).toContain("was changed outside Orkestrator (main,");
    expect(notice).toContain("New commits (30, newest first):\n- abc1234 Line one line two\n");
    expect(notice).toContain("- … and 29 more\n");
    expect(notice).toContain("Changed files (50):\n- a b.ts\n- … and 49 more\n");
  });
});
