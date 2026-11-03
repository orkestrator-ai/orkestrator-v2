import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGitBranchCollisionChecker } from "./commands-agent-support.js";
import { assertForkCommitUsable } from "./commands-environment-fork.js";
import { runCommand } from "./shell.js";

/**
 * A stored project `gitUrl` that starts with `-` must reach git as a
 * repository, never as an option. `--upload-pack=<program>` is the payload:
 * git runs that program for a local-path remote.
 */

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function payloadFixture(): Promise<{
  root: string;
  marker: string;
  optionUrl: string;
  checkout: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ork-git-url-option-"));
  roots.push(root);
  const marker = path.join(root, "payload-ran");
  const payload = path.join(root, "payload.sh");
  await fs.writeFile(payload, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
  // A checkout whose own origin cannot be fetched, so the fork check falls
  // back to fetching the project's stored URL.
  const checkout = path.join(root, "checkout");
  await runCommand("git", ["init", "-q", checkout]);
  await runCommand("git", ["-C", checkout, "remote", "add", "origin", path.join(root, "missing")]);
  return { root, marker, optionUrl: `--upload-pack=${payload}`, checkout };
}

async function exists(file: string): Promise<boolean> {
  return fs.stat(file).then(
    () => true,
    () => false,
  );
}

describe("project Git URLs that look like options", () => {
  test("the payload runs when git reads the URL as an option", async () => {
    // Positive control: without `--` the same value is a live injection, so
    // the assertions below cannot pass because the payload is inert.
    const { marker, optionUrl, checkout } = await payloadFixture();
    await runCommand("git", ["fetch", "--prune", optionUrl], { cwd: checkout }).catch(
      () => undefined,
    );
    expect(await exists(marker)).toBe(true);
  });

  test("a container fork's publish check passes the URL after `--`", async () => {
    const { marker, optionUrl, checkout } = await payloadFixture();

    await expect(
      assertForkCommitUsable(
        { gitUrl: optionUrl, localPath: checkout },
        "a".repeat(40),
        "containerized",
      ),
    ).rejects.toThrow("Could not verify that the current commit is published to a remote");
    expect(await exists(marker)).toBe(false);
  });

  test("a local fork's fetch fallback passes the URL after `--`", async () => {
    const { marker, optionUrl, checkout } = await payloadFixture();

    await expect(
      assertForkCommitUsable({ gitUrl: optionUrl, localPath: checkout }, "a".repeat(40), "local"),
    ).rejects.toThrow("Could not verify this environment's current commit");
    expect(await exists(marker)).toBe(false);
  });

  test("the remote branch lookup passes the URL after `--`", async () => {
    const { marker, optionUrl } = await payloadFixture();

    const collides = await createGitBranchCollisionChecker({
      baseBranch: "feature",
      remoteUrl: optionUrl,
    });
    expect(await collides("feature-1")).toBe(false);
    expect(await exists(marker)).toBe(false);
  });
});
