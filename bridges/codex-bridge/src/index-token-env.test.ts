/**
 * The bridge token leaves `process.env` at startup (security H4).
 *
 * The token authenticates callers of this bridge. Left in `process.env`, every
 * process the bridge spawns (the agent, its shells, MCP servers) would inherit
 * it, and the agent could then call the bridge to answer its own approvals.
 * Runs the module in a fresh process: module-load side effects cannot be
 * re-run in one that has already imported it.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const TOKEN_ENV = "CODEX_BRIDGE_TOKEN";
const PROBE_TOKEN = "h4-probe-token";
const moduleUrl = pathToFileURL(join(import.meta.dir, "index.ts")).href;

const probe = `
const mod = await import(${JSON.stringify(moduleUrl)});
// node:child_process's default env, which the agent SDKs spawn with. (Bun.spawn
// with no env option reads the startup environ instead, so it would still pass
// the token on; no bridge spawns that way.)
const { spawnSync } = await import("node:child_process");
const child = spawnSync(process.execPath, ["-e", "process.stdout.write(process.env.${TOKEN_ENV} ?? '')"]);
const status = async (token) => (await mod.app.request("/session/h4-probe/activity", { headers: { Authorization: "Bearer " + token } })).status;
const usesToken = (await status("h4-probe-token")) !== 401 && (await status("wrong-token")) === 401;
process.stdout.write(JSON.stringify({
  parent: process.env.${TOKEN_ENV} ?? null,
  child: String(child.stdout),
  usesToken,
}));
process.exit(0);
`;

describe("Codex bridge token", () => {
  test("is captured for authentication, then removed from process.env before anything is spawned", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ork-h4-token-env-"));
    try {
      const result = Bun.spawnSync([process.execPath, "-e", probe], {
        cwd,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: cwd,
          NODE_ENV: "test",
          [TOKEN_ENV]: PROBE_TOKEN,
          CWD: cwd,
          CODEX_HOME: cwd,
          CODEX_BRIDGE_NO_ENGINE: "1",
          CODEX_BRIDGE_NO_SERVER: "1",
        },
      });
      const stdout = result.stdout.toString();
      expect({
        exitCode: result.exitCode,
        stderr: result.exitCode === 0 ? "" : result.stderr.toString(),
      }).toEqual({ exitCode: 0, stderr: "" });
      expect(JSON.parse(stdout.slice(stdout.lastIndexOf("{")))).toEqual({
        parent: null,
        child: "",
        usesToken: true,
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
