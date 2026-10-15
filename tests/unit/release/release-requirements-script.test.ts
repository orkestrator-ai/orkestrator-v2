import { describe, expect, mock, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MACOS_PERMISSION_CATALOGUE } from "../../../packages/protocol/src/macos-permissions";
import {
  parseReleaseRequirementsBytes,
  verifyReleaseRequirementsSignature,
} from "../../../packages/protocol/src/release-requirements";
import {
  PINNED_TOOLCHAIN_ARTIFACTS,
  PINNED_TOOL_VERSIONS,
} from "../../../packages/toolchain/src/manifest";
import { runCliRelease } from "../../../scripts/release-cli";
import {
  runReleaseChannel,
  setManifestVersion,
  setWorkspaceVersion,
} from "../../../scripts/release-channel";
import {
  buildReleaseRequirements,
  generateReleaseRequirements,
  rawPublicKeyBase64,
  signReleaseRequirements,
  verifySignatureForRelease,
  type ReleaseRequirementSources,
} from "../../../scripts/release-requirements";

const COMMIT = "3f2a9c1d4e5f60718293a4b5c6d7e8f901234567";
const EXTEND_INFO = Object.fromEntries(
  Object.values(MACOS_PERMISSION_CATALOGUE)
    .flatMap((entry) => (entry.infoPlistKey ? [entry.infoPlistKey] : []))
    .map((key) => [key, `Usage for ${key}`]),
);

function sources(overrides: Partial<ReleaseRequirementSources> = {}): ReleaseRequirementSources {
  return {
    version: "2.21.0",
    commit: COMMIT,
    config: {
      compatibility: { minClientVersion: "2.20.0", minBackendVersion: "2.20.0" },
      egressHosts: [{ host: "GitHub.com", purposes: ["updates"] }],
    },
    extendInfo: EXTEND_INFO,
    storageMigrations: [
      { version: 3, name: "record-shape-upgrade" },
      { version: 2, name: "import-legacy-json-stores" },
    ],
    toolVersions: { gh: "2.102.0", claude: "2.1.296" },
    artifacts: [
      {
        name: "claude",
        version: "2.1.296",
        platform: "darwin",
        architecture: "arm64",
        archive: { allowedHosts: ["registry.npmjs.org", "github.com"] },
      },
    ],
    requiredImageCapabilities: { "workspace-prepare": 1 },
    imageCapabilities: { "workspace-prepare": 1 },
    containerDefaultDomains: ["github.com", "api.anthropic.com"],
    ...overrides,
  };
}

describe("building the manifest from sources", () => {
  test("derives every section from its owner", () => {
    const manifest = buildReleaseRequirements(sources());
    expect(manifest.channel).toBe("stable");
    expect(manifest.storage).toEqual({
      schemaVersion: 3,
      migrations: [
        { version: 2, name: "import-legacy-json-stores", reversible: false },
        { version: 3, name: "record-shape-upgrade", reversible: false },
      ],
    });
    expect(manifest.network.egressHosts).toEqual([
      { host: "api.anthropic.com", purposes: ["container-default"] },
      { host: "github.com", purposes: ["container-default", "toolchain", "updates"] },
      { host: "registry.npmjs.org", purposes: ["toolchain"] },
    ]);
    expect(manifest.permissions.macos.map((permission) => permission.id)).toEqual(
      Object.keys(MACOS_PERMISSION_CATALOGUE),
    );
    expect(manifest.permissions.macos.find((permission) => permission.id === "desktop")).toEqual({
      id: "desktop",
      label: "Desktop folder",
      settingsPane: "files-and-folders",
      infoPlistKey: "NSDesktopFolderUsageDescription",
      usage: "Usage for NSDesktopFolderUsageDescription",
      requirement: "required",
    });
    expect(Object.keys(manifest.toolchain.versions)).toEqual(["claude", "gh"]);
    expect(manifest.container).toEqual({
      image: "ghcr.io/orkestrator-ai/orkestrator-v2",
      tag: "2.21.0",
      requiredImageCapabilities: { "workspace-prepare": 1 },
      imageCapabilities: { "workspace-prepare": 1 },
    });
  });

  test("refuses a usage string no permission probes, and a probe without its usage string", () => {
    expect(() =>
      buildReleaseRequirements(
        sources({ extendInfo: { ...EXTEND_INFO, NSCameraUsageDescription: "camera" } }),
      ),
    ).toThrow("NSCameraUsageDescription but no MACOS_PERMISSION_CATALOGUE entry uses it");
    const { NSDownloadsFolderUsageDescription: _omitted, ...missing } = EXTEND_INFO;
    expect(() => buildReleaseRequirements(sources({ extendInfo: missing }))).toThrow(
      "downloads prompts with NSDownloadsFolderUsageDescription",
    );
  });

  test("refuses compatibility floors newer than the release and non-channel versions", () => {
    expect(() =>
      buildReleaseRequirements(
        sources({
          config: {
            ...sources().config,
            compatibility: { minClientVersion: "2.22.0", minBackendVersion: "2.0.0" },
          },
        }),
      ),
    ).toThrow("minClientVersion 2.22.0 is newer");
    expect(() => buildReleaseRequirements(sources({ version: "2.21.0-rc.1" }))).toThrow(
      "not a release channel version",
    );
  });
});

