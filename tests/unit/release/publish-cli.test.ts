import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  cliNpmPublishCommand,
  cliPackCommand,
  cliPublishCommand,
  cliSmokeCommand,
  createPublishRunner,
  npmAuthAttempts,
  npmSupportsTrustedPublishing,
  npmWebAuthExpired,
  publishCli,
  publishCliFromCi,
  resolveNpmToken,
  type PublishRunner,
} from "../../../scripts/publish-cli";
import type { ApprovalLink } from "../../../scripts/release-approval";
import { readBuildCommit } from "../../../packages/protocol/src/node/build-commit";

test.each([
  ["2.23.0", "latest"],
  ["2.23.0-beta", "beta"],
  ["2.23.0-beta.2", "beta"],
  ["2.24.0-alpha", "alpha"],
  ["2.24.0-alpha.12", "alpha"],
])("publishes %s under the %s dist-tag", (version, distTag) => {
  expect(cliPublishCommand(version)).toEqual([
    "bun",
    "publish",
    "--cwd",
    "packages/cli",
    "--access",
    "public",
    "--tag",
    distTag,
  ]);
});

test("the publish environment reaches a real prepack rebuild and generated tarballs stay clean", async () => {
  const root = path.resolve(import.meta.dir, "../../..");
  const fixture = mkdtempSync(path.join(tmpdir(), "ork-prepack-commit-"));
  const manifest = JSON.parse(
    readFileSync(path.join(root, "packages/cli/package.json"), "utf8"),
  ) as { scripts: Record<string, string> };
  expect(manifest.scripts.prepack).toBe("bun run build");
  expect(manifest.scripts.build).toBe("bun scripts/build.ts");
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(
      ["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args],
      { cwd: fixture },
    );
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return result.stdout.toString().trim();
  };
  try {
    const cli = path.join(fixture, "packages/cli");
    mkdirSync(path.join(cli, "scripts"), { recursive: true });
    writeFileSync(path.join(fixture, ".gitignore"), readFileSync(path.join(root, ".gitignore")));
    writeFileSync(
      path.join(cli, "package.json"),
      JSON.stringify({
        name: "ork-prepack-fixture",
        version: "1.0.0",
        scripts: { prepack: manifest.scripts.prepack, build: manifest.scripts.build },
        files: ["dist"],
      }),
    );
    writeFileSync(
      path.join(cli, "entry.ts"),
      `import { BUILD_COMMIT } from ${JSON.stringify(path.join(root, "apps/backend/src/core/constants.ts"))};\nconsole.log(JSON.stringify(BUILD_COMMIT));\n`,
    );
    writeFileSync(
      path.join(cli, "scripts/build.ts"),
      `import { buildCommitDefine } from ${JSON.stringify(path.join(root, "packages/protocol/src/node/build-commit.ts"))};
const result = await Bun.build({entrypoints:["entry.ts"],outdir:"dist",target:"bun",define:buildCommitDefine()});
if (!result.success) throw new Error("Build failed");
`,
    );
    git("init", "--quiet");
    git("add", ".");
    git("commit", "--quiet", "--no-gpg-sign", "-m", "fixture");
    const head = git("rev-parse", "HEAD");
    const pack = () =>
      publishCli({
        repositoryRoot: fixture,
        env: { ...process.env, ORKESTRATOR_NPM_TOKEN_FILE: path.join(fixture, "absent-token") },
        log: () => undefined,
        run: async (command, options) => {
          expect(command).toEqual(cliPublishCommand("1.0.0"));
          // Exercise Bun's actual prepack lifecycle using the publication
          // environment. Nothing is sent to a registry.
          const result = Bun.spawnSync([process.execPath, "pm", "pack", "--cwd", "packages/cli"], {
            cwd: options.cwd,
            env: options.env,
          });
          expect(result.exitCode, result.stderr.toString()).toBe(0);
          return result;
        },
      });
    const builtCommit = () => {
      const result = Bun.spawnSync([process.execPath, "--no-env-file", "dist/entry.js"], {
        cwd: cli,
      });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      return JSON.parse(result.stdout.toString());
    };
    expect(await pack()).toBe(0);
    expect(builtCommit()).toBe(head);
    expect(existsSync(path.join(cli, "ork-prepack-fixture-1.0.0.tgz"))).toBe(true);
    expect(git("status", "--porcelain", "--untracked-files=all")).toBe("");
    expect(git("check-ignore", "packages/cli/ork-prepack-fixture-1.0.0.tgz")).toBe(
      "packages/cli/ork-prepack-fixture-1.0.0.tgz",
    );
    expect(readBuildCommit(fixture)).toBe(head);
    writeFileSync(path.join(cli, "untracked.txt"), "dirty\n");
    expect(await pack()).toBe(0);
    expect(builtCommit()).toBeNull();
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}, 30_000);

test.each(["2.23.0-rc.1", "2.23.0-canary.1", "garbage"])(
  "refuses %s before a publish command exists",
  (version) => {
    expect(() => cliPublishCommand(version)).toThrow("no update channel ships");
  },
);

const NPM_LINK = "https://www.npmjs.com/auth/cli/0b6c6a31-5f05-4f43-9d6b-d3b4d9a0c2e7";
const EXPIRED = "error: 404 Not Found: https://registry.npmjs.org/-/v1/done?authId=0b6c6a31\n";

describe("resolveNpmToken", () => {
  test("uses a token exported for this run", () => {
    expect(resolveNpmToken({ NPM_CONFIG_TOKEN: "npm_x" })).toEqual({
      kind: "environment",
      variable: "NPM_CONFIG_TOKEN",
    });
    expect(resolveNpmToken({ BUN_CONFIG_TOKEN: "npm_x" })).toEqual({
      kind: "environment",
      variable: "BUN_CONFIG_TOKEN",
    });
  });

  test("keeps no token on this machine: a token file is ignored", () => {
    expect(
      resolveNpmToken({ ORKESTRATOR_NPM_TOKEN_FILE: "/secure/npm-token", XDG_CONFIG_HOME: "/cfg" }),
    ).toEqual({ kind: "none" });
  });

  test("a blank exported token is no token", () => {
    expect(resolveNpmToken({ NPM_CONFIG_TOKEN: "  " })).toEqual({ kind: "none" });
  });
});

test("recognises npm's expired web sign-in", () => {
  expect(npmWebAuthExpired(EXPIRED)).toBe(true);
  expect(
    npmWebAuthExpired("error: 403 Forbidden - PUT https://registry.npmjs.org/orkestrator"),
  ).toBe(false);
});

test.each([
  [undefined, 3],
  ["1", 1],
  ["5", 5],
  ["0", 3],
  ["many", 3],
])("ORKESTRATOR_NPM_AUTH_ATTEMPTS=%s allows %d attempts", (value, attempts) => {
  expect(npmAuthAttempts({ ORKESTRATOR_NPM_AUTH_ATTEMPTS: value })).toBe(attempts);
});

describe("publishCli", () => {
  const root = path.resolve(import.meta.dir, "../../..");

  function scripted(outputs: { text: string; exitCode: number }[]) {
    const calls: NodeJS.ProcessEnv[] = [];
    const run: PublishRunner = async (_command, options) => {
      const next = outputs[calls.length] ?? { text: "", exitCode: 0 };
      calls.push(options.env);
      options.onOutput(next.text);
      return { exitCode: next.exitCode };
    };
    return { run, calls };
  }

  test("passes an exported token to bun publish without logging its value", async () => {
    const { run, calls } = scripted([{ text: "+ orkestrator@1.0.0\n", exitCode: 0 }]);
    const lines: string[] = [];
    const code = await publishCli({
      repositoryRoot: root,
      env: { PATH: process.env.PATH, NPM_CONFIG_TOKEN: "npm_secret" },
      run,
      log: (line) => lines.push(line),
      onApproval: () => undefined,
    });
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.NPM_CONFIG_TOKEN).toBe("npm_secret");
    expect(lines.join("\n")).not.toContain("npm_secret");
    expect(lines.join("\n")).toContain("NPM_CONFIG_TOKEN");
  });

  test("alerts once per sign-in link and asks again when it expires", async () => {
    const second = `${NPM_LINK.slice(0, -1)}f`;
    const { run, calls } = scripted([
      { text: `Authenticate your account at:\n${NPM_LINK}\n${EXPIRED}`, exitCode: 1 },
      { text: `Authenticate your account at:\n${second}\n${second}\n`, exitCode: 0 },
    ]);
    const approvals: ApprovalLink[] = [];
    const code = await publishCli({
      repositoryRoot: root,
      env: { PATH: process.env.PATH },
      run,
      log: () => undefined,
      onApproval: (link) => approvals.push(link),
    });
    expect(code).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.NPM_CONFIG_TOKEN).toBeUndefined();
    expect(approvals).toEqual([
      { kind: "npm", url: NPM_LINK },
      { kind: "npm", url: second },
    ]);
  });

  test("stops after the configured number of expired sign-ins", async () => {
    const expiredAttempt = { text: `${NPM_LINK}\n${EXPIRED}`, exitCode: 1 };
    const { run, calls } = scripted([expiredAttempt, expiredAttempt, expiredAttempt]);
    const code = await publishCli({
      repositoryRoot: root,
      env: { PATH: process.env.PATH, ORKESTRATOR_NPM_AUTH_ATTEMPTS: "2" },
      run,
      log: () => undefined,
      onApproval: () => undefined,
    });
    expect(code).toBe(1);
    expect(calls).toHaveLength(2);
  });

  test("an exported token npm rejects is reported, not replaced by a browser sign-in", async () => {
    const { run, calls } = scripted([
      {
        text: "error: 401 Unauthorized - PUT https://registry.npmjs.org/orkestrator\n",
        exitCode: 1,
      },
    ]);
    const code = await publishCli({
      repositoryRoot: root,
      env: { PATH: process.env.PATH, NPM_CONFIG_TOKEN: "exported" },
      run,
      log: () => undefined,
      onApproval: () => undefined,
    });
    expect(code).toBe(1);
    expect(calls).toHaveLength(1);
  });

  test("the real runner tees a child's output to the terminal and the approval watcher", async () => {
    const written = { stdout: [] as Uint8Array[], stderr: [] as Uint8Array[] };
    const runner = createPublishRunner({
      stdout: { write: (chunk) => written.stdout.push(chunk) },
      stderr: { write: (chunk) => written.stderr.push(chunk) },
    });
    // A stand-in for bun publish: the sign-in link on stdout, split across
    // two writes, and npm's expiry on stderr.
    const child = [
      "const half = Math.floor(process.argv[1].length / 2);",
      "process.stdout.write('Authenticate your account at:\\n' + process.argv[1].slice(0, half));",
      "await Bun.sleep(30);",
      "process.stdout.write(process.argv[1].slice(half) + '\\n');",
      "process.stderr.write(process.argv[2]);",
      "process.exit(1);",
    ].join("\n");
    const approvals: ApprovalLink[] = [];
    const lines: string[] = [];
    const code = await publishCli({
      repositoryRoot: root,
      env: { PATH: process.env.PATH, ORKESTRATOR_NPM_AUTH_ATTEMPTS: "1" },
      run: (_command, options) =>
        runner([process.execPath, "-e", child, NPM_LINK, EXPIRED], options),
      log: (line) => lines.push(line),
      onApproval: (link) => approvals.push(link),
    });
    const decode = (chunks: Uint8Array[]) =>
      chunks.map((chunk) => new TextDecoder().decode(chunk)).join("");
    expect(code).toBe(1);
    expect(decode(written.stdout)).toBe(`Authenticate your account at:\n${NPM_LINK}\n`);
    expect(decode(written.stderr)).toBe(EXPIRED);
    expect(approvals).toEqual([{ kind: "npm", url: NPM_LINK }]);
    // The expiry reached the retry check through the piped stderr.
    expect(lines.join("\n")).toContain("npm sign-in expired unapproved 1 times");
  });

  test("does not retry a failure that is not an expired sign-in", async () => {
    const { run, calls } = scripted([
      { text: "error: 403 Forbidden - cannot publish over 1.0.0\n", exitCode: 1 },
    ]);
    const code = await publishCli({
      repositoryRoot: root,
      env: { PATH: process.env.PATH },
      run,
      log: () => undefined,
      onApproval: () => undefined,
    });
    expect(code).toBe(1);
    expect(calls).toHaveLength(1);
  });
});

