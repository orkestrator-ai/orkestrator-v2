import { afterEach, describe, expect, test, type Mock } from "bun:test";
import { invoke } from "@/lib/native/backend";
import {
  decideGraphProjectTemplateReview,
  exportGraphTemplateBundle,
  getGraphSharingKeys,
  importGraphTemplateBundle,
  reviewGraphProjectTemplates,
  setGraphSharingKeyTrust,
} from "./graph-template-sharing";

// `@/lib/native/backend` is replaced once for every suite in tests/setup.ts.
const invokeMock = invoke as unknown as Mock<(...args: unknown[]) => Promise<unknown>>;

afterEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(() => Promise.resolve());
});

const ref = { scope: "user" as const, id: "mine" };

describe("graph sharing wrappers", () => {
  test("call the item 405 backend commands with their arguments", async () => {
    const calls: [() => Promise<unknown>, string, Record<string, unknown>][] = [
      [() => exportGraphTemplateBundle(ref), "graph_template_share_export", { ref }],
      [
        () => exportGraphTemplateBundle(ref, { sign: true, author: "Ada" }),
        "graph_template_share_export",
        { ref, sign: true, author: "Ada" },
      ],
      [() => importGraphTemplateBundle("{}"), "graph_template_share_import", { text: "{}" }],
      [
        () => importGraphTemplateBundle("{}", { projectId: "p1", confirmDigest: "d" }),
        "graph_template_share_import",
        { text: "{}", projectId: "p1", confirmDigest: "d" },
      ],
      [() => getGraphSharingKeys(), "graph_sharing_keys", {}],
      [() => getGraphSharingKeys({ create: true }), "graph_sharing_keys", { create: true }],
      [
        () => setGraphSharingKeyTrust({ action: "add", publicKey: "k", label: "Ada" }),
        "graph_sharing_key_trust",
        { action: "add", publicKey: "k", label: "Ada" },
      ],
      [
        () => reviewGraphProjectTemplates("p1"),
        "graph_project_template_review",
        { projectId: "p1" },
      ],
      [
        () =>
          decideGraphProjectTemplateReview({
            projectId: "p1",
            path: "a",
            digest: "d",
            decision: "reject",
          }),
        "graph_project_template_review_decide",
        { projectId: "p1", path: "a", digest: "d", decision: "reject" },
      ],
    ];
    for (const [call, command, args] of calls) {
      invokeMock.mockClear();
      await call();
      expect(invokeMock).toHaveBeenCalledWith(command, args);
    }
  });
});
