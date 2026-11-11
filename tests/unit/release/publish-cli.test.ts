import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  cliPublishCommand,
  createPublishRunner,
  npmAuthAttempts,
  npmTokenRejected,
  npmTokenFile,
  npmWebAuthExpired,
  publishCli,
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

/** A token store that holds nothing, so no test reads the maintainer's real token. */
const noTokenFs = { mode: () => null, read: () => "" };

function tokenFs(mode: number, contents: string) {
  return { mode: () => mode, read: () => contents };
}

describe("resolveNpmToken", () => {
  test("an exported token wins over the file", () => {
    expect(resolveNpmToken({ NPM_CONFIG_TOKEN: "npm_x" }, tokenFs(0o100600, "npm_file"))).toEqual({
      kind: "environment",
      variable: "NPM_CONFIG_TOKEN",
    });
    expect(resolveNpmToken({ BUN_CONFIG_TOKEN: "npm_x" }, noTokenFs)).toEqual({
      kind: "environment",
      variable: "BUN_CONFIG_TOKEN",
    });
  });

  test("reads an owner-only token file", () => {
    const env = { ORKESTRATOR_NPM_TOKEN_FILE: "/secure/npm-token" };
    expect(resolveNpmToken(env, tokenFs(0o100600, "npm_abc\n"))).toEqual({
      kind: "file",
      path: "/secure/npm-token",
      token: "npm_abc",
    });
  });

  test("refuses a token file other users can read", () => {
    const env = { ORKESTRATOR_NPM_TOKEN_FILE: "/secure/npm-token" };
    expect(() => resolveNpmToken(env, tokenFs(0o100644, "npm_abc"))).toThrow("chmod 600");
  });

  test("refuses a token file holding anything but one token", () => {
    const env = { ORKESTRATOR_NPM_TOKEN_FILE: "/secure/npm-token" };
    expect(() => resolveNpmToken(env, tokenFs(0o100600, "  "))).toThrow("exactly one npm token");
    expect(() => resolveNpmToken(env, tokenFs(0o100600, "npm_a npm_b"))).toThrow(
      "exactly one npm token",
    );
  });

  test("reports where it looked when there is no token", () => {
    expect(resolveNpmToken({ XDG_CONFIG_HOME: "/cfg" }, noTokenFs)).toEqual({
      kind: "none",
      path: "/cfg/orkestrator-release/npm-token",
    });
  });

  test("the default file lives under the user's config directory", () => {
    expect(npmTokenFile({}, "/home/me")).toBe("/home/me/.config/orkestrator-release/npm-token");
  });
});

test("recognises npm's expired web sign-in", () => {
  expect(npmWebAuthExpired(EXPIRED)).toBe(true);
  expect(
    npmWebAuthExpired("error: 403 Forbidden - PUT https://registry.npmjs.org/orkestrator"),
  ).toBe(false);
});

