import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const entrypoint = readFileSync(path.join(import.meta.dir, "../../docker/entrypoint.sh"), "utf8");
const helpers = [
  "log_progress",
  "agent_copy_warn",
  "report_agent_copy_skips",
  "agent_source_path_has_symlink",
  "agent_destination_path_has_symlink",
  "copy_agent_file",
  "copy_agent_directory",
  "restrict_imported_login",
]
  .map((name) => {
    const body = entrypoint.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, "m"))?.[0];
    if (!body) throw new Error(`Missing entrypoint helper: ${name}`);
    return body;
  })
  .join("\n");
const codexSetup = entrypoint.match(
  /^# Set up Codex configuration\n[\s\S]*?^log_progress "Codex configuration ready"$/m,
)?.[0];
if (!codexSetup) throw new Error("Missing Codex entrypoint setup");
const setup = codexSetup
  .replaceAll("/codex-home", '"$TEST_SOURCE"')
  .replaceAll("/tmp/orkestrator-codex-account", '"$TEST_MARKER"');

describe("entrypoint account marker hand-off without a backend", () => {
  for (const markerWritable of [true, false]) {
    test(`a failed boot cannot leave an imported login certified by an old marker (marker writable=${markerWritable})`, () => {
      const root = mkdtempSync(path.join(tmpdir(), "ork-account-marker-"));
      const home = path.join(root, "home");
      const source = path.join(root, "source");
      const marker = path.join(root, "marker");
      const installed = path.join(home, ".codex/auth.json");
      try {
        mkdirSync(path.dirname(installed), { recursive: true });
        mkdirSync(source);
        writeFileSync(installed, '{"OPENAI_API_KEY":"previous"}');
        writeFileSync(path.join(source, "auth.json"), '{"OPENAI_API_KEY":"new"}');
        if (markerWritable) writeFileSync(marker, "previous-account");
        else mkdirSync(marker);
        const result = Bun.spawnSync({
          cmd: [
            "bash",
            "-c",
            `set -e
${helpers}
# Fail after auth was copied, before setup can complete or readiness is published.
restrict_imported_login() { return 31; }
${setup}`,
          ],
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            HOME: home,
            PROGRESS_FILE: "/dev/null",
            TEST_SOURCE: source,
            TEST_MARKER: marker,
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        if (markerWritable) {
          expect(result.exitCode).toBe(31);
          expect(readFileSync(installed, "utf8")).toBe('{"OPENAI_API_KEY":"new"}');
          expect(readFileSync(marker, "utf8")).toBe("unstaged");
        } else {
          expect(result.exitCode).not.toBe(0);
          // Failing to invalidate must abort before importing another account.
          expect(readFileSync(installed, "utf8")).toBe('{"OPENAI_API_KEY":"previous"}');
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
