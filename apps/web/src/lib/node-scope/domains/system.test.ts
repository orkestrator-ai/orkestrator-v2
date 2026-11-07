import { describe, expect, mock, test } from "bun:test";
import type { NegotiatedDomains } from "@orkestrator/protocol/node-client";
import type { BackendClient } from "@/lib/backend/client";
import { createSignal } from "@/lib/node-scope/signal";
import { systemApi } from "./system";

function fakeClient(
  domains: NegotiatedDomains | null,
  answer: () => unknown,
): BackendClient & { invokeRaw: ReturnType<typeof mock> } {
  return {
    invokeRaw: mock(async () => answer()) as never,
    domains: createSignal<NegotiatedDomains | null>(domains),
    capabilities: createSignal<ReadonlySet<string> | null>(null),
  };
}

const snapshot = {
  report: null,
  draft: null,
};

describe("system over a lib/backend client", () => {
  test("a node with the domain gets typed calls with the envelope and decoded results", async () => {
    const client = fakeClient({ system: { min: 1, max: 1 } }, () => ({
      kind: "browser",
      url: "https://github.com/x/y/issues/new",
      bodyInUrl: true,
      reason: "gh is not signed in",
    }));
    await expect(
      systemApi(client).file_bug_report({ reportId: "r1", title: "T", body: "B", via: "browser" }),
    ).resolves.toEqual({
      kind: "browser",
      url: "https://github.com/x/y/issues/new",
      bodyInUrl: true,
      reason: "gh is not signed in",
    });
    expect(client.invokeRaw).toHaveBeenCalledWith(
      "file_bug_report",
      { reportId: "r1", title: "T", body: "B", via: "browser" },
      { envelope: { domain: "system", version: 1, critical: ["via"] } },
    );
  });

  test("a pre-contract node gets today's calls, answered as sent", async () => {
    const client = fakeClient(null, () => snapshot);
    await expect(systemApi(client).get_bug_report(undefined as never)).resolves.toBe(snapshot);
    expect(client.invokeRaw.mock.calls.at(-1)).toEqual(["get_bug_report"]);
    await systemApi(client).discard_bug_report({ reportId: "r1" });
    expect(client.invokeRaw).toHaveBeenLastCalledWith("discard_bug_report", { reportId: "r1" });
    await systemApi(client).get_worktree_locations({});
    expect(client.invokeRaw.mock.calls.at(-1)).toEqual(["get_worktree_locations"]);
  });
});
