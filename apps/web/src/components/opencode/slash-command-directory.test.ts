import { describe, expect, test } from "bun:test";
import {
  CONTAINER_SLASH_COMMAND_DIRECTORY,
  resolveSlashCommandDirectory,
  shouldLoadSlashCommands,
} from "./slash-command-directory";

describe("resolveSlashCommandDirectory", () => {
  test("uses worktree path for local environments", () => {
    expect(resolveSlashCommandDirectory(true, "/Users/me/repo")).toBe(
      "/Users/me/repo",
    );
  });

  test("returns undefined for local environments without worktree", () => {
    expect(resolveSlashCommandDirectory(true, undefined)).toBeUndefined();
    expect(resolveSlashCommandDirectory(true, "   ")).toBeUndefined();
  });

  test("uses container workspace for non-local environments", () => {
    expect(resolveSlashCommandDirectory(false, undefined)).toBe(
      CONTAINER_SLASH_COMMAND_DIRECTORY,
    );
    expect(resolveSlashCommandDirectory(false, "/tmp/ignored")).toBe(
      CONTAINER_SLASH_COMMAND_DIRECTORY,
    );
  });
});

describe("shouldLoadSlashCommands", () => {
  test("requires resolved local directory", () => {
    expect(shouldLoadSlashCommands(true, undefined)).toBe(false);
    expect(shouldLoadSlashCommands(true, "")).toBe(false);
    expect(shouldLoadSlashCommands(true, "/Users/me/repo")).toBe(true);
  });

  test("always allows container environments", () => {
    expect(shouldLoadSlashCommands(false, undefined)).toBe(true);
    expect(shouldLoadSlashCommands(false, CONTAINER_SLASH_COMMAND_DIRECTORY)).toBe(
      true,
    );
  });
});
