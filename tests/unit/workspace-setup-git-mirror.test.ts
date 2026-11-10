/**
 * The setup script's clone from a project's Git mirror, running its real
 * functions against real repositories. The remote is a `file://` URL, whose
 * `upload-pack` runs a logging `uploadpack.packObjectsHook` whenever it has to
 * send objects, so a test can tell what came from the remote.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The template setup runs about a dozen real Git processes once (two inits, a
// clone, two commit-and-push rounds over `file://` and a mirror fetch); each
// case copies it and then clones for real. A saturated aggregate once pushed
// the per-case setup past Bun's generic five seconds (flake case 6081). Bun
// applies this file-scoped budget to the hooks as well.
setDefaultTimeout(30_000);

const repoRoot = join(import.meta.dir, "..", "..");
const setupScript = join(repoRoot, "docker", "workspace-setup.sh");

let root: string;
let remote: string;
let remoteUrl: string;
let mirror: string;
let work: string;
let packLog: string;
let gitEnv: NodeJS.ProcessEnv;

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: gitEnv });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function commit(name: string, content: string): void {
  writeFileSync(join(work, name), content);
  git(work, ["add", "."]);
  git(work, ["commit", "-qm", `change ${name}`]);
  git(work, ["push", "-q", "origin", "main"]);
}

/** Built the way the backend builds one, including its branches-only refspec. */
function buildMirror(extraOptions: string[] = []): void {
  git(root, ["init", "-q", "--bare", "--template=", "--initial-branch=main", mirror]);
  git(root, [
    `--git-dir=${mirror}`,
    ...extraOptions,
    "fetch",
    "-q",
    "--no-tags",
    "--no-write-fetch-head",
    remoteUrl,
    "+refs/heads/*:refs/heads/*",
  ]);
}