describe("generating from this repository", () => {
  test("is deterministic and carries the live pins", async () => {
    const first = await generateReleaseRequirements(undefined, { commit: COMMIT });
    const second = await generateReleaseRequirements(undefined, { commit: COMMIT });
    expect(first.text).toBe(second.text);
    expect(first.sha256).toBe(second.sha256);
    const manifest = parseReleaseRequirementsBytes(new TextEncoder().encode(first.text));
    const rootVersion = (JSON.parse(readFileSync("package.json", "utf8")) as { version: string })
      .version;
    expect(manifest.version).toBe(rootVersion);
    expect(manifest.toolchain.versions).toEqual({ ...PINNED_TOOL_VERSIONS });
    expect(manifest.toolchain.artifacts).toEqual(
      JSON.parse(JSON.stringify(PINNED_TOOLCHAIN_ARTIFACTS)),
    );
  });
});

describe("signing", () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const bytes = new TextEncoder().encode("{}\n");

  test("signs in the form clients verify, with the public key RELEASE_SIGNING_PUBLIC_KEYS lists", async () => {
    const signature = signReleaseRequirements(bytes, privateKey);
    expect(signature.endsWith("\n")).toBe(true);
    const key = rawPublicKeyBase64(privateKey);
    expect(await verifyReleaseRequirementsSignature(bytes, signature, [key])).toBe(true);
    await expect(verifySignatureForRelease(bytes, signature, [key])).resolves.toBeUndefined();
  });

  test("requires a signature only once keys are embedded", async () => {
    await expect(verifySignatureForRelease(bytes, null, [])).resolves.toBeUndefined();
    const key = rawPublicKeyBase64(privateKey);
    await expect(verifySignatureForRelease(bytes, null, [key])).rejects.toThrow(
      "requires a signed",
    );
    const other = generateKeyPairSync("ed25519").privateKey;
    await expect(
      verifySignatureForRelease(bytes, signReleaseRequirements(bytes, other), [key]),
    ).rejects.toThrow("does not verify");
  });
});