test.each([
  ["error: 401 Unauthorized - PUT https://registry.npmjs.org/orkestrator", true],
  ["npm error code E401", true],
  [
    "error: 403 Forbidden - PUT https://registry.npmjs.org/orkestrator - Two-factor authentication or granular access token with bypass 2fa enabled is required",
    true,
  ],
  ["error: 403 Forbidden - You may not perform that action with these credentials.", true],
  [
    "error: 403 Forbidden - You cannot publish over the previously published versions: 1.0.0.",
    false,
  ],
  ["error: 500 Internal Server Error - PUT https://registry.npmjs.org/orkestrator", false],
  ["error: ENOENT: prepack failed", false],
])("npmTokenRejected(%j) is %p", (output, rejected) => {
  expect(npmTokenRejected(output)).toBe(rejected);
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

  test("passes a stored token to bun publish without logging it", async () => {
    const { run, calls } = scripted([{ text: "+ orkestrator@1.0.0\n", exitCode: 0 }]);
    const lines: string[] = [];
    const code = await publishCli({
      repositoryRoot: root,
      env: { PATH: process.env.PATH, ORKESTRATOR_NPM_TOKEN_FILE: "/secure/npm-token" },
      tokenFs: tokenFs(0o100600, "npm_secret"),
      run,
      log: (line) => lines.push(line),
      onApproval: () => undefined,
    });
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.NPM_CONFIG_TOKEN).toBe("npm_secret");
    expect(lines.join("\n")).not.toContain("npm_secret");
    expect(lines.join("\n")).toContain("/secure/npm-token");
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
      tokenFs: noTokenFs,
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
      tokenFs: noTokenFs,
      run,
      log: () => undefined,
      onApproval: () => undefined,
    });
    expect(code).toBe(1);
    expect(calls).toHaveLength(2);
  });

  test("an expired stored token falls back to a notified browser approval", async () => {
    const { run, calls } = scripted([
      {
        text: "error: 401 Unauthorized - PUT https://registry.npmjs.org/orkestrator\n",
        exitCode: 1,
      },
      { text: `Authenticate your account at:\n${NPM_LINK}\n+ orkestrator@1.0.0\n`, exitCode: 0 },
    ]);
    const approvals: ApprovalLink[] = [];
    const lines: string[] = [];
    const code = await publishCli({
      repositoryRoot: root,
      env: { PATH: process.env.PATH, ORKESTRATOR_NPM_TOKEN_FILE: "/secure/npm-token" },
      tokenFs: tokenFs(0o100600, "npm_secret"),
      run,
      log: (line) => lines.push(line),
      onApproval: (link) => approvals.push(link),
    });
    expect(code).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.NPM_CONFIG_TOKEN).toBe("npm_secret");
    expect(calls[1]?.NPM_CONFIG_TOKEN).toBeUndefined();
    expect(approvals).toEqual([{ kind: "npm", url: NPM_LINK }]);
    const text = lines.join("\n");
    expect(text).toContain("npm rejected the token in /secure/npm-token");
    expect(text).not.toContain("npm_secret");
  });

  test("a token without two-factor bypass falls back once, then expired sign-ins count as usual", async () => {
    const expiredAttempt = { text: `${NPM_LINK}\n${EXPIRED}`, exitCode: 1 };
    const { run, calls } = scripted([
      {
        text: "error: 403 Forbidden - Two-factor authentication or granular access token with bypass 2fa enabled is required\n",
        exitCode: 1,
      },
      expiredAttempt,
      expiredAttempt,
    ]);
    const code = await publishCli({
      repositoryRoot: root,
      env: {
        PATH: process.env.PATH,
        ORKESTRATOR_NPM_TOKEN_FILE: "/secure/npm-token",
        ORKESTRATOR_NPM_AUTH_ATTEMPTS: "2",
      },
      tokenFs: tokenFs(0o100600, "npm_secret"),
      run,
      log: () => undefined,
      onApproval: () => undefined,
    });
    expect(code).toBe(1);
    // One token attempt, then the two browser attempts the setting allows.
    expect(calls).toHaveLength(3);
  });

  test("a stored token's publish that fails for another reason is not retried", async () => {
    const { run, calls } = scripted([
      {
        text: "error: 403 Forbidden - You cannot publish over the previously published versions: 1.0.0.\n",
        exitCode: 1,
      },
    ]);
    const code = await publishCli({
      repositoryRoot: root,
      env: { PATH: process.env.PATH, ORKESTRATOR_NPM_TOKEN_FILE: "/secure/npm-token" },
      tokenFs: tokenFs(0o100600, "npm_secret"),
      run,
      log: () => undefined,
      onApproval: () => undefined,
    });
    expect(code).toBe(1);
    expect(calls).toHaveLength(1);
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
      tokenFs: noTokenFs,
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
      tokenFs: noTokenFs,
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
      tokenFs: noTokenFs,
      run,
      log: () => undefined,
      onApproval: () => undefined,
    });
    expect(code).toBe(1);
    expect(calls).toHaveLength(1);
  });
});
