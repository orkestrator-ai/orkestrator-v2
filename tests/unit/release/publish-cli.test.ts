import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { cliPublishCommand, publishCli } from "../../../scripts/publish-cli";
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

test("the publish environment reaches a real prepack rebuild and generated tarballs stay clean", () => {
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
      publishCli(fixture, (command, options) => {
        expect(command).toEqual(cliPublishCommand("1.0.0"));
        // Exercise Bun's actual prepack lifecycle using the publication
        // environment. Nothing is sent to a registry.
        const result = Bun.spawnSync([process.execPath, "pm", "pack", "--cwd", "packages/cli"], {
          cwd: options.cwd,
          env: options.env,
        });
        expect(result.exitCode, result.stderr.toString()).toBe(0);
        return result;
      });
    const builtCommit = () => {
      const result = Bun.spawnSync([process.execPath, "--no-env-file", "dist/entry.js"], {
        cwd: cli,
      });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      return JSON.parse(result.stdout.toString());
    };
    expect(pack()).toBe(0);
    expect(builtCommit()).toBe(head);
    expect(existsSync(path.join(cli, "ork-prepack-fixture-1.0.0.tgz"))).toBe(true);
    expect(git("status", "--porcelain", "--untracked-files=all")).toBe("");
    expect(git("check-ignore", "packages/cli/ork-prepack-fixture-1.0.0.tgz")).toBe(
      "packages/cli/ork-prepack-fixture-1.0.0.tgz",
    );
    expect(readBuildCommit(fixture)).toBe(head);
    writeFileSync(path.join(cli, "untracked.txt"), "dirty\n");
    expect(pack()).toBe(0);
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
