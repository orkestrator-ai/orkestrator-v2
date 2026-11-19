import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AgentToolsServer, type AgentToolConnection } from "../agent-tools.js";
import { FakeOpenCode2Server } from "../opencode2/fake-server.test-support.js";
import { openCode2TabMcpServer } from "../opencode2/permissions.js";
import { OpenCode2Provider } from "../opencode2/provider.js";
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
  return callConnection(server.connection("env-1", "project-1", "host", tabId), method, params);
}

async function callConnection(
  { url, token }: AgentToolConnection,
  method: string,
  params?: Record<string, unknown>,
) {
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
  test("both tab-scoped and environment-wide (OpenCode) connections list them", async () => {
    for (const tabId of ["tab-1", undefined]) {
      const listed = await call(tabId, "tools/list");
      const names = listed.body.result?.tools?.map((tool) => tool.name) ?? [];
      for (const name of CREDENTIAL_TOOLS) expect(names).toContain(name);
    }
  });

  test("an environment-wide request shows on the tab it names, and its grant works for every tab", async () => {
    const asked = await call(undefined, "tools/call", {
      name: "request_credential",
      arguments: {
        label: "API token",
        purpose: "Run the integration tests",
        use: "command",
        envVar: "API_TOKEN",
        tabId: "tab-2",
        waitSeconds: 0,
      },
    });
    const requestId =
      (asked.body.result?.structuredContent as { requestId: string } | undefined)?.requestId ??
      "missing";
    const onTab = h.service.tabSnapshot({ environmentId: "env-1", tabId: "tab-2" });
    expect(onTab.requests.map((each) => each.id)).toEqual([requestId]);
    expect(h.service.tabSnapshot({ environmentId: "env-1", tabId: "tab-1" }).requests).toEqual([]);
    const [pending] = onTab.requests;
    const { grant } = await h.service.approve({
      requestId: pending!.id,
      revision: pending!.revision,
      source: { kind: "value", value: TEST_SECRET },
    });
    for (const tabId of [undefined, "tab-1"]) {
      const run = await call(tabId, "tools/call", {
        name: "run_with_credential",
        arguments: { grantId: grant.id, command: "make test", waitSeconds: 20 },
      });
      expect(run.body.result?.structuredContent).toMatchObject({ state: "succeeded" });
      expect(run.raw).not.toContain(TEST_SECRET);
    }
  });

  test("an environment-wide request without a tab id shows on every tab", async () => {
    const asked = await call(undefined, "tools/call", {
      name: "request_credential",
      arguments: {
        label: "Key",
        purpose: "x",
        use: "command",
        envVar: "API_TOKEN",
        waitSeconds: 0,
      },
    });
    const requestId =
      (asked.body.result?.structuredContent as { requestId: string } | undefined)?.requestId ??
      "missing";
    for (const tabId of ["tab-1", "tab-2"]) {
      const snapshot = h.service.tabSnapshot({ environmentId: "env-1", tabId });
      expect(snapshot.requests.map((each) => each.id)).toEqual([requestId]);
    }
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

  test("another tab of the environment sees and uses the grant", async () => {
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
    const grants =
      (listed.body.result?.structuredContent as { grants: { grantId: string }[] } | undefined)
        ?.grants ?? [];
    expect(grants.map((each) => each.grantId)).toEqual([grant.id]);
    const run = await call("tab-2", "tools/call", {
      name: "run_with_credential",
      arguments: { grantId: grant.id, command: "true", waitSeconds: 20 },
    });
    expect(run.body.result?.structuredContent).toMatchObject({ state: "succeeded" });
  });
});

test("a native OpenCode read-only turn denies credential dispatch at the provider and MCP", async () => {
  const fake = new FakeOpenCode2Server();
  const provider = new OpenCode2Provider(fake.client(), { monitorEvents: false });
  try {
    const sessionId = await provider.createSession("build", "Fixture");
    const grants = await Promise.all(
      ["command", "http"].map(async (use) => {
        const request = await h.service.requestAccess(h.caller, {
          label: "Fixture token",
          purpose: "Fixture",
          use,
          bindingName: "API_TOKEN",
          hosts: ["api.example.com"],
        });
        return (
          await h.service.approve({
            requestId: request.id,
            revision: request.revision,
            source: { kind: "value", value: TEST_SECRET },
          })
        ).grant;
      }),
    );
    const connection = server.connection("env-1", "project-1", "host", h.caller.tabId);
    await provider.send(sessionId, "Review only", {
      requestId: "fixture-review",
      readOnly: true,
      agentMcp: connection,
    });
    const config = fake.mcp.get(openCode2TabMcpServer(sessionId))?.config as {
      headers: { Authorization: string };
    };
    const token = config.headers.Authorization.replace(/^Bearer /u, "");
    expect(token === connection.readOnlyToken && token !== connection.token).toBe(true);
    const list = await callConnection({ url: connection.url, token }, "tools/list");
    expect(list.body.result?.tools?.some(({ name }) => CREDENTIAL_TOOLS.includes(name))).toBe(
      false,
    );
    const operations = [
      { name: "run_with_credential", arguments: { grantId: grants[0]!.id, command: "fixture" } },
      {
        name: "http_request_with_credential",
        arguments: {
          grantId: grants[1]!.id,
          method: "POST",
          url: "https://api.example.com",
          body: "fixture",
        },
      },
    ];
    for (const operation of operations) {
      const permissions = fake.calls
        .filter((call) => call.method === "PATCH" && call.path === `/api/session/${sessionId}`)
        .flatMap((call) => (call.body as { permissions?: unknown[] }).permissions ?? []);
      expect(permissions).toContainEqual({
        action: `*_${operation.name}`,
        resource: "*",
        effect: "deny",
      });
      const rejected = await callConnection(
        { url: connection.url, token },
        "tools/call",
        operation,
      );
      expect(rejected.body.result?.isError ?? "error" in rejected.body).toBe(true);
    }
    expect(h.service.overview().operations).toEqual([]);
    expect(h.service.overview().grants.every((grant) => grant.uses === 0)).toBe(true);
  } finally {
    await provider.dispose();
    fake.stop();
  }
});

test("a tmux connection has no credential tools and keeps ordinary tools", async () => {
  const connection = server.connection("env-1", "project-1", "host", "tmux-1", {
    credentialsDisabled: true,
  });
  const result = await callConnection(connection, "tools/list");
  const names = result.body.result?.tools?.map(({ name }) => name) ?? [];
  expect(names.length).toBeGreaterThan(0);
  expect(names.some((name) => CREDENTIAL_TOOLS.includes(name))).toBe(false);
  server.revokeTab("env-1", "tmux-1");
  expect((await callConnection(connection, "tools/list")).body.result).toBeUndefined();
});
