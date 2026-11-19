/**
 * A project setup's MCP servers in a worktree's project MCP file, written by
 * the real MCP management service (its own editors and ownership
 * fingerprints) through the environment's target: the file is created and
 * kept out of Git, credentials are never written (`needs-auth`), a file the
 * user already had is edited in place and kept, a tracked file is a
 * collision, a hand edit is a local change, and a file Orkestrator created
 * goes with its last server.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";

import { AGENT_PLATFORMS, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";

import { createFixture, type Fixture as McpFixture } from "../mcp-management/test-support.js";
import { runCommand } from "../shell.js";
import { StorageService } from "../storage.js";
import { mcpManagementInstaller } from "./index.js";
import { testCapabilityHomes } from "./native-ownership.js";
import { isEmptyProjectMcpFile } from "./project-mcp.js";
import { projectMcpLocationFor } from "./scoped-locations.js";
import { CapabilityService } from "./service.js";

interface Fixture {
  mcp: McpFixture;
  storage: StorageService;
  service: CapabilityService;
  worktree: string;
}

const fixtures: Fixture[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.service.dispose();
    fixture.storage.close?.();
    await fixture.mcp.cleanup();
  }
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await runCommand("git", args, { cwd })).stdout;
}

async function makeFixture(tracked: Record<string, string> = {}): Promise<Fixture> {
  const mcp = createFixture({ env: {} });
  const worktree = mcp.worktree;
  await fs.writeFile(path.join(worktree, "README.md"), "Repo.\n");
  for (const [relative, content] of Object.entries(tracked)) {
    await fs.mkdir(path.dirname(path.join(worktree, relative)), { recursive: true });
    await fs.writeFile(path.join(worktree, relative), content);
  }
  await git(worktree, "init", "-q", "-b", "main");
  await git(worktree, "-c", "user.email=t@example.com", "-c", "user.name=T", "add", ".");
  await git(worktree, "-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-qm", "i");
  const storage = new StorageService(path.join(mcp.root, "capabilities-data"));
  await storage.init();
  const service = new CapabilityService({
    storage: { capabilities: storage.capabilities },
    dataDir: path.join(mcp.root, "capabilities-data"),
    selfId: async () => "bk_self",
    selfName: async () => "This machine",
    machines: async () => [],
    link: () => null,
    isAuthority: () => true,
    emit: () => undefined,
    homes: () => testCapabilityHomes(mcp.home),
    inventory: {
      providers: async () => AGENT_PLATFORMS.map((provider) => ({ provider, available: true })),
    },
    scoped: {
      environments: async () => [
        { id: "env-1", projectId: "proj-1", environmentType: "local", worktreePath: worktree },
      ],
      projectMcp: (environmentId) => mcpManagementInstaller(() => mcp.service, { environmentId }),
    },
  });
  await service.init();
  const fixture = { mcp, storage, service, worktree };
  fixtures.push(fixture);
  return fixture;
}

/** An MCP package for one provider (Claude by default) in a project toolkit assigned to `proj-1`. */
async function projectServer(
  fixture: Fixture,
  input: { name: string; url: string; envKeys?: string[]; provider?: AgentPlatform },
  setupId?: string,
): Promise<{ setupId: string; packageId: string }> {
  const toolkit = setupId ?? (await fixture.service.setSetup({ setup: { name: "Tools" } })).id;
  const inspection = await fixture.service.authorPackage({
    kind: "mcp-server",
    name: input.name,
    mcp: {
      transport: "http",
      url: input.url,
      ...(input.envKeys ? { envKeys: input.envKeys } : {}),
    },
  });
  const preview = await fixture.service.previewChange({
    change: {
      kind: "add-to-setup",
      inspectionId: inspection.inspectionId,
      setupId: toolkit,
      excludedProviders: AGENT_PLATFORMS.filter(
        (provider) => provider !== (input.provider ?? "claude"),
      ),
    },
  });
  await fixture.service.applyChange({
    operationId: preview.operation.id,
    approvedDigest: preview.operation.planDigest,
  });
  await fixture.service.assignSetup({ scope: "project", scopeId: "proj-1", setupIds: [toolkit] });
  await settle(fixture);
  return { setupId: toolkit, packageId: inspection.packageId };
}

