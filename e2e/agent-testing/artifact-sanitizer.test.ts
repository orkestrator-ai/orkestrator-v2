import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sanitizeAgentTestingArtifacts } from "./artifact-sanitizer";

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
});
