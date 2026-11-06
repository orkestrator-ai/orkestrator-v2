/** Test-only stdio tap: the real app-server runs unchanged; only reload requests are counted. */
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { insideProfile } from "./mcp-fake-model-wiring";

export function observeCodexReloads(dataDir: string, runDir: string) {
  const binRoot = insideProfile(dataDir, path.join(dataDir, "toolchains", "bin"));
  const marker = path.join(runDir, "codex-reloads.jsonl");
  writeFileSync(marker, "", { mode: 0o600 });
  const originals: Array<{ link: string; target: string }> = [];
  const stop = () => {
    for (const { link, target } of originals.splice(0)) {
      rmSync(link);
      symlinkSync(target, link);
    }
  };
  try {
    for (const entry of readdirSync(binRoot)) {
      const link = path.join(binRoot, entry, "codex");
      if (!existsSync(link)) continue;
      if (!lstatSync(link).isSymbolicLink()) throw new Error("expected profile activation symlink");
      const target = readlinkSync(link);
      const binary = realpathSync(link);
      const wrapper = path.join(runDir, `codex-observed-${originals.length}.ts`);
      writeFileSync(
        wrapper,
        `#!${process.execPath}
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
const child = spawn(${JSON.stringify(binary)}, process.argv.slice(2), { stdio: ["pipe", "pipe", "inherit"] });
process.on("SIGTERM", () => child.kill("SIGTERM"));
process.on("SIGINT", () => child.kill("SIGINT"));
child.on("error", () => process.exit(1));
child.on("exit", code => process.exit(code ?? 1));
child.stdout.pipe(process.stdout);
createInterface({ input: process.stdin }).on("line", line => {
  const frame = JSON.parse(line);
  if (frame.method === "config/mcpServer/reload") {
    appendFileSync(${JSON.stringify(marker)}, JSON.stringify({ cwd: process.cwd() }) + "\\n");
  }
  if (!child.stdin.write(line + "\\n")) process.stdin.pause();
}).on("close", () => child.stdin.end());
child.stdin.on("drain", () => process.stdin.resume());
`,
        { mode: 0o700 },
      );
      rmSync(link);
      originals.push({ link, target });
      symlinkSync(wrapper, link);
    }
    if (!originals.length) throw new Error("profile has no Codex activation");
  } catch (error) {
    stop();
    throw error;
  }
  return {
    count(worktree: string) {
      return readFileSync(marker, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { cwd: string })
        .filter((row) => realpathSync(row.cwd) === realpathSync(worktree)).length;
    },
    stop,
  };
}