async function settle(fixture: Fixture): Promise<void> {
  await fixture.service.reconciler.reconcileAll("test");
  await fixture.service.reconciler.idle();
}

async function receipts(fixture: Fixture) {
  return Object.values((await fixture.storage.capabilities.loadCapabilityState()).receipts).filter(
    (receipt) => receipt.environmentId === "env-1",
  );
}

const readJson = async (file: string) =>
  JSON.parse(await fs.readFile(file, "utf8")) as { mcpServers?: Record<string, unknown> };

describe("project MCP servers in a worktree", () => {
  test("are written through MCP management into the project file, kept out of Git, without credentials", async () => {
    const fixture = await makeFixture();
    const { setupId } = await projectServer(fixture, {
      name: "docs",
      url: "https://docs.example.com/mcp",
    });
    await projectServer(
      fixture,
      { name: "search", url: "https://search.example.com/mcp", envKeys: ["SEARCH_TOKEN"] },
      setupId,
    );
    const file = path.join(fixture.worktree, ".mcp.json");
    const written = await readJson(file);
    expect(written.mcpServers?.docs).toEqual(
      expect.objectContaining({ url: "https://docs.example.com/mcp" }),
    );
    // A server that needs credentials is not written: the user supplies them on this machine.
    expect(written.mcpServers?.search).toBeUndefined();
    expect(await fs.readFile(file, "utf8")).not.toContain("SEARCH_TOKEN");

    const scoped = await receipts(fixture);
    const docs = scoped.find((receipt) => receipt.componentId.endsWith("docs"));
    expect(docs?.locationId).toBe("project-mcp-claude");
    expect(docs?.status).toBe("installed-next-session");
    expect(docs?.alsoVisibleTo).toEqual(["grok"]);
    const search = scoped.find((receipt) => receipt.componentId.endsWith("search"));
    expect(search?.status).toBe("needs-auth");
    expect(search?.reason).toContain("SEARCH_TOKEN");
    // Nothing reached the backend user's own MCP configuration.
    expect(
      await fs.readFile(path.join(fixture.mcp.home, ".claude.json"), "utf8").catch(() => ""),
    ).not.toContain("docs.example.com");

    // Git sees nothing: the file Orkestrator created is in the environment's exclude block.
    expect(await git(fixture.worktree, "status", "--porcelain", "--untracked-files=all")).toBe("");
    const exclude = await fs.readFile(
      path.join(fixture.worktree, ".git", "info", "exclude"),
      "utf8",
    );
    expect(exclude).toContain("/.mcp.json");
    const view = await fixture.service.getEnvironmentDelivery({ environmentId: "env-1" });
    expect(view.items.find((item) => item.name === "docs")?.locationLabel).toBe(".mcp.json");

    // A second pass changes nothing.
    const before = await fs.readFile(file, "utf8");
    await settle(fixture);
    expect(await fs.readFile(file, "utf8")).toBe(before);

    // A hand edit is a local change, kept until the user decides.
    const edited = await readJson(file);
    (edited.mcpServers!.docs as Record<string, unknown>).url = "https://elsewhere.example.com/mcp";
    await fs.writeFile(file, `${JSON.stringify(edited, null, 2)}\n`);
    await settle(fixture);
    const drift = await fixture.service.listDrift({});
    expect(drift.drift.some((entry) => entry.locationId === "project-mcp-claude")).toBe(true);
    expect(await fs.readFile(file, "utf8")).toContain("elsewhere.example.com");
  });

  test("a file Orkestrator created goes with its last server; the user's own file is edited in place and kept", async () => {
    const created = await makeFixture();
    await projectServer(created, { name: "docs", url: "https://docs.example.com/mcp" });
    const file = path.join(created.worktree, ".mcp.json");
    expect((await readJson(file)).mcpServers?.docs).toBeDefined();
    await created.service.assignSetup({ scope: "project", scopeId: "proj-1", setupIds: [] });
    await settle(created);
    expect(await fs.lstat(file).catch(() => null)).toBeNull();
    expect(await receipts(created)).toEqual([]);
    expect(
      await fs.readFile(path.join(created.worktree, ".git", "info", "exclude"), "utf8"),
    ).not.toContain("orkestrator capabilities");

    // An untracked file the user already had: edited in place, never excluded or deleted.
    const own = await makeFixture();
    const userFile = path.join(own.worktree, ".mcp.json");
    await fs.writeFile(
      userFile,
      `${JSON.stringify({ mcpServers: { mine: { type: "http", url: "https://mine.example.com" } } }, null, 2)}\n`,
    );
    await projectServer(own, { name: "docs", url: "https://docs.example.com/mcp" });
    expect(Object.keys((await readJson(userFile)).mcpServers ?? {}).sort()).toEqual([
      "docs",
      "mine",
    ]);
    expect(
      await fs.readFile(path.join(own.worktree, ".git", "info", "exclude"), "utf8").catch(() => ""),
    ).not.toContain("/.mcp.json");
    await own.service.assignSetup({ scope: "project", scopeId: "proj-1", setupIds: [] });
    await settle(own);
    expect(Object.keys((await readJson(userFile)).mcpServers ?? {})).toEqual(["mine"]);
  });

  test("a tracked project MCP file is never edited", async () => {
    const tracked = '{ "mcpServers": {} }\n';
    const fixture = await makeFixture({ ".mcp.json": tracked });
    await projectServer(fixture, { name: "docs", url: "https://docs.example.com/mcp" });
    expect(await fs.readFile(path.join(fixture.worktree, ".mcp.json"), "utf8")).toBe(tracked);
    const docs = (await receipts(fixture)).find((receipt) => receipt.componentId.endsWith("docs"));
    expect(docs?.status).toBe("failed");
    expect(docs?.reason).toContain("tracked in this repository");
    expect(await git(fixture.worktree, "status", "--porcelain")).toBe("");
  });
  test("a provider that does not load project MCP servers here is reported, and nothing is written", async () => {
    const fixture = await makeFixture();
    await projectServer(fixture, {
      name: "docs",
      url: "https://docs.example.com/mcp",
      provider: "cursor",
    });
    const docs = (await receipts(fixture)).find((receipt) => receipt.componentId.endsWith("docs"));
    expect(docs?.locationId).toBe("project-mcp-cursor");
    expect(docs?.status).toBe("unsupported");
    expect(docs?.reason).toContain("project");
    expect(
      await fs.lstat(path.join(fixture.worktree, ".cursor", "mcp.json")).catch(() => null),
    ).toBeNull();
    expect(await git(fixture.worktree, "status", "--porcelain", "--untracked-files=all")).toBe("");
  });
});

describe("project MCP files", () => {
  test("an empty file is only an empty server map", () => {
    const claude = projectMcpLocationFor("claude")!;
    const codex = projectMcpLocationFor("codex")!;
    expect(isEmptyProjectMcpFile('{ "mcpServers": {} }', claude)).toBe(true);
    expect(isEmptyProjectMcpFile("{}", claude)).toBe(true);
    expect(isEmptyProjectMcpFile('{ "mcpServers": {}, "other": 1 }', claude)).toBe(false);
    expect(isEmptyProjectMcpFile('{ "mcpServers": { "a": {} } }', claude)).toBe(false);
    expect(isEmptyProjectMcpFile("# note\n[mcp_servers]\n", codex)).toBe(true);
    expect(isEmptyProjectMcpFile('[mcp_servers]\n[mcp_servers.a]\nurl = "x"\n', codex)).toBe(false);
  });
});
