import { expect, test } from "bun:test";
import { coordinatorRoleCapabilities } from "./tools.js";
import { rpc, useControlMcpServerHarness } from "./server-test-support.js";
const harness = useControlMcpServerHarness();
test("coordinator mark tools return replayable marks through the real MCP surface", async () => {
  const credential = harness.coordinatorCredential(coordinatorRoleCapabilities("main"));
  for (const kind of ["topic", "question"]) {
    const result = await rpc(credential.url, credential.token, "tools/call", {
      name: `mark_${kind}`,
      arguments: { title: "Search" },
    });
    expect(result.body.result?.isError).not.toBe(true);
    expect(result.body.result?.structuredContent).toEqual({
      coordinatorAction: { version: 1, kind, title: "Search" },
    });
  }
  const invalid = await rpc(credential.url, credential.token, "tools/call", {
    name: "mark_topic",
    arguments: { title: "" },
  });
  expect(invalid.body.error ?? invalid.body.result?.isError).toBeTruthy();
});
