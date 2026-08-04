import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dir, "../..");
const temporaryDirectories: string[] = [];
const DOWNLOADER_TEST_TIMEOUT_MS = 15_000;

interface ScriptFixture {
  binariesDirectory: string;
  logPath: string;
  scriptPath: string;
  temporaryDirectory: string;
}

interface ScriptResult {
  status: number | null;
  stderr: string;
  stdout: string;
}

interface PlatformCase {
  architecture: string;
  os: string;
}

interface Downloader {
  binaryName: "claude" | "codex" | "opencode";
  scriptName: string;
  expectedDownload(case_: PlatformCase): string;
  expectedExtractor(case_: PlatformCase): "tar" | "unzip";
}

const downloaders: Downloader[] = [
  {
    binaryName: "claude",
    scriptName: "download-claude.sh",
    expectedDownload: ({ architecture, os }) => {
      const platform = os === "Darwin" ? "darwin" : "linux";
      const arch = architecture === "x86_64" ? "x64" : "arm64";
      return `claude-code-${platform}-${arch}/-/claude-code-${platform}-${arch}-2.1.220.tgz`;
    },
    expectedExtractor: () => "tar",
  },
  {
    binaryName: "codex",
    scriptName: "download-codex.sh",
    expectedDownload: ({ architecture, os }) => {
      const arch = architecture === "x86_64" ? "x86_64" : "aarch64";
      const target = os === "Darwin"
        ? `${arch}-apple-darwin`
        : `${arch}-unknown-linux-musl`;
      return `rust-v0.146.0/codex-${target}.tar.gz`;
    },
    expectedExtractor: () => "tar",
  },
  {
    binaryName: "opencode",
    scriptName: "download-opencode.sh",
    expectedDownload: ({ architecture, os }) => {
      const platform = os === "Darwin" ? "darwin" : "linux";
      const arch = architecture === "x86_64" ? "x64" : "arm64";
      const extension = os === "Darwin" ? ".zip" : ".tar.gz";
      return `v1.18.11/opencode-${platform}-${arch}${extension}`;
    },
    expectedExtractor: ({ os }) => os === "Darwin" ? "unzip" : "tar",
  },
];

const platformCases: PlatformCase[] = [
  { architecture: "x86_64", os: "Darwin" },
  { architecture: "arm64", os: "Darwin" },
  { architecture: "x86_64", os: "Linux" },
  { architecture: "aarch64", os: "Linux" },
];

function writeExecutable(target: string, source: string): void {
  writeFileSync(target, source);
  chmodSync(target, 0o755);
}

function createFixture(scriptName: string): ScriptFixture {
  const projectRoot = mkdtempSync(path.join(tmpdir(), "ork-downloader-test-"));
  temporaryDirectories.push(projectRoot);

  const scriptsDirectory = path.join(projectRoot, "scripts");
  const fakeBinDirectory = path.join(projectRoot, "fake-bin");
  const temporaryDirectory = path.join(projectRoot, "download-temp");
  const logPath = path.join(projectRoot, "commands.log");
  mkdirSync(scriptsDirectory);
  mkdirSync(fakeBinDirectory);

  const scriptPath = path.join(scriptsDirectory, scriptName);
  copyFileSync(path.join(repoRoot, "scripts", scriptName), scriptPath);
  chmodSync(scriptPath, 0o755);

  const fakeExecutable = path.join(projectRoot, "fake-executable");
  writeExecutable(fakeExecutable, `#!/bin/bash
tool_name="$(basename "$0")"
echo "probe $tool_name $*" >> "$HARNESS_LOG"
if [[ "$HARNESS_FAIL_PROBE" == "$tool_name" ]]; then
  exit 33
fi
echo "$tool_name test-version"
`);

  writeExecutable(path.join(fakeBinDirectory, "uname"), `#!/bin/bash
if [[ "$1" == "-m" ]]; then
  echo "$HARNESS_ARCH"
elif [[ "$1" == "-s" ]]; then
  echo "$HARNESS_OS"
else
  exit 2
fi
`);

  writeExecutable(path.join(fakeBinDirectory, "mktemp"), `#!/bin/bash
/bin/mkdir -p "$HARNESS_TEMP_DIR"
echo "mktemp $HARNESS_TEMP_DIR" >> "$HARNESS_LOG"
echo "$HARNESS_TEMP_DIR"
`);

  writeExecutable(path.join(fakeBinDirectory, "curl"), `#!/bin/bash
echo "curl $*" >> "$HARNESS_LOG"
if [[ "$HARNESS_FAIL_STAGE" == "curl" ]]; then
  exit 30
fi
output=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "-o" ]]; then
    output="$2"
    break
  fi
  shift
done
: > "$output"
`);

  writeExecutable(path.join(fakeBinDirectory, "tar"), `#!/bin/bash
echo "tar $*" >> "$HARNESS_LOG"
if [[ "$HARNESS_FAIL_STAGE" == "extract" ]]; then
  exit 31
fi
destination=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "-C" ]]; then
    destination="$2"
    break
  fi
  shift
done
/bin/mkdir -p "$destination/package"
/bin/cp "$HARNESS_FAKE_EXECUTABLE" "$destination/package/claude"
/bin/cp "$HARNESS_FAKE_EXECUTABLE" "$destination/opencode"
for target in \
  x86_64-apple-darwin aarch64-apple-darwin \
  x86_64-unknown-linux-musl aarch64-unknown-linux-musl; do
  /bin/cp "$HARNESS_FAKE_EXECUTABLE" "$destination/codex-$target"
done
`);

  writeExecutable(path.join(fakeBinDirectory, "unzip"), `#!/bin/bash
echo "unzip $*" >> "$HARNESS_LOG"
if [[ "$HARNESS_FAIL_STAGE" == "extract" ]]; then
  exit 31
fi
destination=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "-d" ]]; then
    destination="$2"
    break
  fi
  shift
done
/bin/cp "$HARNESS_FAKE_EXECUTABLE" "$destination/opencode"
`);

  writeExecutable(path.join(fakeBinDirectory, "codesign"), `#!/bin/bash
echo "codesign $*" >> "$HARNESS_LOG"
if [[ "$1" == "--remove-signature" && "$HARNESS_FAIL_REMOVE_SIGNATURE" == "1" ]]; then
  exit 34
fi
if [[ "$1" == "--sign" && "$HARNESS_FAIL_STAGE" == "codesign" ]]; then
  exit 32
fi
`);

  writeExecutable(path.join(fakeBinDirectory, "rm"), `#!/bin/bash
echo "rm $*" >> "$HARNESS_LOG"
exec /bin/rm "$@"
`);

  return {
    binariesDirectory: path.join(projectRoot, "binaries"),
    logPath,
    scriptPath,
    temporaryDirectory,
  };
}

