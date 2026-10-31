import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { sanitizeAgentTestingArtifacts } from "./artifact-sanitizer";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";
const runId = process.env.ORKESTRATOR_AGENT_TEST_RUN_ID ?? profile;

/** Redacts one suite's artifacts under `output/agent-testing/<run>/<suite>`. */
export async function sanitizeRunArtifacts(
  suite: "browser" | "coordinator" | "goals",
): Promise<void> {
  const statusResult = spawnSync(
    "bun",
    ["run", "dev:status", "--", "--profile", profile, "--json"],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  let auth: { token?: string } = {};
  try {
    const status = statusResult.stdout.trim()
      ? (JSON.parse(statusResult.stdout) as { authFile?: string })
      : {};
    auth = status.authFile
      ? (JSON.parse(await readFile(status.authFile, "utf8")) as { token?: string })
      : {};
  } catch {
    // Cookie values are still pattern-redacted below. The persistent token is
    // never passed to Playwright, so an unavailable status file is safe.
  }
  await sanitizeAgentTestingArtifacts(
    path.join(repositoryRoot, "output", "agent-testing", runId, suite),
    auth.token ? [auth.token] : [],
  );
}

export default async function globalTeardown(): Promise<void> {
  await sanitizeRunArtifacts("browser");
}
