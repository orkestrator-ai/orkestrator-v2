// Does Codex app-server report a skill disabled in config.toml as
// `enabled: false`, and which config files does it honour?
//
// Runs the pinned `codex app-server` with a disposable CODEX_HOME and a
// disposable git repository. Never touches ~/.codex and needs no sign-in:
// `skills/list` reads only the filesystem. Prints content-free JSON (names,
// scopes and enabled flags of the probe's own skills only).
//
//   CODEX_BIN=<path to codex 0.162.1> [CODEX_PROBE_TRUST_PROJECT=1] bun scripts/slash-probes/codex-disabled-skills-probe.mjs
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const codex = process.env.CODEX_BIN ?? "codex";
const root = realpathSync(mkdtempSync(join(tmpdir(), "codex-disabled-skills-")));
const home = join(root, "codex-home");
const repo = join(root, "repo");

function skill(dir, name) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "SKILL.md");
  writeFileSync(file, `---\nname: ${name}\ndescription: Probe skill ${name}.\n---\n\nReply OK.\n`);
  return file;
}

skill(join(home, "skills", "probe-user-on"), "probe-user-on");
const userOff = skill(join(home, "skills", "probe-user-off"), "probe-user-off");
mkdirSync(repo, { recursive: true });
spawnSync("git", ["init", "-q", repo]);
skill(join(repo, ".agents", "skills", "probe-project-on"), "probe-project-on");
const projectOffUser = skill(
  join(repo, ".agents", "skills", "probe-project-off-user"),
  "probe-project-off-user",
);
const projectOffProject = skill(
  join(repo, ".agents", "skills", "probe-project-off-project"),
  "probe-project-off-project",
);

// User config disables one user skill and one project skill by path.
writeFileSync(
  join(home, "config.toml"),
  [userOff, projectOffUser]
    .map((path) => `[[skills.config]]\npath = ${JSON.stringify(path)}\nenabled = false\n`)
    .join("\n"),
);
// CODEX_PROBE_TRUST_PROJECT=1 also trusts the repository, to show the project
// file is ignored either way.
if (process.env.CODEX_PROBE_TRUST_PROJECT === "1") {
  writeFileSync(
    join(home, "config.toml"),
    `\n[projects.${JSON.stringify(repo)}]\ntrust_level = "trusted"\n`,
    { flag: "a" },
  );
}
// Project config tries to disable another project skill the same way.
mkdirSync(join(repo, ".codex"), { recursive: true });
writeFileSync(
  join(repo, ".codex", "config.toml"),
  `[[skills.config]]\npath = ${JSON.stringify(projectOffProject)}\nenabled = false\n`,
);

const child = spawn(codex, ["app-server"], {
  cwd: repo,
  env: { ...process.env, CODEX_HOME: home },
  stdio: ["pipe", "pipe", "pipe"],
});
let buffer = "";
const waiting = new Map();
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.id !== undefined && waiting.has(message.id)) {
      waiting.get(message.id)(message);
      waiting.delete(message.id);
    }
  }
});
let nextId = 1;
function request(method, params) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 30_000);
    waiting.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) reject(new Error(`${method}: ${JSON.stringify(message.error)}`));
      else resolve(message.result);
    });
  });
}

try {
  const version = spawnSync(codex, ["--version"], { encoding: "utf8" }).stdout.trim();
  await request("initialize", { clientInfo: { name: "slash-probe", version: "0" } });
  child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
  const listed = await request("skills/list", { cwds: [repo], forceReload: true });
  const probeNames = new Set([
    "probe-user-on",
    "probe-user-off",
    "probe-project-on",
    "probe-project-off-user",
    "probe-project-off-project",
  ]);
  const skills = (listed?.data ?? [])
    .flatMap((entry) => entry.skills ?? [])
    .filter((row) => probeNames.has(row.name))
    .map((row) => ({ name: row.name, scope: row.scope, enabled: row.enabled }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const errors = (listed?.data ?? []).flatMap((entry) => entry.errors ?? []).length;
  console.log(JSON.stringify({ codex: version, skills, loadErrors: errors }, null, 2));
} finally {
  child.kill();
  rmSync(root, { recursive: true, force: true });
}