function runFixture(
  fixture: ScriptFixture,
  platform: PlatformCase,
  extraEnvironment: Record<string, string> = {},
): ScriptResult {
  const fakeBinDirectory = path.join(path.dirname(fixture.scriptPath), "..", "fake-bin");
  const fakeExecutable = path.join(path.dirname(fixture.scriptPath), "..", "fake-executable");
  const result = spawnSync("/bin/bash", [fixture.scriptPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      HARNESS_ARCH: platform.architecture,
      HARNESS_FAKE_EXECUTABLE: fakeExecutable,
      HARNESS_LOG: fixture.logPath,
      HARNESS_OS: platform.os,
      HARNESS_TEMP_DIR: fixture.temporaryDirectory,
      PATH: `${fakeBinDirectory}:/usr/bin:/bin`,
      ...extraEnvironment,
    },
  });
  return {
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

function commandLog(fixture: ScriptFixture): string {
  return existsSync(fixture.logPath) ? readFileSync(fixture.logPath, "utf8") : "";
}

afterAll(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { force: true, recursive: true });
  }
});

for (const downloader of downloaders) {
  describe(downloader.scriptName, () => {
    for (const platform of platformCases) {
      test(`downloads, extracts, probes, and cleans up on ${platform.os}/${platform.architecture}`, () => {
        const fixture = createFixture(downloader.scriptName);
        const result = runFixture(fixture, platform);
        const log = commandLog(fixture);

        expect(result.status).toBe(0);
        expect(log).toContain(downloader.expectedDownload(platform));
        expect(log).toContain(`${downloader.expectedExtractor(platform)} `);
        expect(log).toContain(`probe ${downloader.binaryName} --version`);
        expect(existsSync(path.join(fixture.binariesDirectory, downloader.binaryName))).toBe(true);
        expect(existsSync(fixture.temporaryDirectory)).toBe(false);

        const codesignCalls = log.match(/^codesign /gm) ?? [];
        expect(codesignCalls).toHaveLength(platform.os === "Darwin" ? 2 : 0);
      }, DOWNLOADER_TEST_TIMEOUT_MS);
    }

    for (const [label, architecture, os, expectedMessage] of [
      ["architecture", "sparc64", "Linux", "Unsupported architecture: sparc64"],
      ["platform", "x86_64", "FreeBSD", "Unsupported platform: FreeBSD"],
    ] as const) {
      test(`rejects an unsupported ${label} before downloading`, () => {
        const fixture = createFixture(downloader.scriptName);
        const result = runFixture(fixture, { architecture, os });

        expect(result.status).toBe(1);
        expect(result.stdout).toContain(expectedMessage);
        expect(commandLog(fixture)).not.toContain("curl ");
        expect(existsSync(fixture.binariesDirectory)).toBe(false);
      }, DOWNLOADER_TEST_TIMEOUT_MS);
    }

    for (const [stage, expectedStatus] of [
      ["curl", 30],
      ["extract", 31],
      ["probe", 33],
    ] as const) {
      test(`propagates ${stage} failure and removes temporary files`, () => {
        const fixture = createFixture(downloader.scriptName);
        const environment = stage === "probe"
          ? { HARNESS_FAIL_PROBE: downloader.binaryName }
          : { HARNESS_FAIL_STAGE: stage };
        const result = runFixture(
          fixture,
          { architecture: "x86_64", os: "Linux" },
          environment,
        );

        expect(result.status).toBe(expectedStatus);
        expect(existsSync(fixture.temporaryDirectory)).toBe(false);
        expect(commandLog(fixture)).toContain(`rm -rf ${fixture.temporaryDirectory}`);
      }, DOWNLOADER_TEST_TIMEOUT_MS);
    }

    test("propagates macOS signing failure and removes temporary files", () => {
      const fixture = createFixture(downloader.scriptName);
      const result = runFixture(
        fixture,
        { architecture: "arm64", os: "Darwin" },
        { HARNESS_FAIL_STAGE: "codesign" },
      );

      expect(result.status).toBe(32);
      expect(commandLog(fixture)).not.toContain(`probe ${downloader.binaryName}`);
      expect(existsSync(fixture.temporaryDirectory)).toBe(false);
    }, DOWNLOADER_TEST_TIMEOUT_MS);

    test("continues when removing an existing macOS signature fails", () => {
      const fixture = createFixture(downloader.scriptName);
      const result = runFixture(
        fixture,
        { architecture: "arm64", os: "Darwin" },
        { HARNESS_FAIL_REMOVE_SIGNATURE: "1" },
      );

      expect(result.status).toBe(0);
      expect(commandLog(fixture)).toContain(`probe ${downloader.binaryName} --version`);
    }, DOWNLOADER_TEST_TIMEOUT_MS);
  });
}
