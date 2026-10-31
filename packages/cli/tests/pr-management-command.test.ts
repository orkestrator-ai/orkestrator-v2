import { afterEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { publicSuccessEnvelope, type PublicReceipt } from "@orkestrator/protocol/public-api";
import { PUBLIC_API_FIXTURES } from "@orkestrator/protocol/testing/public-api-fixtures";
import {
  capabilities,
  createSandbox,
  defaultResponder,
  envelope,
  startFakeGateway,
  type ClientSandbox,
  type FakeGateway,
  type RecordedRequest,
} from "./support/client-harness.js";

/** `orkestrator pr …`: the flags reach the action's input, and the risky ones need `--yes`. */

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function receipt(action: PublicReceipt["action"]): PublicReceipt {
  return {
    ...PUBLIC_API_FIXTURES.runCompleted.receipt!,
    operationId: "op-1790000000000-0a1b2c3d-000000000000000021",
    action,
    state: "succeeded",
    stage: "completed",
    resources: {},
  };
}

const URL_7 = "https://github.com/acme/site/pull/7";

async function fixture(): Promise<{ box: ClientSandbox; gateway: FakeGateway }> {
  const box = await createSandbox();
  const own = capabilities();
  const gateway = await startFakeGateway((request: RecordedRequest) => {
    const action = request.body.args.action as PublicReceipt["action"];
    if (action === "capabilities") {
      return envelope(publicSuccessEnvelope("capabilities", own));
    }
    if (typeof action === "string" && action.startsWith("pr.")) {
      const mutation = request.body.args.request !== undefined;
      return envelope(
        publicSuccessEnvelope(
          action,
          action === "pr.list"
            ? { pullRequests: [{ number: 7, state: "open", title: "Fix", htmlUrl: URL_7 }] }
            : {
                environmentId: "env-1",
                url: URL_7,
                number: 7,
                attachment: "stored",
                pullRequest: null,
              },
          mutation ? receipt(action) : undefined,
        ),
      );
    }
    return defaultResponder()(request);
  });
  cleanups.push(
    () => box.cleanup(),
    () => gateway.stop(),
  );
  const dataDir = await box.publishDescriptor(gateway);
  await box.run(["connection", "add", "local", "--data-dir", dataDir, "--default", "--no-check"]);
  return { box, gateway };
}

function inputsOf(gateway: FakeGateway, action: string): unknown[] {
  return gateway.requests
    .filter((request) => request.body.args.action === action)
    .map((request) => request.body.args.input);
}

describe("orkestrator pr", () => {
  test("merge needs --yes and sends nothing without it", async () => {
    const { box, gateway } = await fixture();
    const refused = await box.run(["pr", "merge", "env-1", "--json"]);
    expect(refused.code).toBe(2);
    expect(refused.out + refused.err).toContain("--yes");
    expect(inputsOf(gateway, "pr.merge")).toEqual([]);
  });

  test("merge carries its flags, and --keep-branch is deleteBranch false", async () => {
    const { box, gateway } = await fixture();
    const plain = await box.run(["pr", "merge", "env-1", "--yes", "--json"]);
    expect(plain.code).toBe(0);
    const full = await box.run([
      "pr",
      "merge",
      "env-1",
      "--yes",
      "--method",
      "rebase",
      "--keep-branch",
      "--expected-head-sha",
      "0123456789abcdef0123456789abcdef01234567",
      "--json",
    ]);
    expect(full.code).toBe(0);
    const cleaned = await box.run(["pr", "merge", "env-1", "--yes", "--cleanup", "--json"]);
    expect(cleaned.code).toBe(0);
    expect(inputsOf(gateway, "pr.merge")).toEqual([
      { environmentId: "env-1" },
      {
        environmentId: "env-1",
        method: "rebase",
        deleteBranch: false,
        expectedHeadSha: "0123456789abcdef0123456789abcdef01234567",
      },
      { environmentId: "env-1", cleanup: true },
    ]);
    const invalid = await box.run(["pr", "merge", "env-1", "--yes", "--method", "octopus"]);
    expect(invalid.code).toBe(2);
  });

  test("close and review need --yes; reopen does not", async () => {
    const { box, gateway } = await fixture();
    expect((await box.run(["pr", "close", "env-1"])).code).toBe(2);
    expect((await box.run(["pr", "review", "env-1", "--event", "APPROVE"])).code).toBe(2);
    expect(inputsOf(gateway, "pr.close")).toEqual([]);
    expect((await box.run(["pr", "close", "env-1", "--yes"])).code).toBe(0);
    expect((await box.run(["pr", "reopen", "env-1"])).code).toBe(0);
    const review = await box.run([
      "pr",
      "review",
      "env-1",
      "--event",
      "REQUEST_CHANGES",
      "--body",
      "Needs a test",
      "--yes",
    ]);
    expect(review.code).toBe(0);
    expect(inputsOf(gateway, "pr.review")).toEqual([
      { environmentId: "env-1", event: "REQUEST_CHANGES", body: "Needs a test" },
    ]);
  });

  test("comment takes inline text or a file, and requires one", async () => {
    const { box, gateway } = await fixture();
    expect((await box.run(["pr", "comment", "env-1"])).code).toBe(2);
    expect((await box.run(["pr", "comment", "env-1", "--body", "Hello"])).code).toBe(0);
    const file = path.join(box.root, "comment.md");
    await writeFile(file, "From a file");
    expect((await box.run(["pr", "comment", "env-1", "--body-file", file])).code).toBe(0);
    expect(inputsOf(gateway, "pr.comment")).toEqual([
      { environmentId: "env-1", body: "Hello" },
      { environmentId: "env-1", body: "From a file" },
    ]);
  });

  test("the smaller changes map their flags", async () => {
    const { box, gateway } = await fixture();
    for (const argv of [
      ["pr", "ready", "env-1"],
      ["pr", "draft", "env-1"],
      ["pr", "comment-edit", "env-1", "--comment-id", "5", "--body", "Edited"],
      [
        "pr",
        "review-comment",
        "env-1",
        "--path",
        "a.ts",
        "--line",
        "4",
        "--side",
        "RIGHT",
        "--body",
        "Why?",
      ],
      ["pr", "thread-reply", "env-1", "--thread-id", "t", "--body", "Fixed"],
      ["pr", "thread-resolve", "env-1", "--thread-id", "t", "--unresolve"],
      ["pr", "file-viewed", "env-1", "--path", "a.ts"],
      ["pr", "reviewers", "env-1", "--add", "octocat, acme/core"],
      ["pr", "label", "env-1", "--name", "bug", "--remove"],
    ]) {
      expect({ argv, code: (await box.run(argv)).code }).toEqual({ argv, code: 0 });
    }
    expect(inputsOf(gateway, "pr.comment.edit")).toEqual([
      { environmentId: "env-1", commentId: 5, body: "Edited" },
    ]);
    expect(inputsOf(gateway, "pr.review.comment")).toEqual([
      { environmentId: "env-1", path: "a.ts", line: 4, side: "RIGHT", body: "Why?" },
    ]);
    expect(inputsOf(gateway, "pr.thread.resolve")).toEqual([
      { environmentId: "env-1", threadId: "t", resolved: false },
    ]);
    expect(inputsOf(gateway, "pr.reviewers")).toEqual([
      { environmentId: "env-1", add: ["octocat", "acme/core"], remove: [] },
    ]);
    expect(inputsOf(gateway, "pr.label")).toEqual([
      { environmentId: "env-1", name: "bug", present: false },
    ]);
  });

  test("reads take no request key", async () => {
    const { box, gateway } = await fixture();
    const read = await box.run(["pr", "get", "env-1", "--json"]);
    expect(read.code).toBe(0);
    expect(inputsOf(gateway, "pr.get")).toEqual([{ environmentId: "env-1" }]);
    const listed = await box.run([
      "pr",
      "list",
      "project-1",
      "--filter",
      "closed",
      "--output",
      "id",
    ]);
    expect(listed.code).toBe(0);
    expect(listed.out.trim()).toBe(URL_7);
    expect(inputsOf(gateway, "pr.list")).toEqual([{ projectId: "project-1", filter: "closed" }]);
  });
});
