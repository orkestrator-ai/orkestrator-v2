import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ALLOW_REAL_DATA_DIR_CLI_ENV,
  defaultOrkestratorDataDir,
  realDataDirClaudeCliRefusal,
  refuseRealDataDirClaudeCli,
} from "./live-cli-guard.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A fake home whose default data directory holds a managed `claude`. */
function fakeHome(): { home: string; managed: string; throwaway: string } {
  const home = mkdtempSync(join(tmpdir(), "live-cli-guard-"));
  roots.push(home);
  const bin = join(home, ".config", "orkestrator-v2", "toolchains", "bin", "abc");
  mkdirSync(bin, { recursive: true });
  const managed = join(bin, "claude");
  writeFileSync(managed, "");
  const throwawayDir = join(home, "worktree", "output", "toolchain-data");
  mkdirSync(throwawayDir, { recursive: true });
  const throwaway = join(throwawayDir, "claude");
  writeFileSync(throwaway, "");
  return { home, managed, throwaway };
}

describe("realDataDirClaudeCliRefusal", () => {
  test("allows an unset CLAUDE_CLI_PATH (the SDK's bundled CLI)", () => {
    const { home } = fakeHome();
    expect(realDataDirClaudeCliRefusal({}, "linux", home)).toBeNull();
    expect(realDataDirClaudeCliRefusal({ CLAUDE_CLI_PATH: "  " }, "linux", home)).toBeNull();
  });

  test("refuses a CLI inside the real data directory", () => {
    const { home, managed } = fakeHome();
    const refusal = realDataDirClaudeCliRefusal({ CLAUDE_CLI_PATH: managed }, "linux", home);
    expect(refusal).toContain("real Orkestrator data directory");
    expect(refusal).not.toContain(managed);
  });

  test("refuses a symlink that resolves into the real data directory", () => {
    const { home, managed } = fakeHome();
    const link = join(home, "claude-link");
    symlinkSync(managed, link);
    expect(realDataDirClaudeCliRefusal({ CLAUDE_CLI_PATH: link }, "linux", home)).not.toBeNull();
  });

  test("allows a throwaway install outside it", () => {
    const { home, throwaway } = fakeHome();
    expect(realDataDirClaudeCliRefusal({ CLAUDE_CLI_PATH: throwaway }, "linux", home)).toBeNull();
  });

  test("does not treat a sibling directory with the same prefix as inside", () => {
    const { home } = fakeHome();
    const sibling = join(home, ".config", "orkestrator-v2-other", "claude");
    expect(realDataDirClaudeCliRefusal({ CLAUDE_CLI_PATH: sibling }, "linux", home)).toBeNull();
  });

  test("follows XDG_CONFIG_HOME on Linux and Application Support on macOS", () => {
    expect(defaultOrkestratorDataDir("linux", { XDG_CONFIG_HOME: "/x" }, "/h")).toBe(
      "/x/orkestrator-v2",
    );
    expect(defaultOrkestratorDataDir("linux", {}, "/h")).toBe("/h/.config/orkestrator-v2");
    expect(defaultOrkestratorDataDir("darwin", {}, "/h")).toBe(
      "/h/Library/Application Support/orkestrator-v2",
    );
    expect(
      realDataDirClaudeCliRefusal(
        { CLAUDE_CLI_PATH: "/x/orkestrator-v2/toolchains/bin/claude", XDG_CONFIG_HOME: "/x" },
        "linux",
        "/h",
      ),
    ).not.toBeNull();
  });

  test("an explicit operator opt-in lets their own install run", () => {
    const { home, managed } = fakeHome();
    expect(
      realDataDirClaudeCliRefusal(
        { CLAUDE_CLI_PATH: managed, [ALLOW_REAL_DATA_DIR_CLI_ENV]: "1" },
        "linux",
        home,
      ),
    ).toBeNull();
  });

  test("refuseRealDataDirClaudeCli throws the refusal", () => {
    const { home, managed, throwaway } = fakeHome();
    expect(() => refuseRealDataDirClaudeCli({ CLAUDE_CLI_PATH: managed }, "linux", home)).toThrow(
      "real Orkestrator data directory",
    );
    expect(() =>
      refuseRealDataDirClaudeCli({ CLAUDE_CLI_PATH: throwaway }, "linux", home),
    ).not.toThrow();
  });
});
