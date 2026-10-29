import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { compileGraphCapabilities } from "@orkestrator/protocol/graphs/capability-profiles";
import type { GraphCapabilitySpec } from "@orkestrator/protocol/graphs/template";
import type {
  McpManagementSnapshot,
  McpManagementTarget,
} from "@orkestrator/protocol/mcp-management";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import { useState } from "react";
import { GraphMcpServersEditor } from "./GraphMcpServersEditor";
import { loadConfiguredUserMcpServers, type ConfiguredMcpServerSource } from "./graph-designer-mcp";

afterEach(cleanup);

const host: NativeAgentExecutionPolicy = {
  id: "pipeline",
  sandbox: "none",
  approvals: "auto-approve",
  projectResources: false,
  networkAccess: "full",
};

function target(provider: "claude" | "codex", kind: "backend" | "environment" = "backend") {
  return {
    targetId: `${provider}-${kind}`,
    provider,
    context: { kind },
  } as unknown as McpManagementTarget;
}

function snapshot(
  definitions: Array<{ name: string; sourceId: string; status?: string }>,
): McpManagementSnapshot {
  return {
    sources: [
      { sourceId: "user", scope: "backend-user" },
      { sourceId: "project", scope: "project" },
      { sourceId: "injected", scope: "injected" },
    ],
    definitions: definitions.map((entry) => ({ status: "effective", ...entry })),
  } as unknown as McpManagementSnapshot;
}

const SOURCE: ConfiguredMcpServerSource = {
  listTargets: async () => ({
    protocolVersion: 1,
    backendId: "b",
    targets: [target("claude"), target("codex"), target("codex", "environment")],
  }),
  snapshot: async (targetId) =>
    targetId === "claude-backend"
      ? snapshot([
          { name: "docs", sourceId: "user" },
          { name: "repo-tool", sourceId: "project" },
          { name: "orkestrator", sourceId: "injected", status: "protected" },
        ])
      : snapshot([
          { name: "docs", sourceId: "user" },
          { name: "linear", sourceId: "user" },
          { name: "plugin:gh:github", sourceId: "user" },
        ]),
};

describe("configured user MCP servers", () => {
  test("lists user-scope servers across providers, never project or reserved ones", async () => {
    expect(await loadConfiguredUserMcpServers(SOURCE)).toEqual([
      { name: "docs", providers: ["claude", "codex"] },
      { name: "linear", providers: ["codex"] },
    ]);
  });

  test("a provider whose snapshot fails is skipped; no targets is an error", async () => {
    const partial: ConfiguredMcpServerSource = {
      ...SOURCE,
      snapshot: async (targetId) => {
        if (targetId === "claude-backend") throw new Error("unreadable");
        return SOURCE.snapshot(targetId);
      },
    };
    expect((await loadConfiguredUserMcpServers(partial)).map((server) => server.name)).toEqual([
      "docs",
      "linear",
    ]);
    await expect(
      loadConfiguredUserMcpServers({
        ...SOURCE,
        listTargets: async () => {
          throw new Error("offline");
        },
      }),
    ).rejects.toThrow("offline");
  });
});

function Harness({
  initial,
  source,
  onSpec,
}: {
  initial: GraphCapabilitySpec;
  source: ConfiguredMcpServerSource;
  onSpec: (spec: GraphCapabilitySpec) => void;
}) {
  const [spec, setSpec] = useState(initial);
  const compiled = compileGraphCapabilities({ spec, environment: host });
  return (
    <GraphMcpServersEditor
      spec={spec}
      compiled={compiled}
      source={source}
      onChange={(_label, next) => {
        setSpec(next);
        onSpec(next);
      }}
    />
  );
}

describe("GraphMcpServersEditor", () => {
  test("grants and denies configured servers, and keeps names the user has not configured", async () => {
    const specs: GraphCapabilitySpec[] = [];
    const { container } = render(
      <Harness
        initial={{ profile: "builder", allow: ["mcp:gone"] }}
        source={SOURCE}
        onSpec={(spec) => specs.push(spec)}
      />,
    );
    await waitFor(() => expect(screen.getByLabelText("docs MCP server")).toBeDefined());
    const row = (name: string) => container.querySelector(`[data-graph-mcp-server="${name}"]`)!;
    expect(row("gone").textContent).toContain("not configured");
    expect(row("gone").textContent).toContain("granted");
    expect(row("docs").textContent).toContain("Claude Code, Codex");
    expect(row("docs").textContent).toContain("off");

    fireEvent.change(screen.getByLabelText("docs MCP server"), { target: { value: "grant" } });
    expect(specs.at(-1)).toEqual({ profile: "builder", allow: ["mcp:gone", "mcp:docs"] });
    expect(row("docs").textContent).toContain("granted");

    fireEvent.change(screen.getByLabelText("linear MCP server"), { target: { value: "deny" } });
    expect(specs.at(-1)?.deny).toEqual(["mcp:linear"]);
    expect(row("linear").textContent).toContain("denied");

    fireEvent.change(screen.getByLabelText("gone MCP server"), { target: { value: "off" } });
    expect(specs.at(-1)?.allow).toEqual(["mcp:docs"]);
  });

  test("says so when the configured servers cannot be read", async () => {
    render(
      <Harness
        initial={{ profile: "reviewer", deny: ["mcp:docs"] }}
        source={{
          ...SOURCE,
          listTargets: async () => {
            throw new Error("offline");
          },
        }}
        onSpec={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("could not"));
    expect(screen.getByLabelText("docs MCP server")).toBeDefined();
  });
});