function runClone(
  dest: string,
  mirrorVariable: string | null = mirror,
  url = remoteUrl,
  { removeMirrorBeforeClone = false } = {},
): { code: number | null; stdout: string; stderr: string } {
  // Removing the mirror inside the first clone reproduces the race between the
  // script's check and Git opening the reference.
  const race = removeMirrorBeforeClone
    ? `git() { if [ "$1" = clone ] && [ -d "$ORKESTRATOR_GIT_MIRROR_UNDER_TEST" ]; then rm -rf "$ORKESTRATOR_GIT_MIRROR_UNDER_TEST"; fi; command git "$@"; }`
    : "";
  const harness = `
set -e
YELLOW=""; NC=""
eval "$(sed -n '/^git_mirror_problem() {/,/^}$/p; /^report_git_mirror_outcome() {/,/^}$/p; /^clone_from_git_mirror() {/,/^}$/p; /^clone_repository() {/,/^}$/p' "$1")"
${race}
clone_repository "$2" "$3"
`;
  const env: NodeJS.ProcessEnv = { ...gitEnv };
  delete env.ORKESTRATOR_GIT_MIRROR;
  if (mirrorVariable !== null) env.ORKESTRATOR_GIT_MIRROR = mirrorVariable;
  if (removeMirrorBeforeClone && mirrorVariable !== null) {
    env.ORKESTRATOR_GIT_MIRROR_UNDER_TEST = mirrorVariable;
  }
  const result = spawnSync("bash", ["-c", harness, "--", setupScript, url, dest], {
    encoding: "utf8",
    env,
  });
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function outcome(stdout: string): string | undefined {
  return /\x1eORKESTRATOR_GIT_MIRROR:([a-z-]+)\x1f/.exec(stdout)?.[1];
}

function remoteSentObjects(): boolean {
  return existsSync(packLog);
}

/** Writes the per-root Git config whose upload-pack hook logs to this root's pack log. */
function configureRoot(directory: string, log: string): NodeJS.ProcessEnv {
  const hook = join(directory, "pack-objects-hook");
  writeFileSync(hook, `#!/bin/sh\necho sent >> "${log}"\nexec "$@"\n`);
  chmodSync(hook, 0o755);
  const globalConfig = join(directory, "gitconfig");
  writeFileSync(
    globalConfig,
    `[user]\n\tname = T\n\temail = t@example.com\n[uploadpack]\n\tpackObjectsHook = ${hook}\n\tallowFilter = true\n`,
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  delete env.ORKESTRATOR_GIT_MIRROR;
  return env;
}

// The remote, its working clone with two pushed commits, and a mirror built
// from it are made once; each case copies them into its own root. None of
// them records its own path, and the working clone's origin is rewritten to
// the copied remote.
let template: string;

beforeAll(() => {
  template = mkdtempSync(join(tmpdir(), "ork-git-mirror-template-"));
  root = template;
  remote = join(template, "remote.git");
  remoteUrl = `file://${remote}`;
  mirror = join(template, "mirror.git");
  work = join(template, "work");
  packLog = join(template, "pack-objects.log");
  gitEnv = configureRoot(template, packLog);
  git(template, ["init", "-q", "--bare", "--initial-branch=main", remote]);
  git(template, ["config", "--file", join(remote, "config"), "uploadpack.allowFilter", "true"]);
  git(template, ["clone", "-q", remote, work]);
  git(work, ["checkout", "-qb", "main"]);
  commit("one.txt", "one\n");
  commit("two.txt", "two\n");
  buildMirror();
});

afterAll(() => {
  rmSync(template, { recursive: true, force: true });
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ork-git-mirror-setup-"));
  remote = join(root, "remote.git");
  remoteUrl = `file://${remote}`;
  mirror = join(root, "mirror.git");
  work = join(root, "work");
  packLog = join(root, "pack-objects.log");
  gitEnv = configureRoot(root, packLog);
  cpSync(join(template, "remote.git"), remote, { recursive: true });
  cpSync(join(template, "work"), work, { recursive: true });
  const workConfig = join(work, ".git", "config");
  const templateRemote = join(template, "remote.git");
  const config = readFileSync(workConfig, "utf8");
  expect(config).toContain(templateRemote);
  writeFileSync(workConfig, config.replaceAll(templateRemote, remote));
});

/** The mirror the backend would build from the remote as the template left it. */
function copyMirror(): void {
  cpSync(join(template, "mirror.git"), mirror, { recursive: true });
}

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("clone from the project's Git mirror", () => {
  test("a second environment gets its objects from the mirror, not the remote", () => {
    copyMirror();
    rmSync(packLog, { force: true });
    const dest = join(root, "env-two");

    const { code, stdout } = runClone(dest);

    expect(code).toBe(0);
    expect(outcome(stdout)).toBe("used");
    expect(remoteSentObjects()).toBe(false);
    expect(git(dest, ["log", "-1", "--format=%s"])).toBe("change two.txt");
    expect(git(dest, ["remote", "get-url", "origin"])).toBe(remoteUrl);
  });

  test("the same clone without a mirror does ask the remote for objects", () => {
    const { code, stdout } = runClone(join(root, "env-one"), null);

    expect(code).toBe(0);
    expect(outcome(stdout)).toBeUndefined();
    expect(remoteSentObjects()).toBe(true);
  });

  test("the clone stays whole after the mirror is removed", () => {
    copyMirror();
    const dest = join(root, "env");
    expect(runClone(dest).code).toBe(0);
    expect(existsSync(join(dest, ".git", "objects", "info", "alternates"))).toBe(false);

    rmSync(mirror, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });

    expect(git(dest, ["status", "--porcelain"])).toBe("");
    expect(git(dest, ["log", "--format=%s"]).split("\n")).toEqual([
      "change two.txt",
      "change one.txt",
    ]);
    expect(git(dest, ["diff", "HEAD~1", "HEAD", "--name-only"])).toBe("two.txt");
    git(dest, ["fsck", "--full"]);
  });

  test("a mirror behind the remote costs only the commits it lacks", () => {
    copyMirror();
    commit("three.txt", "three\n");
    const dest = join(root, "env");

    const { code, stdout } = runClone(dest);

    expect(code).toBe(0);
    expect(outcome(stdout)).toBe("used");
    expect(git(dest, ["log", "-1", "--format=%s"])).toBe("change three.txt");
    expect(existsSync(join(dest, ".git", "objects", "info", "alternates"))).toBe(false);
    // The combination this replaces (--filter with --dissociate) leaves objects
    // missing here, and fetches them from the remote one at a time afterwards.
    expect(git(dest, ["rev-list", "--objects", "--all", "--missing=print"])).not.toContain("?");
    git(dest, ["fsck", "--full"]);
  });

  test("a held lock in the mirror does not get in a reader's way", () => {
    copyMirror();
    for (const lock of ["packed-refs.lock", "HEAD.lock", "config.lock", "gc.pid"]) {
      writeFileSync(join(mirror, lock), "");
    }
    writeFileSync(join(mirror, "refs", "heads", "main.lock"), "");
    rmSync(packLog, { force: true });

    const { code, stdout } = runClone(join(root, "env"));

    expect(code).toBe(0);
    expect(outcome(stdout)).toBe("used");
    expect(remoteSentObjects()).toBe(false);
  });

  test("a mirror removed between the check and the clone still leaves a whole clone", () => {
    copyMirror();
    rmSync(packLog, { force: true });
    const dest = join(root, "env");

    const { code, stdout } = runClone(dest, mirror, remoteUrl, { removeMirrorBeforeClone: true });

    expect(code).toBe(0);
    expect(existsSync(mirror)).toBe(false);
    // Reported, so the backend logs that the history came from the remote.
    expect(outcome(stdout)).toBe("vanished");
    expect(stdout.match(/ORKESTRATOR_GIT_MIRROR:/g)?.length).toBe(1);
    expect(stdout).toContain("Git mirror went away during the clone");
    expect(remoteSentObjects()).toBe(true);
    expect(git(dest, ["log", "-1", "--format=%s"])).toBe("change two.txt");
    expect(existsSync(join(dest, ".git", "objects", "info", "alternates"))).toBe(false);
    git(dest, ["fsck", "--full"]);
  });

  test("the mirror is not written to", () => {
    copyMirror();
    const files = () => git(mirror, ["--git-dir=.", "count-objects", "-v"]);
    const before = [readdirSync(mirror).sort(), files()];

    expect(runClone(join(root, "env")).code).toBe(0);

    expect([readdirSync(mirror).sort(), files()]).toEqual(before);
  });
});

describe("fallback to the ordinary clone", () => {
  function expectOrdinaryClone(dest: string, result: ReturnType<typeof runClone>, reason: string) {
    expect(result.code).toBe(0);
    expect(outcome(result.stdout)).toBe(reason);
    expect(result.stdout).toContain(`Git mirror not used (${reason}); cloning from the remote.`);
    // Today's clone exactly: blobless, and the objects came from the remote.
    expect(remoteSentObjects()).toBe(true);
    expect(git(dest, ["config", "remote.origin.promisor"])).toBe("true");
    expect(git(dest, ["log", "-1", "--format=%s"])).toBe("change two.txt");
    expect(existsSync(join(dest, ".git", "objects", "info", "alternates"))).toBe(false);
  }

  test("no mirror yet", () => {
    const dest = join(root, "env");
    expectOrdinaryClone(dest, runClone(dest, join(root, "absent.git")), "missing");
  });

  test("a mirror with no branches", () => {
    git(root, ["init", "-q", "--bare", "--template=", "--initial-branch=main", mirror]);
    const dest = join(root, "env");
    expectOrdinaryClone(dest, runClone(dest), "empty");
  });

  test("a directory that is not a repository", () => {
    mkdirSync(join(mirror, "objects"), { recursive: true });
    writeFileSync(join(mirror, "HEAD"), "garbage\n");
    const dest = join(root, "env");
    expectOrdinaryClone(dest, runClone(dest), "corrupt");
  });

  test("a mirror whose packs are gone", () => {
    buildMirror(["-c", "fetch.unpackLimit=1"]);
    rmSync(join(mirror, "objects", "pack"), { recursive: true, force: true });
    mkdirSync(join(mirror, "objects", "pack"));
    const dest = join(root, "env");
    expectOrdinaryClone(dest, runClone(dest), "corrupt");
  });

  test("a truncated pack", () => {
    buildMirror(["-c", "fetch.unpackLimit=1"]);
    const packDir = join(mirror, "objects", "pack");
    const pack = readdirSync(packDir).find((name) => name.endsWith(".pack"))!;
    chmodSync(join(packDir, pack), 0o644);
    truncateSync(join(packDir, pack), 40);
    const dest = join(root, "env");
    expectOrdinaryClone(dest, runClone(dest), "corrupt");
  });

  test("an object lost from deep in the history, which only the clone can find", () => {
    buildMirror(["-c", "fetch.unpackLimit=100000"]);
    const oldBlob = git(work, ["rev-parse", "HEAD~1:one.txt"]);
    // Reachable only through history older than the tip the check looks at.
    commit("one.txt", "replaced\n");
    git(root, [
      `--git-dir=${mirror}`,
      "-c",
      "fetch.unpackLimit=100000",
      "fetch",
      "-q",
      "--no-write-fetch-head",
      remoteUrl,
      "+refs/heads/*:refs/heads/*",
    ]);
    rmSync(join(mirror, "objects", oldBlob.slice(0, 2), oldBlob.slice(2)), { force: true });
    rmSync(packLog, { force: true });
    const dest = join(root, "env");

    const result = runClone(dest);

    expect(result.code).toBe(0);
    expect(outcome(result.stdout)).toBe("clone-failed");
    expect(remoteSentObjects()).toBe(true);
    expect(git(dest, ["log", "-1", "--format=%s"])).toBe("change one.txt");
    expect(existsSync(join(dest, ".git", "objects", "info", "alternates"))).toBe(false);
  });

  test("a remote that cannot be reached still fails, after one try at the mirror", () => {
    copyMirror();
    const absent = `file://${join(root, "no-such-remote.git")}`;

    const result = runClone(join(root, "env"), mirror, absent);

    expect(result.code).not.toBe(0);
    expect(outcome(result.stdout)).toBe("clone-failed");
    expect(result.stdout.match(/ORKESTRATOR_GIT_MIRROR:/g)?.length).toBe(1);
  });

  test("no variable means an image or runtime without a mirror, and nothing changes", () => {
    const dest = join(root, "env");
    const { code, stdout } = runClone(dest, null);

    expect(code).toBe(0);
    expect(stdout).not.toContain("mirror");
    expect(git(dest, ["config", "remote.origin.promisor"])).toBe("true");
  });
});
