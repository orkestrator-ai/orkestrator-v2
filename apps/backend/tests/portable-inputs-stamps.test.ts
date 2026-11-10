/**
 * The entrypoint's input stamps (`staged-inputs` 5): the real setup section of
 * `docker/entrypoint.sh` run twice or more against a revision staged from a
 * fixture home, with each mount rewritten to the staged directory it binds.
 * Fixture homes only; never the real provider directories.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { IMAGE_CAPABILITIES } from "@orkestrator/protocol/image-manifest";
import { gnuToolPath } from "../../../tests/unit/gnu-shell-tools";
import {
  replaceStagedInputFile,
  scrubStagedProvider,
  stagePortableInputs,
  stagedInputMountArguments,
} from "../src/core/portable-inputs";
import { buildMergeContainerClaudeCredentialCommand } from "../src/core/agent-accounts-containers";
import { tempDir } from "./container-lifecycle-fixtures";

const REPO = path.join(import.meta.dir, "../../..");
const entrypoint = await fs.readFile(path.join(REPO, "docker/entrypoint.sh"), "utf8");
const FUNCTIONS = [...entrypoint.matchAll(/^[a-z_]+\(\) \{[\s\S]*?^\}/gm)]
  .map((match) => match[0])
  .filter((body) => !/^(write_boot_status|on_entrypoint_exit)\(/.test(body))
  .join("\n");
const SETUP = entrypoint.slice(
  entrypoint.indexOf('log_progress "Setting up Claude Code configuration..."'),
  entrypoint.indexOf("# Verify the config file exists and is valid"),
);
if (!FUNCTIONS || !SETUP) throw new Error("Missing entrypoint setup section");

/** Longest first, so `/claude-config.json` is not read as `/claude-config`. */
const MOUNTS = [
  "/opencode-state/model.json",
  "/claude-config.json",
  "/opencode-config",
  "/claude-config",
  "/opencode-data",
  "/cursor-config",
  "/agents-skills",
  "/codex-home",
  "/grok-config",
  "/pi-config",
  "/grok-home",
];

