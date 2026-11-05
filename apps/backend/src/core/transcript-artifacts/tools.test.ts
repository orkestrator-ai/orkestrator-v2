import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client as McpClient, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  ARTIFACT_TOOL_POLICY,
  STATIC_PRESENTATION_POLICY,
} from "@orkestrator/protocol/rich-content-policy";
import { ARTIFACT_TOOL_NAMES } from "@orkestrator/protocol/transcript-artifacts";
import { AgentToolsServer } from "../agent-tools.js";
import {
  ARTIFACT_ONLY_SERVER_INSTRUCTIONS,
  ARTIFACT_TOOL_INSTRUCTIONS,
  artifactAuthoringNotice,
} from "./tools.js";
import { WorkflowResultService } from "../workflow-result-service.js";
import {
  CONVERSATION,
  ENV,
  PROJECT,
  SAMPLE_CHART,
  createHarness,
  key,
  type Harness,
} from "./service-test-support.js";

type ToolResult = {
  content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  structuredContent?: Record<string, any>;
  isError?: boolean;
};

let h: Harness;
let server: AgentToolsServer;
let workflowResults: WorkflowResultService;

beforeEach(async () => {
  h = await createHarness();
  workflowResults = new WorkflowResultService(h.dataDir);
  server = new AgentToolsServer(h.storage, "127.0.0.1", workflowResults);
  server.setTranscriptArtifactToolHost(h.service);
  await server.start();
});

afterEach(async () => {
  await server.stop();
  workflowResults.closeStorage();
  await h.close();
});

async function rpc(
  url: string,
  token: string,
  method: string,
  params?: Record<string, unknown>,
): Promise<any> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method,
      ...(params ? { params } : {}),
    }),
  });
  const text = await response.text();
  const payload = response.headers.get("content-type")?.startsWith("text/event-stream")
    ? text
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice("data: ".length)
    : text;
  return payload ? JSON.parse(payload) : {};
}

/** Parses only the text block, as adapters that drop structured content and images do. */
function textOnly(result: ToolResult): Record<string, any> {
  const text = result.content?.find((block) => block.type === "text")?.text;
  expect(typeof text).toBe("string");
  expect(new TextEncoder().encode(text!).byteLength).toBeLessThanOrEqual(
    ARTIFACT_TOOL_POLICY.maxResultBytes,
  );
  return JSON.parse(text!);
}

async function call(
  connection: { url: string; token: string },
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const body = await rpc(connection.url, connection.token, "tools/call", { name, arguments: args });
  expect(body.error).toBeUndefined();
  return body.result as ToolResult;
}

