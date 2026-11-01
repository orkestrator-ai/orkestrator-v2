/** Execute the workflow's shell steps, including Git/pin handoff, rather than matching YAML text. */
import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { WORKER_CONTEXT_LABEL } from "./preview-worker-context-digest.js";
import { readPublishedWorkerImage } from "./preview-worker-prepare.js";

const root = path.resolve(import.meta.dir, "../../../../..");
const workflow = Bun.YAML.parse(
  readFileSync(path.join(root, ".github/workflows/publish-preview-worker.yml"), "utf8"),
) as {
  jobs: Record<string, { steps: Array<{ name: string; run?: string }> }>;
};
const DIGEST = `sha256:${"a".repeat(64)}`;
const CONTEXT = `sha256:${"b".repeat(64)}`;
const IMAGE = "localhost:5000/preview-worker";
const PIN = "docker/artifact-preview-worker/published-image.json";
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function scratch(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ork-publish-test-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function command(args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
  return Bun.spawnSync(args, {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60_000,
  });
}
function step(name: string, cwd: string, env: NodeJS.ProcessEnv = {}) {
  const script = Object.values(workflow.jobs)
    .flatMap((job) => job.steps)
    .find((entry) => entry.name === name)?.run;
  if (!script) throw new Error(`Missing workflow step: ${name}`);
  const result = command(["bash", "-c", script], cwd, {
    IMAGE,
    TAG: "ctx-test",
    DIGEST,
    CONTEXT_DIGEST: CONTEXT,
    CONTEXT_LABEL: WORKER_CONTEXT_LABEL,
    REFERENCE: `${IMAGE}@${DIGEST}`,
    RUNNER_TEMP: cwd,
    GITHUB_OUTPUT: path.join(cwd, "output"),
    ...env,
  });
  return { code: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
}
function executable(dir: string, name: string, body: string) {
  const file = path.join(dir, name);
  writeFileSync(file, body);
  chmodSync(file, 0o755);
}
function fixture() {
  const dir = scratch();
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  executable(
    bin,
    "docker",
    `#!${process.execPath}
const args = process.argv.slice(2);
const label = process.env.CONTEXT_DIGEST;
if (args[0] === "pull") {
  if (!process.env.DOCKER_CONFIG || process.env.DOCKER_CONFIG === process.env.ORIGINAL_CONFIG) process.exit(9);
  if (args.includes(process.env.FAIL_PLATFORM)) process.exit(1);
} else if (args[0] === "image") {
  console.log(process.env.BAD_LABEL || label);
} else if (args.includes("--raw")) {
  console.log(JSON.stringify({ manifests: ["amd64", ...(process.env.MISSING_ARM ? [] : ["arm64"])].map(architecture => ({ platform: { os: "linux", architecture } })) }));
} else if (args.at(-1)?.includes(".Image")) {
  const bad = args.at(-1).includes("arm64") && process.env.BAD_LABEL;
  console.log(JSON.stringify({config: {Labels: bad === "missing" ? {} : { [process.env.CONTEXT_LABEL]: bad || label }}}));
} else {
  if (process.env.ABSENT) process.exit(1);
  console.log(JSON.stringify({digest: process.env.DIGEST}));
}
`,
  );
  return {
    dir,
    env: { PATH: `${bin}:${process.env.PATH}`, ORIGINAL_CONFIG: process.env.DOCKER_CONFIG ?? "" },
  };
}

test("existing-tag detection and manifest checks execute for valid and rejected registry responses", () => {
  const { dir, env } = fixture();
  expect(step("Check for an image of this context", dir, env).code).toBe(0);
  expect(readFileSync(path.join(dir, "output"), "utf8")).toContain("exists=true");
  expect(step("Check for an image of this context", dir, { ...env, ABSENT: "1" }).code).toBe(0);
  expect(readFileSync(path.join(dir, "output"), "utf8")).toContain("exists=false");
  const valid = step("Resolve and verify the published digest", dir, env);
  expect(valid.code, valid.output).toBe(0);
  for (const invalid of [{ MISSING_ARM: "1" }, { BAD_LABEL: "missing" }, { BAD_LABEL: DIGEST }])
    expect(
      step("Resolve and verify the published digest", dir, { ...env, ...invalid }).code,
    ).not.toBe(0);
});

test("anonymous qualification pulls both architectures with isolated credentials and refuses label mismatch", () => {
  const { dir, env } = fixture();
  const valid = step("Check anonymous pull access", dir, env);
  expect(valid.code, valid.output).toBe(0);
  expect(readFileSync(path.join(dir, "output"), "utf8")).toContain("public=true");
  for (const platform of ["linux/amd64", "linux/arm64"]) {
    writeFileSync(path.join(dir, "output"), "");
    expect(step("Check anonymous pull access", dir, { ...env, FAIL_PLATFORM: platform }).code).toBe(
      0,
    );
    expect(readFileSync(path.join(dir, "output"), "utf8")).toBe("public=false\n");
  }
  expect(step("Check anonymous pull access", dir, { ...env, BAD_LABEL: DIGEST }).code).not.toBe(0);
});

test("pin handoff commits and pushes the generated pin, verifies the PR head, and safely reuses it", () => {
  const dir = scratch();
  const repo = path.join(dir, "repo");
  const remote = path.join(dir, "remote.git");
  const bin = path.join(dir, "bin");
  mkdirSync(repo);
  mkdirSync(bin);
  const git = (args: string[], cwd = repo) => {
    const result = command(["git", ...args], cwd);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return result.stdout.toString().trim();
  };
  git(["init", "--bare", remote]);
  git(["init", "-b", "main"]);
  git(["config", "user.name", "Pin test"]);
  git(["config", "user.email", "pin@example.test"]);
  mkdirSync(path.dirname(path.join(repo, PIN)), { recursive: true });
  writeFileSync(
    path.join(repo, PIN),
    JSON.stringify({ image: null, digest: null, contextDigest: null }),
  );
  copyFileSync(
    path.join(root, "docker/artifact-preview-worker/write-pin.ts"),
    path.join(repo, "docker/artifact-preview-worker/write-pin.ts"),
  );
  git(["add", "."]);
  git(["commit", "-m", "fixture"]);
  git(["remote", "add", "origin", remote]);
  executable(
    bin,
    "gh",
    `#!/bin/sh
case "$1 $2" in
  'pr list') test ! -f '${dir}/created' || echo 1 ;;
  'pr create') touch '${dir}/created' ;;
  'pr view') git rev-parse HEAD ;;
  'api '*) git --git-dir='${remote}' show "$(git branch --show-current):${PIN}" | base64 ;;
  *) exit 2 ;;
esac
`,
  );
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    GITHUB_REPOSITORY: "example/worker",
    GITHUB_SHA: git(["rev-parse", "HEAD"]),
  };
  const created = step("Open the pin pull request", repo, env);
  expect(created.code, created.output).toBe(0);
  expect(readPublishedWorkerImage(path.join(repo, PIN))?.reference).toBe(`${IMAGE}@${DIGEST}`);
  const branch = git(["branch", "--show-current"]);
  expect(git(["rev-parse", `refs/heads/${branch}`], remote)).toBe(git(["rev-parse", "HEAD"]));
  git(["switch", "main"]);
  // Model the GitHub API reading the already-open branch on a second workflow run.
  executable(
    bin,
    "gh",
    `#!/bin/sh
case "$1 $2" in
  'pr list') echo 1 ;;
  'api '*) git --git-dir='${remote}' show '${branch}:${PIN}' | base64 ;;
  *) exit 2 ;;
esac
`,
  );
  const existing = step("Open the pin pull request", repo, env);
  expect(existing.code, existing.output).toBe(0);
  expect(existing.output).toContain("Verified existing pin pull request #1");
});

// Run on Linux CI and on demand locally; only this test's registry and images are removed.
test.skipIf(process.env.ORKESTRATOR_TEST_LIVE_WORKER_PUBLISH !== "1")(
  "qualifies a real multi-platform registry image and existing tag",
  () => {
    const dir = scratch();
    const docker = (args: string[]) => {
      const result = command(["docker", ...args], dir);
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      return result.stdout.toString().trim();
    };
    // Only macOS needs the disposable daemon's port (see below). On Linux a
    // second ephemeral publish can be handed the same host port as the first,
    // and the bind then fails with "address already in use".
    const id = docker([
      "run",
      "--detach",
      "--rm",
      "--publish",
      "127.0.0.1::5000",
      ...(process.platform === "darwin" ? ["--publish", "127.0.0.1::2375"] : []),
      "registry:3",
    ]);
    cleanups.push(() => {
      command(["docker", "rm", "--force", id], dir);
    });
    const port = docker(["port", id, "5000/tcp"]).split(":").at(-1)!;
    const image = `127.0.0.1:${port}/preview-worker`;
    // BuildKit may run in its own container; use the registry's bridge IP
    // for exports, and the published port for the host's registry client.
    const registryIp = docker([
      "inspect",
      "--format",
      "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
      id,
    ]);
    const pushImage = `${registryIp}:5000/preview-worker`;
    writeFileSync(
      path.join(dir, "Dockerfile"),
      `FROM scratch\nLABEL ${WORKER_CONTEXT_LABEL}="${CONTEXT}"\nCOPY payload /payload\n`,
    );
    writeFileSync(path.join(dir, "payload"), "qualification\n");
    cleanups.push(() => {
      command(["docker", "image", "rm", `${pushImage}:ctx-test`], dir);
    });
    docker([
      "buildx",
      "build",
      "--platform",
      "linux/amd64,linux/arm64",
      "--provenance=false",
      "--tag",
      `${pushImage}:ctx-test`,
      "--output",
      "type=image,push=true,registry.insecure=true",
      dir,
    ]);
    const env = {
      IMAGE: image,
      DOCKER_HOST: docker(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]),
      DOCKER_CONTEXT: "",
    };
    const existing = step("Check for an image of this context", dir, env);
    expect(existing.code, existing.output).toBe(0);
    expect(readFileSync(path.join(dir, "output"), "utf8")).toContain("exists=true");
    const manifest = step("Resolve and verify the published digest", dir, env);
    expect(manifest.code, manifest.output).toBe(0);
    const digest = readFileSync(path.join(dir, "output"), "utf8").split("digest=").at(-1)!.trim();
    cleanups.push(() => {
      command(["docker", "image", "rm", `${image}@${digest}`], dir);
    });
    let pullEnv = { ...env, REFERENCE: `${image}@${digest}` };
    if (process.platform === "darwin") {
      // Docker Desktop's daemon cannot reach host-published loopback ports.
      // A disposable daemon shares the registry's namespace for real pulls;
      // this never changes the user's daemon configuration or image store.
      const daemon = docker([
        "run",
        "--detach",
        "--rm",
        "--privileged",
        "--network",
        `container:${id}`,
        "--env",
        "DOCKER_TLS_CERTDIR=",
        "docker:29-dind",
      ]);
      cleanups.push(() => {
        command(["docker", "rm", "--force", daemon], dir);
      });
      const daemonPort = docker(["port", id, "2375/tcp"]).split(":").at(-1)!;
      pullEnv = {
        ...env,
        DOCKER_HOST: `tcp://127.0.0.1:${daemonPort}`,
        REFERENCE: `127.0.0.1:5000/preview-worker@${digest}`,
      };
      const until = Date.now() + 30_000;
      while (command(["docker", "version"], dir, pullEnv).exitCode !== 0) {
        if (Date.now() > until) throw new Error("Disposable Docker daemon did not start");
        Bun.sleepSync(200);
      }
    }
    const pulled = step("Check anonymous pull access", dir, pullEnv);
    expect(pulled.code, pulled.output).toBe(0);
    expect(readFileSync(path.join(dir, "output"), "utf8"), pulled.output).toContain("public=true");
  },
  120_000,
);
