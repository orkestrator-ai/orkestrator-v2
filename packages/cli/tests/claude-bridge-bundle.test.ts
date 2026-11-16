import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CLAUDE_AGENT_SDK,
  claudeAgentSdkManifest,
  RELEASE_RUNTIME_DIRECTORY,
} from "../scripts/bridges.js";
import { lockedPackages } from "../scripts/lock-bridge-runtimes.js";

/**
 * The published package's Claude bridge inlines the Agent SDK, so neither a
 * user's install nor the standalone updater's frozen release install pulls the
 * SDK's optional platform packages (a whole Claude Code binary each, about
 * 320 MB, that the bridge never runs). To-do 8250 (retired).
 */
const packageRoot = path.resolve(import.meta.dir, "..");
const repositoryRoot = path.resolve(packageRoot, "../..");
const bundle = path.join(packageRoot, "resources/claude-bridge/dist/index.js");

const PROBE_TIMEOUT_MS = 30_000;

describe("the published Claude bridge", () => {
  test("installs no part of the Agent SDK", async () => {
    const manifest = (await Bun.file(path.join(packageRoot, "package.json")).json()) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies ?? {})).not.toContain(CLAUDE_AGENT_SDK);

    // The standalone updater installs this lockfile; one SDK entry would bring
    // back every platform package it lists as optional.
    const lockfile = await readFile(
      path.join(packageRoot, RELEASE_RUNTIME_DIRECTORY, "bun.lock"),
      "utf8",
    );
    const sdkPackages = [...lockedPackages(lockfile)].filter((name) =>
      name.startsWith(CLAUDE_AGENT_SDK),
    );
    expect(sdkPackages).toEqual([]);
  });

  test("inlines the SDK and its manifest", async () => {
    const source = await readFile(bundle, "utf8");
    expect(source).not.toMatch(/^import[^;]*["']@anthropic-ai\/claude-agent-sdk[^"']*["']/m);
    expect(source).not.toMatch(/\bimport\(\s*["']@anthropic-ai\/claude-agent-sdk/);
    // The build replaced every reference with the SDK's own fields.
    expect(source).not.toContain("__CLAUDE_AGENT_SDK_MANIFEST__");
  });

  describe("run from a directory with no node_modules", () => {
    let directory = "";

    beforeAll(async () => {
      directory = await mkdtemp(path.join(os.tmpdir(), "orkestrator-cli-claude-bundle-"));
      await cp(bundle, path.join(directory, "dist", "index.js"));
      // Answers `--version`; any session it is asked to run fails at once.
      await writeFile(
        path.join(directory, "fake-claude"),
        [
          "#!/bin/sh",
          `printf '%s\\n' "$*" >> "${path.join(directory, "fake-claude-calls")}"`,
          'if [ "$1" = "--version" ]; then echo "9.9.9 (Claude Code)"; exit 0; fi',
          "exit 3",
          "",
        ].join("\n"),
      );
      await chmod(path.join(directory, "fake-claude"), 0o755);
      await writeFile(
        path.join(directory, "probe.mjs"),
        `
        const bridge = await import("./dist/index.js");
        const response = await bridge.app.fetch(
          new Request("http://127.0.0.1/config/models", {
            headers: { authorization: "Bearer bundle-probe-token" },
          }),
        );
        const body = await response.json();
        console.log(JSON.stringify({
          status: response.status,
          sdkVersion: body.sdkVersion,
          cliVersion: body.cliVersion,
        }));
        process.exit(0);
      `,
      );
    });

    afterAll(async () => {
      if (directory) await rm(directory, { recursive: true, force: true });
    });

    test(
      "reports the inlined SDK version and runs only the executable it is given",
      async () => {
        // `--no-install`: with no node_modules in sight Bun would otherwise
        // auto-install a bare import from its cache, and an SDK left external
        // would still load.
        const probe = [process.execPath, "--no-install", path.join(directory, "probe.mjs")];
        const child = Bun.spawn(probe, {
          cwd: directory,
          env: {
            PATH: process.env.PATH,
            HOME: path.join(directory, "home"),
            CLAUDE_CONFIG_DIR: path.join(directory, "claude-config"),
            CLAUDE_CLI_PATH: path.join(directory, "fake-claude"),
            CLAUDE_BRIDGE_NO_SERVER: "1",
            CLAUDE_BRIDGE_TOKEN: "bundle-probe-token",
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        const timeout = setTimeout(() => child.kill("SIGKILL"), PROBE_TIMEOUT_MS);
        try {
          const [code, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ]);
          expect({ code, stderr: code === 0 ? "" : stderr.slice(-2000) }).toEqual({
            code: 0,
            stderr: "",
          });
          const sdk = await claudeAgentSdkManifest(repositoryRoot);
          expect(JSON.parse(stdout.trim().split("\n").at(-1)!)).toEqual({
            status: 200,
            sdkVersion: sdk.version,
            cliVersion: "9.9.9",
          });
        } finally {
          clearTimeout(timeout);
        }

        // The model catalogue opened a real SDK session, and the inlined SDK
        // spawned the configured executable rather than looking for its own.
        const calls = (await readFile(path.join(directory, "fake-claude-calls"), "utf8"))
          .trim()
          .split("\n");
        expect(calls).toContain("--version");
        expect(calls.some((call) => call.includes("--output-format stream-json"))).toBe(true);
      },
      PROBE_TIMEOUT_MS + 5_000,
    );
  });
});
