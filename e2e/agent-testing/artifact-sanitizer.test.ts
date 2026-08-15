import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MAX_SANITIZABLE_FILE_BYTES, sanitizeAgentTestingArtifacts } from "./artifact-sanitizer";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((target) => rm(target, {
    recursive: true,
    force: true,
  })));
});

describe("agent-test artifact sanitizer", () => {
  test("redacts gateway credentials from plain results and Playwright traces", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ork-agent-artifacts-"));
    temporaryDirectories.push(root);
    const secret = "persistent-gateway-token";
    const session = "temporary-browser-session";
    await writeFile(path.join(root, "results.json"), JSON.stringify({ secret }));

    const traceSource = await mkdtemp(path.join(os.tmpdir(), "ork-agent-trace-source-"));
    temporaryDirectories.push(traceSource);
    await writeFile(path.join(traceSource, "trace.network"), [
      `authorization: Bearer ${secret}`,
      `cookie: orkestrator_gateway_auth=${session}; theme=dark`,
      JSON.stringify({ name: "orkestrator_gateway_auth", value: session }),
    ].join("\n"));
    const archive = path.join(root, "trace.zip");
    expect(spawnSync("zip", ["-q", "-r", archive, "."], { cwd: traceSource }).status).toBe(0);

    await sanitizeAgentTestingArtifacts(root, [secret]);

    expect(await readFile(path.join(root, "results.json"), "utf8")).not.toContain(secret);
    const unpacked = await mkdtemp(path.join(os.tmpdir(), "ork-agent-trace-check-"));
    temporaryDirectories.push(unpacked);
    expect(spawnSync("unzip", ["-qq", archive, "-d", unpacked]).status).toBe(0);
    const trace = await readFile(path.join(unpacked, "trace.network"), "utf8");
    expect(trace).not.toContain(secret);
    expect(trace).not.toContain(session);
    expect(trace).toContain("orkestrator_gateway_auth=[REDACTED]");
  });

  test("stages the redacted trace beside the original so the swap cannot cross filesystems", async () => {
    // `rename` fails with EXDEV across mount points, and on Linux the temp
    // directory is routinely a separate tmpfs from the checkout. Staging beside
    // the archive is what keeps the swap on one filesystem.
    const root = await mkdtemp(path.join(os.tmpdir(), "ork-agent-staging-"));
    temporaryDirectories.push(root);
    const traceSource = await mkdtemp(path.join(os.tmpdir(), "ork-agent-staging-source-"));
    temporaryDirectories.push(traceSource);
    await writeFile(path.join(traceSource, "trace.network"), "cookie: orkestrator_gateway_auth=leaked\n");
    const archive = path.join(root, "trace.zip");
    expect(spawnSync("zip", ["-q", "-r", archive, "."], { cwd: traceSource }).status).toBe(0);

    await sanitizeAgentTestingArtifacts(root, []);

    const unpacked = await mkdtemp(path.join(os.tmpdir(), "ork-agent-staging-check-"));
    temporaryDirectories.push(unpacked);
    expect(spawnSync("unzip", ["-qq", archive, "-d", unpacked]).status).toBe(0);
    expect(await readFile(path.join(unpacked, "trace.network"), "utf8"))
      .toContain("orkestrator_gateway_auth=[REDACTED]");
    // No staging directory survives next to the archive it redacted.
    expect(spawnSync("ls", [root], { encoding: "utf8" }).stdout.trim()).toBe("trace.zip");
  });

  test("destroys an archive it could not redact rather than leaving the original", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ork-agent-unredactable-"));
    temporaryDirectories.push(root);
    const archive = path.join(root, "trace.zip");
    // Not a zip at all, so unpacking fails and the redacted replacement can
    // never be installed. The file still on disk is the unredacted one.
    await writeFile(archive, "cookie: orkestrator_gateway_auth=leaked\n");

    await expect(sanitizeAgentTestingArtifacts(root, [])).rejects.toThrow(
      "Unable to unpack an agent-test trace for redaction",
    );

    await expect(readFile(archive, "utf8")).rejects.toThrow();
  });

  test("rejects and destroys an artifact that exceeds the sanitizer memory bound", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ork-agent-oversized-"));
    temporaryDirectories.push(root);
    const artifact = path.join(root, "oversized.log");
    await writeFile(artifact, "potential-secret");
    await truncate(artifact, MAX_SANITIZABLE_FILE_BYTES + 1);

    await expect(sanitizeAgentTestingArtifacts(artifact, ["potential-secret"]))
      .rejects.toThrow("sanitization limit");
    await expect(readFile(artifact)).rejects.toThrow();
  });

  test("removes only an oversized artifact and still redacts safe evidence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ork-agent-partial-bound-"));
    temporaryDirectories.push(root);
    const oversized = path.join(root, "oversized.log");
    const safe = path.join(root, "results.json");
    const secret = "preserve-and-redact-this-secret";
    await writeFile(oversized, "uninspectable");
    await truncate(oversized, MAX_SANITIZABLE_FILE_BYTES + 1);
    await writeFile(safe, JSON.stringify({ secret }));

    await expect(sanitizeAgentTestingArtifacts(root, [secret]))
      .rejects.toThrow("sanitization limit");

    expect(await stat(root)).not.toBeNull();
    expect(await stat(oversized).catch(() => null)).toBeNull();
    const retained = await readFile(safe, "utf8");
    expect(retained).not.toContain(secret);
    expect(retained).toContain("[REDACTED]");
  });
});
