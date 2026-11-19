import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AgentToolsServer } from "../agent-tools.js";
import {
  createCredentialHarness,
  fakeSpawner,
  TEST_SECRET,
  type CredentialHarness,
} from "./service-test-support.js";

/**
 * The credential tools on the real agent tool server: who gets them, that
 * the caller is the credential's tab and never an argument, and that no
 * answer carries a value.
 */

const CREDENTIAL_TOOLS = [
  "request_credential",
  "get_credential_request",
  "list_credential_grants",
  "run_with_credential",
  "http_request_with_credential",
  "get_credential_operation",
  "cancel_credential_operation",
];

let h: CredentialHarness;
let server: AgentToolsServer;

beforeEach(async () => {
  const spawner = fakeSpawner(({ env }) => ({ stdout: `got ${env.API_TOKEN ?? "nothing"}\n` }));
  h = await createCredentialHarness({ spawnProcess: spawner.spawnProcess });
  server = new AgentToolsServer(h.storage, "127.0.0.1");
  await server.start();
  server.setCredentialToolHost(h.service);
});

afterEach(async () => {
  await server.stop();
  await h.close();
});

async function call(tabId: string | undefined, method: string, params?: Record<string, unknown>) {
  const { url, token } = server.connection("env-1", "project-1", "host", tabId);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
  });
  const text = await response.text();
  const line = text.startsWith("{")
    ? text
    : text
        .split("\n")
        .find((entry) => entry.startsWith("data: "))
        ?.slice("data: ".length);
  return {
    raw: text,
    body: JSON.parse(line ?? "{}") as {
      result?: {
        tools?: { name: string }[];
        structuredContent?: Record<string, unknown>;
        isError?: boolean;
        content?: { text: string }[];
      };
    },
  };
}

describe("credential tools", () => {
  test("a tab-scoped connection lists them; an environment-wide one does not", async () => {
    const tab = await call("tab-1", "tools/list");
    const names = tab.body.result?.tools?.map((tool) => tool.name) ?? [];
    for (const name of CREDENTIAL_TOOLS) expect(names).toContain(name);
    const shared = await call(undefined, "tools/list");
    const sharedNames = shared.body.result?.tools?.map((tool) => tool.name) ?? [];
    for (const name of CREDENTIAL_TOOLS) expect(sharedNames).not.toContain(name);
  });

  test("request, approve and run: the agent sees a grant and filtered output only", async () => {
    const asked = await call("tab-1", "tools/call", {
      name: "request_credential",
      arguments: {
        label: "API token",
        purpose: "Run the integration tests",
        use: "command",
        envVar: "API_TOKEN",
        waitSeconds: 0,
        // Not an input of the tool: the caller is always the credential's tab.
        tabId: "tab-2",
      },
    });
    const request = asked.body.result?.structuredContent as { requestId: string; state: string };
    expect(request.state).toBe("pending");
    const snapshot = h.service.tabSnapshot({ environmentId: "env-1", tabId: "tab-1" });
    expect(snapshot.requests.map((each) => each.id)).toContain(request.requestId);

    const [pending] = snapshot.requests;
    await h.service.approve({
      requestId: pending!.id,
      revision: pending!.revision,
      source: { kind: "value", value: TEST_SECRET },
    });
    const status = await call("tab-1", "tools/call", {
      name: "get_credential_request",
      arguments: { requestId: request.requestId, waitSeconds: 0 },
    });
    const granted = status.body.result?.structuredContent as {
      state: string;
      grant: { grantId: string };
    };
    expect(granted.state).toBe("granted");

    const run = await call("tab-1", "tools/call", {
      name: "run_with_credential",
      arguments: { grantId: granted.grant.grantId, command: "make test", waitSeconds: 20 },
    });
    expect(run.body.result?.structuredContent).toMatchObject({
      state: "succeeded",
      stdout: "got [redacted]\n",
    });
    expect(run.raw).not.toContain(TEST_SECRET);
    expect(status.raw).not.toContain(TEST_SECRET);
  });

  test("another tab's connection cannot see or use the grant", async () => {
    const request = await h.service.requestAccess(h.caller, {
      label: "API token",
      purpose: "x",
      use: "command",
      bindingName: "API_TOKEN",
    });
    const { grant } = await h.service.approve({
      requestId: request.id,
      revision: request.revision,
      source: { kind: "value", value: TEST_SECRET },
    });
    const listed = await call("tab-2", "tools/call", {
      name: "list_credential_grants",
      arguments: {},
    });
    expect(listed.body.result?.structuredContent).toEqual({ grants: [] });
    const run = await call("tab-2", "tools/call", {
      name: "run_with_credential",
      arguments: { grantId: grant.id, command: "true" },
    });
    expect(run.body.result?.isError).toBe(true);
    expect(run.body.result?.content?.[0]?.text).toContain("GRANT_NOT_FOUND");
  });
});