async function write(file: string, content: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

const ENVIRONMENT = "env-stamps";

/**
 * Builds the fixture in `root`: a host home staged into a revision, an empty
 * container home and the setup script's helpers. Stamps and staged mounts hold
 * absolute paths, so a copy of this tree is only valid at the same `root`.
 */
async function buildFixture(root: string) {
  const hostHome = path.join(root, "host");
  const dataDir = path.join(root, "data");
  const files: Record<string, string> = {
    ".claude/CLAUDE.md": "memory one\n",
    ".claude/skills/review/SKILL.md": "---\nname: review\ndescription: d\n---\nReview.\n",
    ".claude/skills/review/scripts/run.sh": "echo run\n",
    ".claude/skills/other/SKILL.md": "---\nname: other\ndescription: d\n---\nOther.\n",
    ".claude/commands/one.md": "command one\n",
    ".codex/config.toml": "model = 'one'\n",
    ".codex/AGENTS.md": "agents one\n",
    ".codex/rules/default.rules": "allow\n",
    ".codex/skills/lint/SKILL.md": "---\nname: lint\ndescription: d\n---\nLint.\n",
    ".config/opencode/opencode.json": '{"model":"one"}\n',
    ".local/share/opencode/keep": "never staged\n",
    ".local/state/opencode/model.json": '{"recent":[]}\n',
    ".grok/config.toml": "model = 'one'\n",
    ".grok/xai-api-key": "fixture-key-not-real\n",
    ".grok/skills/fixture/SKILL.md": "---\nname: fixture\ndescription: d\n---\nGrok.\n",
    ".config/grok/settings.json": '{"one":true}\n',
    ".pi/agent/settings.json": '{"one":true}\n',
    ".pi/agent/skills/fixture/SKILL.md": "---\nname: fixture\ndescription: d\n---\nPi.\n",
    ".cursor/mcp.json": '{"mcpServers":{}}\n',
    ".agents/skills/shared/SKILL.md": "---\nname: shared\ndescription: d\n---\nShared.\n",
  };
  for (const [name, content] of Object.entries(files)) {
    await write(path.join(hostHome, name), content);
  }
  await write(path.join(hostHome, ".local/share/opencode/auth.json"), "{}");
  const staged = await stagePortableInputs(
    dataDir,
    ENVIRONMENT,
    new Set(["claude", "codex", "opencode", "grok", "pi", "cursor", "shared-skills"] as const),
    { home: hostHome, agentTest: false },
  );
  // What a real boot binds, plus a stage the logins below are written into.
  await fs.mkdir(path.join(staged.directory, "claude-config"), { recursive: true });
  const containerHome = path.join(root, "container-home");
  await fs.mkdir(containerHome);
  // The entrypoint's login filter runs under node. A version manager's shim
  // cannot find one with HOME pointed at the fixture, so this names a real one.
  const bin = path.join(root, "bin");
  await write(path.join(bin, "node"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`);
  await fs.chmod(path.join(bin, "node"), 0o755);
  const toolPath = `${bin}${path.delimiter}${gnuToolPath}`;
  const mountOf = (target: string) =>
    staged.mounts.find((mount) => mount.target === target)?.source ??
    path.join(root, "unmounted", target);
  const stage = (relative: string) => path.join(staged.directory, relative);

  const setScript = (options: { relay: string }) => {
    let setup = SETUP;
    for (const mount of MOUNTS) setup = setup.replaceAll(mount, mountOf(mount));
    setup = setup
      .replaceAll("/opencode-state", path.dirname(mountOf("/opencode-state/model.json")))
      .replaceAll("/tmp/orkestrator-codex-account", path.join(root, "codex-account"));
    return [
      "set -e",
      `STAGED_INPUT_RELAY_DIR=${JSON.stringify(options.relay)}`,
      'AGENT_COPY_SKIPPED=""',
      "sync() { :; }",
      FUNCTIONS,
      setup,
    ].join("\n");
  };

  async function boot(options: { relay?: string; path?: string; prelude?: string } = {}) {
    const progress = path.join(root, "progress");
    await fs.writeFile(progress, "");
    const result = Bun.spawnSync({
      cmd: [
        "bash",
        "-c",
        `${options.prelude ?? ""}\n${setScript({ relay: options.relay ?? path.join(root, "no-relay") })}`,
      ],
      env: {
        PATH: options.path ?? toolPath,
        HOME: containerHome,
        PROGRESS_FILE: progress,
        // The image sets a locale. Without one, Homebrew's bash restores the
        // locale after a `LC_ALL=C cmd` inside a subshell by asking
        // CoreFoundation for the user's languages, which is not fork-safe:
        // about one boot in ten crashed every stamp's ownership subshell
        // (SIGSEGV in libintl_setlocale), so no tree was stamped.
        LANG: "C.UTF-8",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) {
      throw new Error(`entrypoint failed: ${result.stderr.toString()}`);
    }
    const text = await fs.readFile(progress, "utf8");
    const counts = text.match(/Agent inputs: (\d+) unchanged, (\d+) copied/);
    if (!counts) throw new Error("Missing input counts");
    return { unchanged: Number(counts[1]), copied: Number(counts[2]), progress: text };
  }

  /** Inode and modification time of each file, which any copy changes. */
  async function identities(relative: string) {
    const out: Record<string, string> = {};
    const walk = async (current: string) => {
      const info = await fs.lstat(path.join(containerHome, current));
      if (info.isDirectory()) {
        for (const name of await fs.readdir(path.join(containerHome, current))) {
          await walk(path.join(current, name));
        }
      } else {
        out[current] = `${info.ino}:${info.mtimeMs}`;
      }
    };
    await walk(relative);
    return out;
  }

  const inHome = (relative: string) => path.join(containerHome, relative);
  const read = (relative: string) => fs.readFile(inHome(relative), "utf8");
  const exists = (relative: string) =>
    fs.lstat(inHome(relative)).then(
      () => true,
      () => false,
    );
  const replace = (relative: string, contents: string | undefined) =>
    replaceStagedInputFile(dataDir, ENVIRONMENT, staged.revision, relative, contents);

  return {
    root,
    dataDir,
    staged,
    containerHome,
    stage,
    boot,
    identities,
    inHome,
    read,
    exists,
    replace,
  };
}

type Fixture = Awaited<ReturnType<typeof buildFixture>>;
type Boot = Awaited<ReturnType<Fixture["boot"]>>;

/**
 * Every test works in the same `root`, restored before it from one of two
 * snapshots taken once per file: `fresh` (staged, never started) and `seeded`
 * (after the first, full-copy start). The seed start is the costliest boot,
 * and most tests begin with it. The path never changes because stamps are
 * keyed by absolute home paths and the staged mounts are absolute too.
 */
const shared: {
  root: string;
  fixture: Fixture;
  fresh: string;
  seeded: string;
  seed: Boot;
} = {} as never;

function copyTree(from: string, to: string) {
  // `cp -a` keeps modes and links exactly as the fixture made them.
  const copied = Bun.spawnSync({ cmd: ["cp", "-a", from, to], stderr: "pipe" });
  if (copied.exitCode !== 0) throw new Error(`cp failed: ${copied.stderr.toString()}`);
}

async function removeTree(dir: string) {
  await fs.chmod(dir, 0o700).catch(() => undefined);
  await fs.rm(dir, { recursive: true, force: true });
}

beforeAll(async () => {
  shared.root = await fs.realpath(await tempDir("ork-input-stamps-"));
  const snapshots = await fs.realpath(await tempDir("ork-input-stamps-snapshots-"));
  shared.fresh = path.join(snapshots, "fresh");
  shared.seeded = path.join(snapshots, "seeded");
  shared.fixture = await buildFixture(shared.root);
  copyTree(shared.root, shared.fresh);
  shared.seed = await shared.fixture.boot();
  copyTree(shared.root, shared.seeded);
}, 120_000);

afterAll(async () => {
  if (!shared.root) return;
  await removeTree(shared.root);
  await removeTree(path.dirname(shared.fresh));
});

/** The fixture restored to a snapshot: `seeded` has had its first start. */
async function fixture(state: "fresh" | "seeded" = "fresh") {
  await removeTree(shared.root);
  copyTree(state === "seeded" ? shared.seeded : shared.fresh, shared.root);
  return shared.fixture;
}

/** The fixture after its first start, and that start's counts. */
async function seeded() {
  return { f: await fixture("seeded"), first: shared.seed };
}

const STAMPED_FILES = [
  ".claude/CLAUDE.md",
  ".codex/config.toml",
  ".codex/AGENTS.md",
  ".grok/xai-api-key",
  ".pi/agent/settings.json",
  ".cursor/mcp.json",
  ".local/state/opencode/model.json",
];
const STAMPED_TREES = [
  ".claude/skills",
  ".claude/commands",
  ".codex/rules",
  ".codex/skills",
  ".config/opencode",
  ".grok/skills",
  ".config/grok",
  ".pi/agent/skills",
  ".agents/skills",
];

describe("a restart with unchanged inputs", () => {
  test("copies nothing, and what the first start imported is still there", async () => {
    const { f, first } = await seeded();
    expect(first.unchanged).toBe(0);
    expect(first.copied).toBeGreaterThanOrEqual(STAMPED_FILES.length + STAMPED_TREES.length);
    const before: Record<string, string> = {};
    for (const input of [...STAMPED_FILES, ...STAMPED_TREES]) {
      Object.assign(before, await f.identities(input));
    }
    expect(Object.keys(before).length).toBeGreaterThanOrEqual(16);

    const second = await f.boot();
    expect(second.copied).toBe(0);
    expect(second.unchanged).toBe(first.copied);
    const after: Record<string, string> = {};
    for (const input of [...STAMPED_FILES, ...STAMPED_TREES]) {
      Object.assign(after, await f.identities(input));
    }
    expect(after).toEqual(before);
    expect(await f.read(".claude/skills/review/scripts/run.sh")).toBe("echo run\n");
    expect(await f.read(".agents/skills/shared/SKILL.md")).toContain("Shared.");
  }, 60_000);

  test("a staged file rewritten with the same bytes is still unchanged", async () => {
    // The backend rewrites a revision's files in place before a start, so a
    // new inode and time on the mount say nothing about the content.
    const { f } = await seeded();
    expect(await f.replace("opencode-config/opencode.json", '{"model":"one"}\n')).toBe(true);
    expect((await f.boot()).copied).toBe(0);
  }, 60_000);

  test("the relay's fresh copy of unchanged mounts is still unchanged", async () => {
    const f = await fixture();
    const relay = path.join(f.root, "relay");
    const rebuildRelay = async () => {
      await fs.rm(relay, { recursive: true, force: true });
      await fs.mkdir(path.dirname(path.join(relay, f.stage("codex-home"))), { recursive: true });
      await fs.cp(f.stage("codex-home"), path.join(relay, f.stage("codex-home")), {
        recursive: true,
      });
    };
    await rebuildRelay();
    await f.boot({ relay });
    const before = await f.identities(".codex/skills");
    await rebuildRelay();
    expect((await f.boot({ relay })).copied).toBe(0);
    expect(await f.identities(".codex/skills")).toEqual(before);

    // ...and an input removed from the relayed copy leaves the home.
    await rebuildRelay();
    await fs.rm(path.join(relay, f.stage("codex-home"), "skills", "lint"), { recursive: true });
    await f.boot({ relay });
    expect(await f.exists(".codex/skills/lint")).toBe(false);
  }, 60_000);
});

describe("a changed input is reflected at the next start", () => {
  test("changing one file in a tree copies that tree alone", async () => {
    const { f } = await seeded();
    const unrelated = await f.identities(".codex/skills");
    await write(f.stage("claude-config/skills/review/SKILL.md"), "changed skill\n");

    const next = await f.boot();
    expect(next.copied).toBe(1);
    expect(await f.read(".claude/skills/review/SKILL.md")).toBe("changed skill\n");
    expect(await f.identities(".codex/skills")).toEqual(unrelated);
    expect((await f.boot()).copied).toBe(0);
  }, 60_000);

  test("changing one single-file input", async () => {
    const { f } = await seeded();
    expect(await f.replace("codex-home/config.toml", "model = 'two'\n")).toBe(true);
    const next = await f.boot();
    expect(next.copied).toBe(1);
    expect(await f.read(".codex/config.toml")).toBe("model = 'two'\n");
  }, 60_000);

  test("adding one input, to a tree and as a file that was absent", async () => {
    const { f } = await seeded();
    expect(await f.exists(".claude/skills/added")).toBe(false);
    await write(f.stage("claude-config/skills/added/SKILL.md"), "added skill\n");
    await write(f.stage("codex-home/hooks.json"), "{}\n");
    await f.boot();
    expect(await f.read(".claude/skills/added/SKILL.md")).toBe("added skill\n");
    expect(await f.read(".codex/hooks.json")).toBe("{}\n");
  }, 60_000);

  test("removing one input takes only that input out of the home", async () => {
    const { f } = await seeded();
    // The container's own state beside the imports is not an input.
    await write(f.inHome(".claude/skills/review/own-notes.md"), "mine\n");
    await write(f.inHome(".claude/skills/made-here/SKILL.md"), "made here\n");
    await write(f.inHome(".codex/own-state.json"), "{}\n");

    await fs.rm(f.stage("claude-config/skills/review/scripts"), { recursive: true });
    await fs.rm(f.stage("claude-config/skills/other"), { recursive: true });
    await fs.rm(f.stage("claude-config/CLAUDE.md"));
    await fs.rm(f.stage("codex-home/rules"), { recursive: true });
    await fs.rm(f.stage("codex-home/AGENTS.md"));
    await f.boot();

    expect(await f.exists(".claude/skills/review/scripts")).toBe(false);
    expect(await f.exists(".claude/skills/other")).toBe(false);
    expect(await f.exists(".claude/CLAUDE.md")).toBe(false);
    expect(await f.exists(".codex/rules")).toBe(false);
    expect(await f.exists(".codex/AGENTS.md")).toBe(false);
    // What stayed in the mount, and what the container made, are untouched.
    expect(await f.read(".claude/skills/review/SKILL.md")).toContain("Review.");
    expect(await f.read(".claude/skills/review/own-notes.md")).toBe("mine\n");
    expect(await f.read(".claude/skills/made-here/SKILL.md")).toBe("made here\n");
    expect(await f.read(".codex/own-state.json")).toBe("{}\n");
    expect(await f.read(".codex/config.toml")).toBe("model = 'one'\n");
  }, 60_000);

  test("a file that never came from an input is never removed", async () => {
    const f = await fixture();
    await write(f.inHome(".codex/hooks.json"), "the container's own\n");
    await f.boot();
    await f.boot();
    expect(await f.read(".codex/hooks.json")).toBe("the container's own\n");
  }, 60_000);

  test("a revocation's scrub empties the home of that provider's inputs", async () => {
    const { f } = await seeded();
    expect(await scrubStagedProvider(f.dataDir, ENVIRONMENT, f.staged.revision, "pi")).toBe(true);
    await expect(fs.stat(f.stage("pi-config/agent"))).rejects.toThrow();
    await f.boot();
    expect(await f.exists(".pi/agent/settings.json")).toBe(false);
    expect(await f.exists(".pi/agent/skills/fixture")).toBe(false);
    expect(await f.read(".codex/config.toml")).toBe("model = 'one'\n");
  }, 60_000);

  test("the container's own state beside an input does not stop the skip", async () => {
    const { f } = await seeded();
    // OpenCode's own Linux install, with the links a package manager makes.
    await write(f.inHome(".config/opencode/node_modules/pkg/cli.js"), "cli\n");
    await fs.mkdir(f.inHome(".config/opencode/node_modules/.bin"));
    await fs.symlink("../pkg/cli.js", f.inHome(".config/opencode/node_modules/.bin/cli"));
    await write(f.inHome(".codex/skills/.system/SKILL.md"), "the CLI's own\n");
    expect((await f.boot()).copied).toBe(0);
    expect(await f.read(".config/opencode/node_modules/pkg/cli.js")).toBe("cli\n");
    expect(await f.read(".codex/skills/.system/SKILL.md")).toBe("the CLI's own\n");
  }, 60_000);

  test("a mount node cannot open is not a removal", async () => {
    if (process.getuid?.() === 0) return;
    const { f } = await seeded();
    await fs.chmod(f.stage("codex-home"), 0o000);
    try {
      await f.boot();
    } finally {
      await fs.chmod(f.stage("codex-home"), 0o700);
    }
    expect(await f.read(".codex/config.toml")).toBe("model = 'one'\n");
    expect(await f.read(".codex/rules/default.rules")).toBe("allow\n");
    // Still remembered: once readable again it is simply unchanged.
    expect((await f.boot()).copied).toBe(0);
  }, 60_000);
});

describe("what the home holds decides as much as what the stamp says", () => {
  test("an edited or deleted import comes back, as a full copy would bring it", async () => {
    const { f } = await seeded();
    await fs.writeFile(f.inHome(".claude/skills/review/SKILL.md"), "tampered\n");
    await fs.rm(f.inHome(".codex/rules/default.rules"));
    await fs.rm(f.inHome(".pi/agent/settings.json"));
    await fs.writeFile(f.inHome(".codex/config.toml"), "edited in the container\n");

    const next = await f.boot();
    expect(next.copied).toBe(4);
    expect(await f.read(".claude/skills/review/SKILL.md")).toContain("Review.");
    expect(await f.read(".codex/rules/default.rules")).toBe("allow\n");
    expect(await f.read(".pi/agent/settings.json")).toBe('{"one":true}\n');
    expect(await f.read(".codex/config.toml")).toBe("model = 'one'\n");
  }, 60_000);

  test("a stamp forged to match new inputs cannot keep the old input", async () => {
    const { f } = await seeded();
    await write(f.stage("claude-config/skills/review/SKILL.md"), "the new skill\n");
    const stampDir = f.inHome(".orkestrator-inputs");
    const stamp = path.join(stampDir, `${f.inHome(".claude/skills")}`.replaceAll("/", "%2F"));
    const forged = Bun.spawnSync({
      cmd: [
        "bash",
        "-c",
        `${FUNCTIONS}\nagent_input_manifest "$1" skills "" "$2"`,
        "forge",
        f.stage("claude-config"),
        stamp,
      ],
      env: { PATH: gnuToolPath },
    });
    expect(forged.exitCode).toBe(0);
    await f.boot();
    expect(await f.read(".claude/skills/review/SKILL.md")).toBe("the new skill\n");
  }, 60_000);

  test("a damaged stamp falls back to the copy", async () => {
    const { f } = await seeded();
    const stampDir = f.inHome(".orkestrator-inputs");
    for (const name of await fs.readdir(stampDir)) {
      const stamp = path.join(stampDir, name);
      if (!(await fs.stat(stamp)).isDirectory()) continue;
      await fs.writeFile(path.join(stamp, "sums"), "not a digest\n");
      await fs.writeFile(path.join(stamp, "paths"), "garbage");
    }
    const next = await f.boot();
    expect(next.copied).toBe(STAMPED_TREES.length);
    expect((await f.boot()).copied).toBe(0);
  }, 60_000);

  test("without the hashing tools every tree is copied", async () => {
    const f = await fixture();
    const bin = path.join(f.root, "bin");
    await write(path.join(bin, "sha256sum"), "#!/bin/sh\nexit 127\n");
    await fs.chmod(path.join(bin, "sha256sum"), 0o755);
    const brokenPath = `${bin}${path.delimiter}${gnuToolPath}`;
    await f.boot({ path: brokenPath });
    await fs.rm(f.inHome(".codex/rules/default.rules"));
    const next = await f.boot({ path: brokenPath });
    expect(next.copied).toBe(STAMPED_TREES.length);
    expect(await f.read(".codex/rules/default.rules")).toBe("allow\n");
  }, 60_000);
});

const LOGINS = [
  {
    name: "Claude",
    staged: "claude-config/.credentials.json",
    home: ".claude/.credentials.json",
    one: '{"claudeAiOauth":{"accessToken":"token-one","refreshToken":"host-refresh"}}',
    two: '{"claudeAiOauth":{"accessToken":"token-two","refreshToken":"host-refresh"}}',
  },
  {
    name: "Codex",
    staged: "codex-home/auth.json",
    home: ".codex/auth.json",
    one: '{"tokens":{"access_token":"token-one","refresh_token":"host-refresh"}}',
    two: '{"tokens":{"access_token":"token-two","refresh_token":"host-refresh"}}',
  },
  {
    name: "Grok",
    staged: "grok-home/auth.json",
    home: ".grok/auth.json",
    one: '{"account":{"access_token":"token-one","refresh_token":"host-refresh"}}',
    two: '{"account":{"access_token":"token-two","refresh_token":"host-refresh"}}',
  },
  {
    name: "OpenCode",
    staged: "opencode-data/auth.json",
    home: ".local/share/opencode/auth.json",
    one: '{"anthropic":{"type":"oauth","access":"token-one","refresh":"host-refresh"}}',
    two: '{"anthropic":{"type":"oauth","access":"token-two","refresh":"host-refresh"}}',
  },
  {
    name: "Pi",
    staged: "pi-config/agent/auth.json",
    home: ".pi/agent/auth.json",
    one: '{"anthropic":{"type":"oauth","access":"token-one","refresh":"host-refresh"}}',
    two: '{"anthropic":{"type":"oauth","access":"token-two","refresh":"host-refresh"}}',
  },
] as const;

/**
 * Each provider's login lives in its own home tree and its own stamp, so one
 * sequence of starts rotates or signs out every login at once. Results are
 * keyed by provider so a failure names the one that broke.
 */
type Login = (typeof LOGINS)[number];
async function perLogin<T>(logins: readonly Login[], check: (login: Login) => Promise<T>) {
  const results: Record<string, T> = {};
  for (const login of logins) results[login.name] = await check(login);
  return results;
}
const forEveryLogin = <T>(logins: readonly Login[], value: T) =>
  Object.fromEntries(logins.map((login) => [login.name, value]));

async function replaceLogins(
  f: Fixture,
  logins: readonly Login[],
  contents: (login: Login) => string | undefined,
) {
  expect(await perLogin(logins, (login) => f.replace(login.staged, contents(login)))).toEqual(
    forEveryLogin(logins, true),
  );
}

/** Nothing about a login goes into the stamps but a digest. */
async function expectNoLoginInStamps(f: Fixture) {
  for (const name of await fs.readdir(f.inHome(".orkestrator-inputs"))) {
    const info = await fs.stat(path.join(f.inHome(".orkestrator-inputs"), name));
    if (info.isFile()) {
      const stamp = await fs.readFile(path.join(f.inHome(".orkestrator-inputs"), name), "utf8");
      expect(stamp).not.toContain("token-");
    }
  }
}

describe("logins", () => {
  test("every provider: a rotation and then a sign-out reach the home", async () => {
    const f = await fixture();
    const holds = (token: string) => (login: Login) =>
      f.read(login.home).then((text) => text.includes(token));
    await replaceLogins(f, LOGINS, (login) => login.one);
    await f.boot();
    expect(await perLogin(LOGINS, holds("token-one"))).toEqual(forEveryLogin(LOGINS, true));
    // Credential filtering is unchanged: the host's refresh token stays out.
    expect(await perLogin(LOGINS, holds("host-refresh"))).toEqual(forEveryLogin(LOGINS, false));

    // Nothing else changed, and each login is still imported, not skipped.
    await f.boot();
    expect(await perLogin(LOGINS, holds("token-one"))).toEqual(forEveryLogin(LOGINS, true));
    expect(await perLogin(LOGINS, holds("host-refresh"))).toEqual(forEveryLogin(LOGINS, false));

    await replaceLogins(f, LOGINS, (login) => login.two);
    expect((await f.boot()).copied).toBe(0);
    expect(await perLogin(LOGINS, holds("token-two"))).toEqual(forEveryLogin(LOGINS, true));
    expect(await perLogin(LOGINS, holds("token-one"))).toEqual(forEveryLogin(LOGINS, false));
    await expectNoLoginInStamps(f);

    await replaceLogins(f, LOGINS, () => undefined);
    await f.boot();
    expect(await perLogin(LOGINS, (login) => f.exists(login.home))).toEqual(
      forEveryLogin(LOGINS, false),
    );
    await expectNoLoginInStamps(f);
  }, 60_000);

  test("every provider: a sign-out leaves a login made or pushed since the import", async () => {
    const f = await fixture();
    await replaceLogins(f, LOGINS, (login) => login.one);
    await f.boot();
    // The backend's push, or a sign-in inside the container, wrote these. The
    // backend's own paths own them, and they race this script.
    for (const login of LOGINS) {
      await fs.writeFile(f.inHome(login.home), login.two.replace("host-refresh", ""));
    }
    await replaceLogins(f, LOGINS, () => undefined);
    await f.boot();
    expect(
      await perLogin(LOGINS, (login) =>
        f.read(login.home).then((text) => text.includes("token-two")),
      ),
    ).toEqual(forEveryLogin(LOGINS, true));
  }, 60_000);

  test("a login is never planted through a link at its destination", async () => {
    const f = await fixture();
    const outside = path.join(f.root, "outside.json");
    await fs.writeFile(outside, "outside\n");
    expect(await f.replace("codex-home/auth.json", '{"OPENAI_API_KEY":"k"}')).toBe(true);
    await f.boot();
    await fs.rm(f.inHome(".codex/auth.json"));
    await fs.symlink(outside, f.inHome(".codex/auth.json"));
    await f.boot();
    expect(await fs.readFile(outside, "utf8")).toBe("outside\n");
  }, 60_000);
});

describe("link safety", () => {
  test("a link planted at an imported path stays out of the skip and is not written through", async () => {
    const { f } = await seeded();
    const outside = path.join(f.root, "outside.md");
    await fs.writeFile(outside, "the same bytes\n");
    await write(f.stage("claude-config/skills/review/SKILL.md"), "the same bytes\n");
    await f.boot();
    await fs.rm(f.inHome(".claude/skills/review/SKILL.md"));
    // Same content as the input, so only the link check can catch it.
    await fs.symlink(outside, f.inHome(".claude/skills/review/SKILL.md"));
    const next = await f.boot();
    expect(next.copied).toBe(1);
    expect(next.progress).toContain("destination symlink");
    expect(await fs.readFile(outside, "utf8")).toBe("the same bytes\n");
    // It warned, so it is not stamped as complete and warns at every start.
    expect((await f.boot()).progress).toContain("destination symlink");
  }, 60_000);

  test("a linked parent of an import is caught too", async () => {
    const { f } = await seeded();
    const moved = path.join(f.root, "moved-skills");
    await fs.cp(f.inHome(".codex/rules"), moved, { recursive: true });
    await fs.rm(f.inHome(".codex/rules"), { recursive: true });
    await fs.symlink(moved, f.inHome(".codex/rules"));
    const next = await f.boot();
    expect(next.progress).toContain("symlinked destination");
    expect(await fs.readdir(moved)).toEqual(["default.rules"]);
  }, 60_000);

  test("a linked stamp directory is replaced, never written through", async () => {
    const f = await fixture();
    const outside = path.join(f.root, "outside-stamps");
    await fs.mkdir(outside);
    await fs.symlink(outside, f.inHome(".orkestrator-inputs"));
    await f.boot();
    expect(await fs.readdir(outside)).toEqual([]);
    expect((await fs.lstat(f.inHome(".orkestrator-inputs"))).isSymbolicLink()).toBe(false);
    expect((await f.boot()).copied).toBe(0);
  }, 60_000);

  test("a stamp listing a path outside the home removes nothing outside it", async () => {
    const { f } = await seeded();
    const outside = path.join(f.root, "outside.txt");
    await fs.writeFile(outside, "keep\n");
    const stamp = path.join(
      f.inHome(".orkestrator-inputs"),
      f.inHome(".codex/skills").replaceAll("/", "%2F"),
    );
    const escape = path.relative(f.inHome(".codex"), outside);
    await fs.writeFile(path.join(stamp, "paths"), `f${escape}\0`);
    await f.boot();
    expect(await fs.readFile(outside, "utf8")).toBe("keep\n");
    expect(await f.read(".codex/skills/lint/SKILL.md")).toContain("Lint.");
  }, 60_000);

  test("a source link the backend would never stage is reported at every start", async () => {
    const f = await fixture();
    await fs.symlink(f.root, f.stage("claude-config/skills/escape"));
    for (let start = 0; start < 2; start += 1) {
      const result = await f.boot();
      expect(result.progress).toContain("Skipping symlinked Claude entry: skills/escape");
      expect(await f.exists(".claude/skills/escape")).toBe(false);
    }
  }, 60_000);
});

describe("older images", () => {
  test("the capability is declared, and the backend gives the stamp nothing", async () => {
    expect(IMAGE_CAPABILITIES["staged-inputs"]).toBe(5);
    expect(entrypoint).toContain("# ORKESTRATOR_CAPABILITY staged-inputs=5");
    // The whole feature is in the image's own entrypoint. The backend binds the
    // same read-only mounts whatever the image, so an older image's entrypoint
    // keeps doing what it always did: copy everything on every start.
    const f = await fixture();
    for (const argument of stagedInputMountArguments(f.staged)) {
      if (argument !== "--mount") {
        expect(argument).toMatch(/^type=bind,src=.*,dst=\/[^,]+,readonly$/);
      }
    }
    const backend = new Bun.Glob("**/*.ts").scan({
      cwd: path.join(REPO, "apps/backend/src"),
      absolute: true,
    });
    for await (const file of backend) {
      expect(await fs.readFile(file, "utf8")).not.toContain(".orkestrator-inputs");
    }
  }, 60_000);
});

describe("import ownership failures", () => {
  test("refused trees and files never claim local files", async () => {
    const f = await fixture();
    await write(f.inHome(".claude/skills/review/SKILL.md"), "local skill");
    await fs.symlink(f.root, f.inHome(".claude/skills/review/link"));
    // A directory at a single-file destination refuses that import too.
    await fs.mkdir(f.inHome(".codex/AGENTS.md"), { recursive: true });
    expect((await f.boot()).progress).toContain("destination symlink");
    await fs.rm(f.stage("claude-config/skills/review"), { recursive: true });
    await f.replace("codex-home/AGENTS.md", undefined);
    await fs.rm(f.inHome(".codex/AGENTS.md"), { recursive: true });
    await write(f.inHome(".codex/AGENTS.md"), "local agents");
    await f.boot();
    expect(await f.read(".claude/skills/review/SKILL.md")).toBe("local skill");
    expect(await f.read(".codex/AGENTS.md")).toBe("local agents");
  }, 60_000);

  // Claude's login is merged, not copied, so it has no copy to fail. The other
  // logins live in separate trees, and each failure mode refuses all of them
  // at once, so one sequence of starts covers every provider.
  const COPIED_LOGINS = LOGINS.filter((entry) => entry.name !== "Claude");
  for (const failure of ["cp", "oversized"]) {
    test(`every copied login: ${failure} login imports never own a local credential`, async () => {
      const f = await fixture();
      await replaceLogins(f, COPIED_LOGINS, (login) => login.one);
      const local = (login: Login) => JSON.parse(login.two.replace("host-refresh", ""));
      for (const login of COPIED_LOGINS) {
        await write(f.inHome(login.home), JSON.stringify(local(login)));
      }
      const prelude =
        failure === "cp"
          ? `cp() { case "$1" in */auth.json) return 1;; *) command cp "$@";; esac; }`
          : "AGENT_COPY_MAX_FILE_BYTES=1";
      const stampOf = (login: Login) =>
        f.inHome(
          `.orkestrator-inputs/${f.inHome(login.home).replaceAll("%", "%25").replaceAll("/", "%2F")}`,
        );
      const inHome = (login: Login) =>
        f.read(login.home).then((text) => {
          const actual = JSON.parse(text);
          delete actual.last_refresh;
          return actual;
        });
      const expected = Object.fromEntries(COPIED_LOGINS.map((login) => [login.name, local(login)]));
      for (let boot = 0; boot < 2; boot++) {
        await f.boot({ prelude });
        expect(await perLogin(COPIED_LOGINS, inHome)).toEqual(expected);
        expect(
          await perLogin(COPIED_LOGINS, (login) =>
            fs.access(stampOf(login)).then(
              () => true,
              () => false,
            ),
          ),
        ).toEqual(forEveryLogin(COPIED_LOGINS, false));
      }
      await replaceLogins(f, COPIED_LOGINS, () => undefined);
      await f.boot();
      expect(await perLogin(COPIED_LOGINS, inHome)).toEqual(expected);
    }, 60_000);
  }

  // Each tree has its own stamp, and Claude's and Codex's skills go through the
  // same import helper, so one start checks a damaged `paths` and `sums` apiece.
  const stampOfTree = (f: Fixture, relative: string) =>
    f.inHome(
      `.orkestrator-inputs/${f.inHome(relative).replaceAll("%", "%25").replaceAll("/", "%2F")}`,
    );
  const DAMAGED_STAMPS = [
    {
      leaf: "paths",
      tree: ".claude/skills",
      staged: "claude-config/skills/review/SKILL.md",
      home: ".claude/skills/review/SKILL.md",
    },
    {
      leaf: "sums",
      tree: ".codex/skills",
      staged: "codex-home/skills/lint/SKILL.md",
      home: ".codex/skills/lint/SKILL.md",
    },
  ] as const;
  const changedImports = async (f: Fixture) => {
    const imported: Record<string, string> = {};
    for (const { leaf, home } of DAMAGED_STAMPS) imported[leaf] = await f.read(home);
    return imported;
  };
  const allChanged = Object.fromEntries(DAMAGED_STAMPS.map(({ leaf }) => [leaf, "changed skill"]));

  test("linked paths and sums stamps cannot block changed tree imports", async () => {
    const { f } = await seeded();
    for (const { leaf, tree, staged } of DAMAGED_STAMPS) {
      const stamp = stampOfTree(f, tree);
      await fs.rm(path.join(stamp, leaf));
      await fs.symlink(path.join(f.root, "unreadable-missing"), path.join(stamp, leaf));
      await write(f.stage(staged), "changed skill");
    }
    await f.boot();
    expect(await changedImports(f)).toEqual(allChanged);
  }, 60_000);

  test("unreadable paths and sums stamps cannot block changed tree imports", async () => {
    const { f } = await seeded();
    for (const { leaf, tree, staged } of DAMAGED_STAMPS) {
      await fs.chmod(path.join(stampOfTree(f, tree), leaf), 0);
      await write(f.stage(staged), "changed skill");
    }
    await f.boot();
    expect(await changedImports(f)).toEqual(allChanged);
    // Clear damaged metadata as the owner, then prove a later boot retries.
    for (const { tree } of DAMAGED_STAMPS) {
      await fs.rm(stampOfTree(f, tree), { recursive: true, force: true });
    }
    await f.boot();
    expect((await f.boot()).copied).toBe(0);
  }, 60_000);

  test("unreadable ownership bookkeeping is retried without blocking boot", async () => {
    const { f } = await seeded();
    await write(f.stage("claude-config/skills/review/SKILL.md"), "changed skill");
    // Force a read failure even when the suite runs as root.
    const prelude = `comm() { return 1; }`;
    expect((await f.boot({ prelude })).progress).toContain("will retry");
    expect(await f.read(".claude/skills/review/SKILL.md")).toBe("changed skill");
    await f.boot();
    expect((await f.boot()).copied).toBe(0);
  }, 60_000);

  test("failed removals keep their stamps for retry: a file, a tree entry, a whole missing tree", async () => {
    const { f } = await seeded();
    // Each removal is a different input with its own stamp: a single file, one
    // entry gone from a tree, and a tree whose whole mount directory is gone.
    const REMOVALS = [
      { home: ".codex/AGENTS.md", warning: "AGENTS.md" },
      { home: ".claude/skills/review/SKILL.md", warning: "skills/review/SKILL.md" },
      { home: ".codex/skills/lint/SKILL.md", warning: "skills/lint/SKILL.md" },
    ];
    await f.replace("codex-home/AGENTS.md", undefined);
    await fs.rm(f.stage("claude-config/skills/review/SKILL.md"));
    await fs.rm(f.stage("codex-home/skills"), { recursive: true });
    // A deterministic failed rm, independent of whether the runner is root.
    const failing = REMOVALS.map(({ home }) => `*'${home}'*`).join("|");
    const prelude = `rm() { case "$*" in ${failing}) return 1;; *) command rm "$@";; esac; }`;
    const failed = await f.boot({ prelude });
    const retried = (warning: string) =>
      failed.progress.includes(`Failed to remove imported input; will retry: ${warning}`);
    expect(Object.fromEntries(REMOVALS.map(({ warning }) => [warning, retried(warning)]))).toEqual(
      Object.fromEntries(REMOVALS.map(({ warning }) => [warning, true])),
    );
    const present = async () => {
      const out: Record<string, boolean> = {};
      for (const { home } of REMOVALS) out[home] = await f.exists(home);
      return out;
    };
    expect(await present()).toEqual(Object.fromEntries(REMOVALS.map(({ home }) => [home, true])));
    await f.boot();
    expect(await present()).toEqual(Object.fromEntries(REMOVALS.map(({ home }) => [home, false])));
    // Inputs beside the failed removals are untouched.
    expect(await f.read(".claude/CLAUDE.md")).toBe("memory one\n");
    expect(await f.read(".codex/config.toml")).toBe("model = 'one'\n");
  }, 60_000);

  test("backend publication waits for cleanup and is never attributed to the import", async () => {
    const f = await fixture();
    const login = LOGINS.find((entry) => entry.name === "Claude") ?? LOGINS[0]!;
    await f.replace(login.staged, login.one);
    await f.boot();
    const file = f.inHome(".claude/.credentials.json");
    const script = buildMergeContainerClaudeCredentialCommand(file);
    // Publish from inside the digest calculation: it must wait for the
    // entrypoint transaction to release the lock before replacing the file.
    const payload = JSON.stringify({ login: { claudeAiOauth: { accessToken: "fresh-backend" } } });
    const publisher = path.join(f.root, "publish.sh");
    await write(publisher, script);
    const done = path.join(f.root, "published");
    const once = path.join(f.root, "started");
    const prelude = `sha256sum() {
      if [ "$#" -eq 0 ] && [ ! -e '${once}' ]; then
        touch '${once}'
        (printf '%s' '${payload}' | bash '${publisher}'; touch '${done}') 9>&- >/dev/null 2>&1 &
      fi
      command sha256sum "$@"
    }`;
    await f.boot({ prelude });
    for (let i = 0; i < 200 && !(await fs.exists(done)); i++) await Bun.sleep(10);
    expect(await fs.exists(done)).toBe(true);
    expect(await f.read(".claude/.credentials.json")).toContain("fresh-backend");
    await f.replace(login.staged, undefined);
    await f.boot();
    expect(await f.read(".claude/.credentials.json")).toContain("fresh-backend");
  }, 60_000);
});
