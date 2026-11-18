/**
 * A Pi conversation's other branches (`GET /session/:id/branches`) and the
 * switch that takes one of their entry ids.
 */
import { describe, expect, test } from "bun:test";
import { NATIVE_AGENT_BRANCH_LIST_LIMITS } from "@orkestrator/protocol/native-agent";
import { ProviderUnavailableError, PromptRejectedError } from "../agent-provider-contract.js";
import { codexConnection, httpProvider, piConnection } from "../agent-provider-test-support.js";

describe("HTTP bridge session branches", () => {
  test("reads a Pi session's branches and switches to one by entry id", async () => {
    const { provider, requests } = httpProvider(
      (url) =>
        new URL(url).pathname.endsWith("/branches")
          ? Response.json({
              activeEntryId: "e-2",
              branches: [{ entryId: "e/9", prompt: "second", entries: 4, updatedAt: "t" }],
              truncated: false,
            })
          : Response.json({ switched: true }),
      piConnection,
    );
    expect(await provider.listSessionBranches!("pi/session")).toEqual({
      activeEntryId: "e-2",
      branches: [{ entryId: "e/9", prompt: "second", entries: 4, updatedAt: "t" }],
      truncated: false,
    });
    await provider.performSessionAction!("pi/session", { kind: "switch-branch", entryId: "e/9" });
    expect(
      requests.map((request) => [request.init.method ?? "GET", new URL(request.url).pathname]),
    ).toEqual([
      ["GET", "/session/pi%2Fsession/branches"],
      ["POST", "/session/pi%2Fsession/branches/e%2F9"],
    ]);
  });

  test("an ordinary switch sends no body, so it never asks for a summary", async () => {
    const { provider, requests } = httpProvider(
      () => Response.json({ switched: true, summarized: false }),
      piConnection,
    );
    expect(
      await provider.performSessionAction!("s", { kind: "switch-branch", entryId: "e-1" }),
    ).toEqual({ outcome: "applied" });
    expect(
      await provider.performSessionAction!("s", {
        kind: "switch-branch",
        entryId: "e-1",
        summarize: false,
      }),
    ).toEqual({ outcome: "applied" });
    expect(requests.map((request) => request.init.body)).toEqual([undefined, undefined]);
  });

  test("a summarized switch asks for the summary and reports whether Pi kept one", async () => {
    const answers = [
      Response.json({ switched: true, summarized: true }),
      // Nothing to summarize on the branch left.
      Response.json({ switched: true, summarized: false }),
      // A bridge that predates summaries ignores the body.
      Response.json({ switched: true }),
    ];
    const { provider, requests } = httpProvider(() => answers.shift()!, piConnection);
    const action = { kind: "switch-branch" as const, entryId: "e-1", summarize: true };
    expect(await provider.performSessionAction!("s", action)).toEqual({
      outcome: "applied",
      summarized: true,
    });
    expect(await provider.performSessionAction!("s", action)).toEqual({
      outcome: "applied",
      summarized: false,
    });
    expect(await provider.performSessionAction!("s", action)).toEqual({
      outcome: "applied",
      summarized: false,
    });
    expect(requests[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(requests[0]!.init.body))).toEqual({ summarize: true });
  });

  test("a stopped or refused summarized switch fails in the bridge's own words", async () => {
    const stopped =
      "The branch switch was stopped before Pi finished the summary; the conversation stayed on its branch.";
    const refused = "This branch ends on a prompt with no reply, so a summary cannot follow it.";
    const answers = [
      Response.json({ error: stopped, cancelled: true, reason: "cancelled" }, { status: 409 }),
      Response.json({ error: refused, kind: "branch-summary-failed" }, { status: 422 }),
      Response.json({ error: "Session is already running" }, { status: 409 }),
    ];
    const { provider } = httpProvider(() => answers.shift()!, piConnection);
    const action = { kind: "switch-branch" as const, entryId: "e-1", summarize: true };
    await expect(provider.performSessionAction!("s", action)).rejects.toThrow(
      new RegExp(`^${stopped.replace(/[.;]/g, "\\$&")}$`),
    );
    await expect(provider.performSessionAction!("s", action)).rejects.toThrow(
      new RegExp(`^${refused.replace(/[.,]/g, "\\$&")}$`),
    );
    // Anything else keeps the operation and the status.
    await expect(provider.performSessionAction!("s", action)).rejects.toThrow(
      "Pi branch switch failed (HTTP 409): Session is already running",
    );
  });

  test("drops malformed branches and bounds the rest", async () => {
    const limits = NATIVE_AGENT_BRANCH_LIST_LIMITS;
    const many = Array.from({ length: limits.branches + 3 }, (_, index) => ({
      entryId: `e-${index}`,
      prompt: "x".repeat(limits.promptChars + 10),
      entries: 2,
      updatedAt: "t",
    }));
    const { provider } = httpProvider(
      () =>
        Response.json({
          activeEntryId: 7,
          branches: [{ prompt: "no id" }, { entryId: "e-neg", entries: -3 }, ...many],
        }),
      piConnection,
    );
    const listed = await provider.listSessionBranches!("s");
    expect(listed.activeEntryId).toBeNull();
    expect(listed.branches).toHaveLength(limits.branches);
    expect(listed.branches[0]).toEqual({ entryId: "e-neg", prompt: "", entries: 0, updatedAt: "" });
    expect(listed.branches[1]!.prompt).toHaveLength(limits.promptChars);
    expect(listed.truncated).toBe(true);
  });

  test("a malformed list fails rather than reading as no branches", async () => {
    const { provider } = httpProvider(() => Response.json({ nope: true }), piConnection);
    await expect(provider.listSessionBranches!("s")).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
  });

  test("only Pi has branches", async () => {
    const { provider, requests } = httpProvider(() => Response.json({}), codexConnection);
    await expect(provider.listSessionBranches!("s")).rejects.toBeInstanceOf(PromptRejectedError);
    expect(requests).toEqual([]);
  });
});
