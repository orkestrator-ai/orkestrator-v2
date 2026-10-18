import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  grantCodexProjectTrust,
  writableSourcePath,
  writeRefusal,
  type WriteBoundary,
} from "./mcp-apply-live-safety";

let root: string;
let boundary: WriteBoundary;
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "mcp-live-safety-")));
  boundary = {
    dataDir: path.join(root, "data"),
    worktree: path.join(root, "worktree"),
    flavor: "agent-test",
  };
  mkdirSync(boundary.dataDir);
  mkdirSync(boundary.worktree);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const source = (displayPath: string) => ({ scope: "backend-user", displayPath });

describe("live MCP source write boundaries", () => {
  test("expands display aliases under the actual isolated roots", () => {
    expect(writableSourcePath(source("~/.claude.json"), boundary)).toBe(
      path.join(boundary.dataDir, "agent-credentials/home/.claude.json"),
    );
    expect(writableSourcePath(source("<worktree>/.pi/mcp.json"), boundary)).toBe(
      path.join(boundary.worktree, ".pi/mcp.json"),
    );
    expect(
      writeRefusal(source(path.join(boundary.dataDir, "codex/config.toml")), boundary),
    ).toBeNull();
  });

  test("resolves Claude local sections to the same checked user file", () => {
    expect(writableSourcePath(source("~/.claude.json → projects[<worktree>]"), boundary)).toBe(
      path.join(boundary.dataDir, "agent-credentials/home/.claude.json"),
    );
  });

  test("rejects traversal, sibling prefixes, ambiguous displays and nonisolated profiles", () => {
    for (const shown of [
      "~/../../../../host/config",
      "<worktree>/../host/config",
      `${boundary.dataDir}-other/config`,
      path.join(root, "host/config"),
      "relative/config",
      "<worktree>evil/config",
      "~someone/config",
      `${boundary.dataDir}/config → /host/config`,
    ]) {
      expect(writeRefusal(source(shown), boundary)).not.toBeNull();
    }
    expect(
      writeRefusal(source("~/.claude.json"), { ...boundary, flavor: "production" }),
    ).not.toBeNull();
  });

  test("checks real ancestors and refuses symlinks escaping either root", () => {
    const host = path.join(root, "host");
    mkdirSync(host);
    symlinkSync(host, path.join(boundary.dataDir, "agent-credentials"));
    symlinkSync(host, path.join(boundary.worktree, ".pi"));
    expect(writeRefusal(source("~/.claude.json"), boundary)).not.toBeNull();
    expect(writeRefusal(source("<worktree>/.pi/mcp.json"), boundary)).not.toBeNull();
    expect(
      writeRefusal(source(path.join(boundary.dataDir, "agent-credentials/new/config")), boundary),
    ).not.toBeNull();
  });

  test("refuses a dangling symlink instead of creating its host target", () => {
    const file = path.join(boundary.dataDir, "config.toml");
    symlinkSync(path.join(root, "missing-host-config"), file);
    expect(writeRefusal(source(file), boundary)).not.toBeNull();
  });
});

describe("Codex project trust grant", () => {
  test("preserves existing isolated user settings and grants only the test worktree", () => {
    const file = path.join(boundary.dataDir, "codex/config.toml");
    mkdirSync(path.dirname(file));
    writeFileSync(file, 'model = "fixture"');
    expect(grantCodexProjectTrust(source(file), boundary)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(
      `model = "fixture"\n[projects.${JSON.stringify(boundary.worktree)}]\ntrust_level = "trusted"\n`,
    );
  });

  test("creates an isolated config privately, including a HOME display alias", () => {
    expect(grantCodexProjectTrust(source("~/.codex/config.toml"), boundary)).toBe(true);
    const file = path.join(boundary.dataDir, "agent-credentials/home/.codex/config.toml");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toContain('trust_level = "trusted"');
  });

  test("never grants through host homes, project scopes or symlink escapes", () => {
    const host = path.join(root, "host.toml");
    writeFileSync(host, "host sentinel");
    const linked = path.join(boundary.dataDir, "linked.toml");
    symlinkSync(host, linked);
    for (const candidate of [
      source(host),
      source(linked),
      source("<worktree>/config.toml"),
      { ...source(path.join(boundary.dataDir, "project.toml")), scope: "project" },
    ]) {
      expect(grantCodexProjectTrust(candidate, boundary)).toBe(false);
    }
    expect(readFileSync(host, "utf8")).toBe("host sentinel");
    expect(existsSync(path.join(boundary.dataDir, "project.toml"))).toBe(false);
    expect(existsSync(path.join(boundary.worktree, "config.toml"))).toBe(false);
  });
});
