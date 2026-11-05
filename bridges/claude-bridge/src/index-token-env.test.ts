/**
 * A Claude bridge given a verifier holds no token (security H4). Runs the module
 * in a fresh process: module-load side effects cannot be re-run in one that has
 * already imported it.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const PROBE_TOKEN = "h4-probe-token";
const VERIFIER = createHash("sha256").update(PROBE_TOKEN).digest("hex");
const moduleUrl = pathToFileURL(join(import.meta.dir, "index.ts")).href;

const probe = `
const mod = await import(${JSON.stringify(moduleUrl)});
const accepts = async (token) => (await mod.app.request("/global/auth-check", { headers: { "X-Orkestrator-Claude-Token": token } })).status === 200;
process.stdout.write(JSON.stringify({
  env: process.env.CLAUDE_BRIDGE_TOKEN_SHA256 ?? null,
  token: await accepts("${PROBE_TOKEN}"),
  verifier: await accepts("${VERIFIER}"),
}));
process.exit(0);
`;

describe("Claude bridge credential", () => {
  test("given a verifier, holds no token: what a same-uid reader finds is refused", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ork-h4-token-env-"));
    try {
      const result = Bun.spawnSync([process.execPath, "-e", probe], {
        cwd,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: cwd,
          NODE_ENV: "test",
          CLAUDE_BRIDGE_TOKEN_SHA256: VERIFIER,
          CLAUDE_BRIDGE_NO_SERVER: "1",
        },
      });
      const stdout = result.stdout.toString();
      expect({
        exitCode: result.exitCode,
        stderr: result.exitCode === 0 ? "" : result.stderr.toString(),
      }).toEqual({ exitCode: 0, stderr: "" });
      expect(JSON.parse(stdout.slice(stdout.lastIndexOf("{")))).toEqual({
        env: null,
        token: true,
        verifier: false,
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
