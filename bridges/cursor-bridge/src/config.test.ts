/**
 * The process cwd is the Shell tool's default working directory.
 *
 * `local.cwd` is the SDK workspace, but a Shell call that omits
 * `workingDirectory` runs from `process.cwd()` instead. These tests pin that
 * we actually enter the workspace, so a launcher that started us in the
 * bridge package cannot leave git and other relative commands outside the repo.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyWorkingDirectory, workingDirectory } from "./config.js";

describe("applyWorkingDirectory", () => {
  const original = process.cwd();

  afterEach(() => {
    process.chdir(original);
  });

  test("moves the process into the given workspace", () => {
    const workspace = mkdtempSync(join(tmpdir(), "cursor-bridge-cwd-"));
    const elsewhere = mkdtempSync(join(tmpdir(), "cursor-bridge-elsewhere-"));
    try {
      process.chdir(elsewhere);
      applyWorkingDirectory(workspace);
      expect(process.cwd()).toBe(realpathSync(workspace));
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test("defaults to the configured working directory", () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "cursor-bridge-default-cwd-"));
    try {
      process.chdir(elsewhere);
      applyWorkingDirectory();
      expect(process.cwd()).toBe(realpathSync(workingDirectory));
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test("names the workspace when the directory is missing", () => {
    const missing = join(tmpdir(), `cursor-bridge-missing-${Date.now()}`);
    expect(() => applyWorkingDirectory(missing)).toThrow(/could not enter the workspace directory/);
    expect(() => applyWorkingDirectory(missing)).toThrow(missing);
  });
});