describe("release-channel CLI", () => {
  test("classifies versions and refuses ones on no channel", () => {
    expect(JSON.parse(runReleaseChannel(["classify", "2.22.0-beta.3"]))).toEqual({
      version: "2.22.0-beta.3",
      channel: "beta",
      tag: "v2.22.0-beta.3",
      npmDistTag: "beta",
      prerelease: true,
    });
    expect(() => runReleaseChannel(["classify", "2.22.0-rc.1"])).toThrow("not a release channel");
  });

  test("prints fully qualified container tags", () => {
    expect(
      runReleaseChannel([
        "container-tags",
        "2.22.0-beta.3",
        "--image",
        "ghcr.io/o/r",
        "--sha",
        "a".repeat(40),
      ]).split("\n"),
    ).toEqual([
      "ghcr.io/o/r:2.22.0-beta.3",
      "ghcr.io/o/r:beta",
      `ghcr.io/o/r:sha-${"a".repeat(40)}`,
    ]);
  });

  test("rewrites only the top-level version line", () => {
    const text =
      '{\n  "name": "x",\n  "version": "2.20.1",\n  "dependencies": {\n    "y": { "version": "1.0.0" }\n  }\n}\n';
    expect(setManifestVersion(text, "2.20.2-unstable.20261015.1.gabcdef0")).toBe(
      text.replace('"version": "2.20.1"', '"version": "2.20.2-unstable.20261015.1.gabcdef0"'),
    );
    expect(() => setManifestVersion('{"name":"x"}', "1.0.0")).toThrow("no top-level version");
  });

  test("sets every workspace manifest's version and derives the unstable version from the root", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "release-channel-"));
    try {
      const write = (file: string, version: string) => {
        const target = path.join(directory, file);
        Bun.spawnSync(["mkdir", "-p", path.dirname(target)]);
        writeFileSync(target, `{\n  "name": "${file}",\n  "version": "${version}"\n}\n`);
      };
      write("package.json", "2.20.1");
      write("apps/web/package.json", "2.20.1");
      write("bridges/pi-bridge/package.json", "2.20.1");
      write("packages/cli/package.json", "2.20.1");
      expect(
        runReleaseChannel(
          ["unstable-version", "--run", "7", "--sha", COMMIT, "--date", "2026-10-15T03:17:00Z"],
          directory,
        ),
      ).toBe("2.20.2-unstable.20261015.7.g3f2a9c1");
      expect(setWorkspaceVersion("2.20.2-unstable.20261015.7.g3f2a9c1", directory)).toEqual([
        "apps/web/package.json",
        "bridges/pi-bridge/package.json",
        "package.json",
        "packages/cli/package.json",
      ]);
      expect(
        JSON.parse(readFileSync(path.join(directory, "apps/web/package.json"), "utf8")).version,
      ).toBe("2.20.2-unstable.20261015.7.g3f2a9c1");
      expect(() => runReleaseChannel(["set-version", "2.21.0-rc.1"], directory)).toThrow(
        "not a release channel",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("release-cli", () => {
  function runtime(version: string, rootVersion = version) {
    const run = mock((_command: string[]) => {});
    return { run, runtime: { cliVersion: () => version, rootVersion: () => rootVersion, run } };
  }

  test.each([
    ["2.21.0", "latest"],
    ["2.22.0-beta.3", "beta"],
    ["2.22.0-unstable.20261015.7.g3f2a9c1", "unstable"],
  ])("publishes %s on the %s dist-tag, always explicitly", (version, tag) => {
    const { run, runtime: cli } = runtime(version);
    expect(runCliRelease(["publish"], cli)).toBe(tag);
    expect(run.mock.calls[0]![0]).toEqual([
      "bun",
      "publish",
      "--cwd",
      "packages/cli",
      "--access",
      "public",
      "--tag",
      tag,
    ]);
  });

  test("supports a dry run and refuses mismatched or non-channel versions", () => {
    const { run, runtime: cli } = runtime("2.21.0");
    runCliRelease(["publish", "--dry-run"], cli);
    expect(run.mock.calls[0]![0].at(-1)).toBe("--dry-run");
    expect(() => runCliRelease(["publish"], runtime("2.21.0", "2.21.1").runtime)).toThrow(
      "root package.json",
    );
    expect(() => runCliRelease(["publish"], runtime("2.21.0-rc.1").runtime)).toThrow(
      "not a release channel",
    );
    expect(() => runCliRelease(["publish", "--tag", "latest"], cli)).toThrow("usage:");
  });
});
