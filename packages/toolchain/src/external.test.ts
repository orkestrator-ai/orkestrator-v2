import { describe, expect, test } from "bun:test";
import { parseExternalToolchainArtifacts, selectPrefetchArtifacts } from "./external.js";
import { PINNED_TOOLCHAIN_ARTIFACTS } from "./manifest.js";

const published = () =>
  JSON.parse(JSON.stringify(PINNED_TOOLCHAIN_ARTIFACTS)) as Array<Record<string, unknown>>;

describe("external toolchain artifacts", () => {
  test("accept every artifact this release pins, unchanged", () => {
    expect(parseExternalToolchainArtifacts(published())).toEqual(published() as never);
  });

  test("accept a tool this build does not know", () => {
    const [first] = published();
    const added = {
      ...first!,
      name: "kiro",
      executable: { ...(first!.executable as object), fileName: "kiro" },
    };
    expect(parseExternalToolchainArtifacts([added])[0]?.name).toBe("kiro" as never);
  });

  test.each([
    ["a name that is a path", (a: Record<string, any>) => ({ ...a, name: "../claude" })],
    [
      "plain HTTP",
      (a: Record<string, any>) => ({
        ...a,
        archive: { ...a.archive, url: a.archive.url.replace("https:", "http:") },
      }),
    ],
    [
      "a host outside allowedHosts",
      (a: Record<string, any>) => ({
        ...a,
        archive: { ...a.archive, allowedHosts: ["example.com"] },
      }),
    ],
    [
      "an entry path that escapes",
      (a: Record<string, any>) => ({ ...a, archive: { ...a.archive, entryPath: "../../bin/sh" } }),
    ],
    [
      "a short digest",
      (a: Record<string, any>) => ({ ...a, archive: { ...a.archive, sha256: "abc" } }),
    ],
    [
      "an executable file name with a slash",
      (a: Record<string, any>) => ({
        ...a,
        executable: { ...a.executable, fileName: "bin/claude" },
      }),
    ],
    ["an unknown platform", (a: Record<string, any>) => ({ ...a, platform: "win32" })],
    [
      "credentials in the URL",
      (a: Record<string, any>) => ({
        ...a,
        archive: { ...a.archive, url: a.archive.url.replace("https://", "https://user:pw@") },
      }),
    ],
  ])("refuse %s", (_name, mutate) => {
    const [first] = published();
    expect(() => parseExternalToolchainArtifacts([mutate(first!)])).toThrow();
  });

  test("refuse an unbounded list", () => {
    expect(() =>
      parseExternalToolchainArtifacts(Array.from({ length: 300 }, () => published()[0])),
    ).toThrow("bounded");
  });
});

describe("selecting what to prefetch", () => {
  const artifacts = parseExternalToolchainArtifacts(published());

  test("takes this machine's platform, its enabled agents, and every support tool", () => {
    const selected = selectPrefetchArtifacts(artifacts, {
      platform: "darwin",
      architecture: "arm64",
      enabledAgentPlatforms: ["claude"],
    });
    expect(selected.map((entry) => entry.name).sort()).toEqual(["claude", "gh"]);
    expect(
      selected.every((entry) => entry.platform === "darwin" && entry.architecture === "arm64"),
    ).toBe(true);
  });

  test("a new non-agent tool in the target is always fetched", () => {
    const [first] = published();
    const extra = parseExternalToolchainArtifacts([
      {
        ...first!,
        name: "kiro",
        platform: "linux",
        architecture: "x64",
        executable: { ...(first!.executable as object), fileName: "kiro" },
      },
    ]);
    expect(
      selectPrefetchArtifacts(extra, {
        platform: "linux",
        architecture: "x64",
        enabledAgentPlatforms: [],
      }).map((entry) => entry.name),
    ).toEqual(["kiro" as never]);
  });

  test("refuses two pins of one tool for the same machine", () => {
    const claude = artifacts.find(
      (entry) =>
        entry.name === "claude" && entry.platform === "linux" && entry.architecture === "x64",
    )!;
    expect(() =>
      selectPrefetchArtifacts([claude, { ...claude, version: "9.9.9" }], {
        platform: "linux",
        architecture: "x64",
        enabledAgentPlatforms: ["claude"],
      }),
    ).toThrow("twice");
  });
});