describe("artifact tools over the real MCP server", () => {
  test("are listed for ordinary credentials, never for workflow-result credentials", async () => {
    const connection = server.connection(ENV, PROJECT, "host", "tab-1");
    const listed = await rpc(connection.url, connection.token, "tools/list");
    const names: string[] = listed.result.tools.map((tool: { name: string }) => tool.name);
    expect(names.slice(-ARTIFACT_TOOL_NAMES.length)).toEqual([...ARTIFACT_TOOL_NAMES]);
    for (const tool of listed.result.tools.filter((entry: { name: string }) =>
      (ARTIFACT_TOOL_NAMES as readonly string[]).includes(entry.name),
    )) {
      const schema = JSON.stringify(tool.inputSchema);
      expect(schema).not.toContain("$ref");
      expect(schema).not.toContain("$defs");
      expect(new TextEncoder().encode(schema).byteLength).toBeLessThan(32 * 1024);
    }

    const resultKey = crypto.randomUUID();
    await workflowResults.prepare({
      resultKey,
      kind: "feature-plan-state",
      environmentId: ENV,
      projectId: PROJECT,
      provider: "codex",
    });
    const restricted = server.workflowResultConnection(ENV, PROJECT, "host", resultKey);
    const restrictedNames: string[] = (
      await rpc(restricted.url, restricted.token, "tools/list")
    ).result.tools.map((tool: { name: string }) => tool.name);
    expect(
      restrictedNames.some((name) => (ARTIFACT_TOOL_NAMES as readonly string[]).includes(name)),
    ).toBe(false);
    const forbidden = await rpc(restricted.url, restricted.token, "tools/call", {
      name: "create_artifact",
      arguments: {
        requestKey: key(),
        draft: { title: "x", summary: "", payload: { kind: "chart", spec: SAMPLE_CHART } },
      },
    });
    expect(forbidden.result?.isError === true || forbidden.error !== undefined).toBe(true);
    expect(h.service.store.environmentIds()).toEqual([]);
  });

  test("top-level arguments are strict: an unknown key is refused before any work", async () => {
    const connection = server.connection(ENV, PROJECT, "host", "tab-1");
    const listed = await rpc(connection.url, connection.token, "tools/list");
    for (const tool of listed.result.tools.filter((entry: { name: string }) =>
      (ARTIFACT_TOOL_NAMES as readonly string[]).includes(entry.name),
    )) {
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
    const refused = await rpc(connection.url, connection.token, "tools/call", {
      name: "create_artifact",
      arguments: {
        requestKey: key(),
        draft: { title: "c", summary: "", payload: { kind: "chart", spec: SAMPLE_CHART } },
        projectId: "another-project",
      },
    });
    expect(refused.result?.isError === true || refused.error !== undefined).toBe(true);
    expect(h.service.store.environmentIds()).toEqual([]);
  });

  test("are withdrawn when publication is rolled back, without touching stored records", async () => {
    const connection = server.connection(ENV, PROJECT, "host", "tab-1");
    const created = textOnly(
      await call(connection, "create_artifact", {
        requestKey: key(),
        draft: { title: "c", summary: "", payload: { kind: "chart", spec: SAMPLE_CHART } },
      }),
    );
    h.flags.artifactPublication = false;
    const names: string[] = (
      await rpc(connection.url, connection.token, "tools/list")
    ).result.tools.map((tool: { name: string }) => tool.name);
    expect(names).not.toContain("create_artifact");
    expect(h.service.store.records(ENV).get("head", created.artifactId)).not.toBeNull();
    expect(h.service.capabilities().authoring).toBe(false);
  });

  test("create → preview → inspect (image block) → publish end to end, text content only", async () => {
    const connection = server.connection(ENV, PROJECT, "host", "tab-1");
    const created = textOnly(
      await call(connection, "create_artifact", {
        requestKey: key(),
        draft: {
          title: "Landing",
          summary: "A page",
          payload: { kind: "html-static", html: "<h1>Hello</h1>" },
        },
      }),
    );
    expect(created).toMatchObject({ schemaVersion: 1, ok: true, revision: 1, kind: "html-static" });
    const preview = textOnly(
      await call(connection, "preview_artifact", {
        requestKey: key(),
        artifactId: created.artifactId,
        revision: 1,
      }),
    );
    await h.service.drain();
    const inspected = await call(connection, "get_artifact_operation", {
      operationId: preview.operationId,
      includePreviewImage: true,
    });
    const status = textOnly(inspected);
    expect(status.operation.status).toBe("succeeded");
    expect(status.visualInspection).toBe("not-assessed");
    const image = inspected.content?.find((block) => block.type === "image");
    expect(image?.mimeType).toBe("image/png");
    expect(inspected.content?.find((block) => block.type === "text")?.text).not.toContain(
      image!.data!.slice(0, 32),
    );
    expect(inspected.structuredContent).toEqual(status);
    const published = textOnly(
      await call(connection, "publish_artifact", {
        requestKey: key(),
        artifactId: created.artifactId,
        expectedRevision: 1,
        receiptId: status.operation.receiptId,
      }),
    );
    expect(published.ref).toMatchObject({
      artifactId: created.artifactId,
      revision: 1,
      kind: "html-static",
    });
    expect(h.service.publicationsForConversation(ENV, CONVERSATION)).toHaveLength(1);
  });

  test("errors use the same envelope with isError", async () => {
    const connection = server.connection(ENV, PROJECT, "host", "tab-1");
    const result = await call(connection, "get_artifact", { artifactId: "art_missing00000" });
    expect(result.isError).toBe(true);
    expect(textOnly(result)).toEqual({
      schemaVersion: 1,
      ok: false,
      error: { code: "not_found", message: "Artifact not found", retryClass: "never" },
    });
  });

  test("an environment-wide credential needs the grant, which never appears in results", async () => {
    const shared = server.connection(ENV, PROJECT, "host");
    const denied = await call(shared, "create_artifact", {
      requestKey: key(),
      draft: { title: "c", summary: "", payload: { kind: "chart", spec: SAMPLE_CHART } },
    });
    expect(textOnly(denied).error.code).toBe("policy_denied");
    const grant = h.service.mintArtifactGrant({
      environmentId: ENV,
      projectId: PROJECT,
      conversationKey: CONVERSATION,
      turnId: "turn-1",
    });
    const created = await call(shared, "create_artifact", {
      requestKey: key(),
      draft: { title: "c", summary: "", payload: { kind: "chart", spec: SAMPLE_CHART } },
      scopeCapability: grant.grant,
    });
    expect(created.isError).toBeUndefined();
    expect(JSON.stringify(created)).not.toContain(grant.grant);
  });

  test("works with the modern MCP client", async () => {
    const connection = server.connection(ENV, PROJECT, "host", "tab-1");
    const client = new McpClient(
      { name: "artifact-contract", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    const transport = new StreamableHTTPClientTransport(new URL(connection.url), {
      requestInit: { headers: { Authorization: `Bearer ${connection.token}` } },
    });
    try {
      await client.connect(transport);
      const result = (await client.callTool({
        name: "create_artifact",
        arguments: {
          requestKey: key(),
          draft: {
            title: "m",
            summary: "",
            payload: { kind: "mermaid", source: "graph TD; A-->B" },
          },
        },
      })) as ToolResult;
      expect(textOnly(result)).toMatchObject({ ok: true, kind: "mermaid" });
    } finally {
      await client.close();
    }
  });
});

describe("visual guidance and authoring availability", () => {
  test("the concise guidance names chart fences and the static document display", () => {
    for (const text of [ARTIFACT_TOOL_INSTRUCTIONS, ARTIFACT_ONLY_SERVER_INSTRUCTIONS]) {
      expect(text).toContain("```chart fences");
      expect(text).toContain("displayed in the transcript");
      expect(text).toContain(`${STATIC_PRESENTATION_POLICY.maxDocumentBytes / 1024} KiB`);
    }
  });

  test("an available host adds nothing, and a host that does not report adds nothing", () => {
    expect(artifactAuthoringNotice({ preview: true, interactive: true })).toBe("");
    expect(artifactAuthoringNotice(undefined)).toBe("");
  });

  test("a missing renderer is stated with its reason, and replay is kept separate", () => {
    const notice = artifactAuthoringNotice({
      preview: false,
      previewReason: "Headless Chromium is not installed",
      interactive: false,
    });
    expect(notice).toContain("cannot currently be verified or published");
    expect(notice).toContain("Headless Chromium is not installed");
    expect(notice).toContain("already published still display");
  });

  test("a host without interactive preparation says only that", () => {
    const notice = artifactAuthoringNotice({ preview: true, interactive: false });
    expect(notice).toContain("html-interactive");
    expect(notice).toContain("html-static, mermaid and chart artifacts still work");
  });

  test("interactive authoring requires explicit runner isolation even with a preparer", () => {
    const status = h.runner.status();
    for (const interactiveIsolation of [
      undefined,
      "unavailable",
      "process",
      "container",
    ] as const) {
      h.runner.status = () => ({ ...status, interactiveIsolation });
      const availability = h.service.authoringAvailability();
      expect(availability.preview).toBe(true);
      expect(availability.interactive).toBe(
        interactiveIsolation === "process" || interactiveIsolation === "container",
      );
      if (!availability.interactive)
        expect(artifactAuthoringNotice(availability)).toContain("html-interactive");
    }
  });

  test("the service reports its real runner status", () => {
    expect(h.service.authoringAvailability().preview).toBe(true);
  });
});