test.each([
  ["11.5.1", true],
  ["11.19.1", true],
  ["12.0.0", true],
  ["11.5.0", false],
  ["11.4.9", false],
  ["10.9.2", false],
  ["", false],
  ["not a version", false],
])("npm %p can publish with trusted publishing: %p", (version, supported) => {
  expect(npmSupportsTrustedPublishing(version)).toBe(supported);
});

describe("publishing from GitHub Actions", () => {
  test.each([
    ["2.23.0", "latest"],
    ["2.23.0-beta", "beta"],
    ["2.23.0-beta.2", "beta"],
    ["2.24.0-alpha.12", "alpha"],
  ])(
    "publishes the packed %s tarball under the %s dist-tag with provenance",
    (version, distTag) => {
      expect(cliNpmPublishCommand(version, "/work/orkestrator.tgz")).toEqual([
        "npm",
        "publish",
        "/work/orkestrator.tgz",
        "--access",
        "public",
        "--tag",
        distTag,
        "--provenance",
      ]);
    },
  );

  test("refuses a suffix no update channel ships", () => {
    expect(() => cliNpmPublishCommand("2.23.0-rc.1", "/work/orkestrator.tgz")).toThrow(
      "no update channel ships",
    );
  });

  test("packs into the work directory and smoke-tests that exact tarball", () => {
    expect(cliPackCommand("/work")).toEqual([
      "bun",
      "pm",
      "pack",
      "--cwd",
      "packages/cli",
      "--destination",
      "/work",
    ]);
    expect(cliSmokeCommand("/work/orkestrator.tgz")).toEqual([
      "bun",
      "packages/cli/scripts/smoke-packed.ts",
      "--tarball",
      "/work/orkestrator.tgz",
    ]);
  });

  const version = "2.30.0-beta";
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  /** A clean checkout, so a commit describes the tree exactly. */
  function checkout(options: { dirty?: boolean } = {}) {
    const dir = mkdtempSync(path.join(tmpdir(), "ork-ci-publish-"));
    directories.push(dir);
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(
        ["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args],
        { cwd: dir },
      );
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      return result.stdout.toString().trim();
    };
    git("init", "--initial-branch=main");
    mkdirSync(path.join(dir, "packages/cli"), { recursive: true });
    writeFileSync(path.join(dir, "packages/cli/package.json"), JSON.stringify({ version }));
    git("add", ".");
    git("commit", "-m", "release");
    if (options.dirty) writeFileSync(path.join(dir, "stray.txt"), "uncommitted");
    return { dir, commit: git("rev-parse", "HEAD") };
  }

  const actionsEnv = {
    PATH: process.env.PATH,
    GITHUB_ACTIONS: "true",
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.example.invalid/",
    // Credentials that would make npm skip trusted publishing.
    NPM_CONFIG_TOKEN: "npm_a",
    BUN_CONFIG_TOKEN: "npm_b",
    NODE_AUTH_TOKEN: "npm_c",
    NPM_TOKEN: "npm_d",
    ORKESTRATOR_BUILD_COMMIT: "f".repeat(40),
  };

  /** Runs each step, recording it; packing leaves the tarball where the smoke test and publish expect it. */
  function recording(failAt?: { index: number; exitCode: number }, skipTarball = false) {
    const steps: Array<{ command: string[]; env: NodeJS.ProcessEnv; cwd: string }> = [];
    const run: PublishRunner = async (command, options) => {
      const index = steps.length;
      steps.push({ command, env: options.env, cwd: options.cwd });
      if (index === 0 && !skipTarball) {
        const destination = command[command.indexOf("--destination") + 1]!;
        writeFileSync(path.join(destination, `orkestrator-${version}.tgz`), "tarball");
      }
      return { exitCode: failAt?.index === index ? failAt.exitCode : 0 };
    };
    return { run, steps };
  }

  test("packs once, smoke-tests that tarball and publishes it, in that order", async () => {
    const { dir, commit } = checkout();
    const { run, steps } = recording();
    const code = await publishCliFromCi({
      repositoryRoot: dir,
      env: actionsEnv,
      run,
      npmVersion: () => "11.19.1",
      log: () => undefined,
    });
    expect(code).toBe(0);
    expect(steps.map((step) => step.command.slice(0, 3).join(" "))).toEqual([
      "bun pm pack",
      "bun packages/cli/scripts/smoke-packed.ts --tarball",
      "npm publish " + steps[2]!.command[2],
    ]);
    const tarball = steps[2]!.command[2]!;
    expect(path.basename(tarball)).toBe(`orkestrator-${version}.tgz`);
    expect(steps[1]!.command.at(-1)).toBe(tarball);
    expect(steps[2]!.command).toContain("--provenance");
    expect(steps[2]!.command.slice(steps[2]!.command.indexOf("--tag"))[1]).toBe("beta");
    for (const step of steps) {
      expect(step.cwd).toBe(dir);
      // The tarball's build commit is the checkout's, not whatever the job inherited.
      expect(step.env.ORKESTRATOR_BUILD_COMMIT).toBe(commit);
      for (const variable of [
        "NPM_CONFIG_TOKEN",
        "BUN_CONFIG_TOKEN",
        "NODE_AUTH_TOKEN",
        "NPM_TOKEN",
      ]) {
        expect(step.env[variable]).toBeUndefined();
      }
    }
    // The temporary work directory is gone.
    expect(existsSync(path.dirname(tarball))).toBe(false);
  });

  test.each([
    [0, "packing"],
    [1, "the smoke test"],
  ])("a failed step (%d: %s) stops before anything is published", async (index, _name) => {
    const { dir } = checkout();
    const { run, steps } = recording({ index, exitCode: 7 });
    const code = await publishCliFromCi({
      repositoryRoot: dir,
      env: actionsEnv,
      run,
      npmVersion: () => "11.19.1",
      log: () => undefined,
    });
    expect(code).toBe(7);
    expect(steps).toHaveLength(index + 1);
    expect(steps.some((step) => step.command[0] === "npm")).toBe(false);
  });

  test("a publish that npm rejects reports its exit status", async () => {
    const { dir } = checkout();
    const { run } = recording({ index: 2, exitCode: 1 });
    expect(
      await publishCliFromCi({
        repositoryRoot: dir,
        env: actionsEnv,
        run,
        npmVersion: () => "11.19.1",
        log: () => undefined,
      }),
    ).toBe(1);
  });

  test("refuses when packing produced no tarball", async () => {
    const { dir } = checkout();
    const { run, steps } = recording(undefined, true);
    await expect(
      publishCliFromCi({
        repositoryRoot: dir,
        env: actionsEnv,
        run,
        npmVersion: () => "11.19.1",
        log: () => undefined,
      }),
    ).rejects.toThrow("did not produce");
    expect(steps).toHaveLength(1);
  });

  test.each([
    [
      "outside GitHub Actions",
      { ...actionsEnv, GITHUB_ACTIONS: undefined },
      "11.19.1",
      "only runs in",
    ],
    [
      "without an OIDC token",
      { ...actionsEnv, ACTIONS_ID_TOKEN_REQUEST_URL: undefined },
      "11.19.1",
      "id-token: write",
    ],
    ["with an npm too old for trusted publishing", actionsEnv, "11.4.0", "needs 11.5.1"],
    ["with no npm", actionsEnv, "", "(not found)"],
  ])("refuses %s", async (_name, env, npmVersion, message) => {
    const { dir } = checkout();
    const { run, steps } = recording();
    await expect(
      publishCliFromCi({ repositoryRoot: dir, env, run, npmVersion: () => npmVersion }),
    ).rejects.toThrow(message);
    expect(steps).toHaveLength(0);
  });

  test("refuses a checkout no commit describes, since the build commit could not be embedded", async () => {
    const { dir } = checkout({ dirty: true });
    const { run, steps } = recording();
    await expect(
      publishCliFromCi({
        repositoryRoot: dir,
        env: actionsEnv,
        run,
        npmVersion: () => "11.19.1",
      }),
    ).rejects.toThrow("No commit describes this checkout");
    expect(steps).toHaveLength(0);
  });
});
