/**
 * Per-session user MCP servers on Cursor (graphs item 404).
 *
 * Cursor's SDK loads every MCP server of each settings source it is given,
 * with no per-server switch. A session whose policy selects its servers
 * therefore loads no settings source; the bridge reads the user's (and, with
 * project resources, the project's) `mcp.json` itself and passes only the
 * selected servers inline.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import { workingDirectory } from "./config.js";
import {
  cursorInlineMcpServers,
  cursorMcpServers,
  cursorSettingSources,
  cursorUserMcpServerFilter,
} from "./mcp.js";

const connection = { url: "http://127.0.0.1:4567/mcp", token: "tab-token" };

function policy(
  userMcpServers: string[] | undefined,
  deny: string[] = [],
  projectResources = false,
): NativeAgentExecutionPolicy {
  return {
    id: "pipeline",
    sandbox: "none",
    approvals: "auto-approve",
    projectResources,
    networkAccess: "full",
    capabilityPolicy: { deny: deny as never, ...(userMcpServers ? { userMcpServers } : {}) },
  };
}

describe("user MCP selection on Cursor", () => {
  let home: string;
  const projectFile = join(workingDirectory, ".cursor", "mcp.json");

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "cursor-mcp-select-home-"));
    await mkdir(join(home, ".cursor"), { recursive: true });
    await writeFile(
      join(home, ".cursor", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          docs: { url: "https://docs.example.test/mcp" },
          linear: { command: "linear-mcp" },
        },
      }),
    );
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(projectFile, { force: true });
  });

  test("a granted server is passed inline and an ungranted one is absent", async () => {
    const select = cursorUserMcpServerFilter(policy(["docs"]))!;
    const servers = await cursorMcpServers(connection, {
      projectResources: false,
      userServers: select,
      configHome: home,
    });
    expect(Object.keys(servers).sort()).toEqual(["docs", "orkestrator"]);
    expect(servers.docs).toEqual({ type: "http", url: "https://docs.example.test/mcp" });
    // Nothing loads it from settings: the inline set is all the SDK gets.
    expect(Object.keys(cursorInlineMcpServers(servers, false)).sort()).toEqual([
      "docs",
      "orkestrator",
    ]);
  });

  test("no grant passes only Orkestrator's entry; a denial wins over a grant", async () => {
    for (const selecting of [policy([]), policy(["docs"], ["mcp:docs"])]) {
      const servers = await cursorMcpServers(connection, {
        projectResources: false,
        userServers: cursorUserMcpServerFilter(selecting)!,
        configHome: home,
      });
      expect(Object.keys(servers)).toEqual(["orkestrator"]);
    }
  });

  test("with project resources the project file is selected from too and wins a name", async () => {
    await mkdir(join(workingDirectory, ".cursor"), { recursive: true });
    await writeFile(
      projectFile,
      JSON.stringify({
        mcpServers: {
          docs: { url: "https://project-docs.example.test/mcp" },
          "repo-tool": { command: "repo-tool" },
        },
      }),
    );
    const servers = await cursorMcpServers(connection, {
      projectResources: true,
      userServers: cursorUserMcpServerFilter(policy(["docs"], [], true))!,
      configHome: home,
    });
    expect(Object.keys(servers).sort()).toEqual(["docs", "orkestrator"]);
    expect(servers.docs).toMatchObject({ url: "https://project-docs.example.test/mcp" });
    // Without project resources the repository's entry never counts.
    const userOnly = await cursorMcpServers(connection, {
      projectResources: false,
      userServers: cursorUserMcpServerFilter(policy(["docs", "repo-tool"]))!,
      configHome: home,
    });
    expect(Object.keys(userOnly).sort()).toEqual(["docs", "orkestrator"]);
  });

  test("a read-only attach ignores the selection and keeps only Orkestrator's entry", async () => {
    const servers = await cursorMcpServers(connection, {
      readOnly: true,
      userServers: cursorUserMcpServerFilter(policy(["docs"]))!,
      configHome: home,
    });
    expect(Object.keys(servers)).toEqual(["orkestrator"]);
  });

  test("a selecting session loads no settings source; others keep theirs", () => {
    expect(cursorUserMcpServerFilter(policy(undefined))).toBeUndefined();
    expect(cursorUserMcpServerFilter(policy(undefined, ["mcp:docs"]))?.("docs")).toBe(false);
    expect(cursorSettingSources(policy([]), { readOnly: false, selectsServers: true })).toEqual([]);
    expect(
      cursorSettingSources(policy(undefined, [], true), { readOnly: false, selectsServers: false }),
    ).toEqual(["user", "project", "team", "plugins"]);
    expect(
      cursorSettingSources(policy(undefined), { readOnly: false, selectsServers: false }),
    ).toEqual(["user"]);
    expect(
      cursorSettingSources(policy(undefined, [], true), { readOnly: true, selectsServers: false }),
    ).toEqual([]);
  });
});
