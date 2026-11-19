import { expect, test } from "bun:test";
import { mergeGitHubPullRequest } from "./github-pull-request-actions.js";

test("a retargeted PR with the same head requires the new base before GitHub receives a merge", async () => {
  const ref = { owner: "acme", repo: "widget", number: 42 };
  const head = "a".repeat(40);
  const payloads: unknown[] = [];
  const fetchImpl = (async (url: URL | RequestInfo, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path === "/repos/acme/widget/pulls/42" && (!init?.method || init.method === "GET")) {
      return Response.json({ number: 42, base: { ref: "release" }, head: { sha: head } });
    }
    if (path === "/repos/acme/widget/pulls/42/merge" && init?.method === "PUT") {
      payloads.push(JSON.parse(String(init.body)));
      return Response.json({ merged: true });
    }
    throw new Error(`Unexpected GitHub request: ${init?.method} ${path}`);
  }) as typeof fetch;
  const args = { method: "squash" as const, deleteBranch: false, expectedHeadSha: head };
  const options = { fetchImpl, cache: null };
  await expect(
    mergeGitHubPullRequest("fixture-token", ref, { ...args, expectedBaseRef: "main" }, options),
  ).rejects.toThrow("destination changed");
  expect(payloads).toEqual([]);
  expect(
    await mergeGitHubPullRequest(
      "fixture-token",
      ref,
      { ...args, expectedBaseRef: "release" },
      options,
    ),
  ).toMatchObject({ merged: true });
  expect(payloads).toEqual([{ merge_method: "squash", sha: head }]);
});
