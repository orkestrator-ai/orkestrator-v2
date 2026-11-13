import { describe, expect, test } from "bun:test";
import {
  projectDeclaresAptPackages,
  runtimeInstallsAptPackages,
} from "./container-apt-packages.js";
import type { GitBlobReader } from "./setup-approval.js";

function blobs(byRef: Record<string, string>): GitBlobReader & { reads: string[] } {
  const reads: string[] = [];
  const reader = (async (_projectPath: string, ref: string) => {
    reads.push(ref);
    return byRef[ref] ?? null;
  }) as GitBlobReader & { reads: string[] };
  reader.reads = reads;
  return reader;
}

const DECLARES = JSON.stringify({ aptPackages: ["libvips-dev"] });

describe("whether a new runtime reaches Debian's archive (to-do 7770)", () => {
  test("the environment's own branch decides when this checkout has it", async () => {
    const reader = blobs({
      "refs/remotes/origin/feature": JSON.stringify({ setupContainer: ["bun i"] }),
      "refs/remotes/origin/main": DECLARES,
    });
    expect(await projectDeclaresAptPackages("/repo", ["feature", "main"], reader)).toBe(false);
    expect(reader.reads).toEqual(["refs/remotes/origin/feature"]);
  });

  test("a branch this checkout does not have falls back to the one it starts from", async () => {
    const reader = blobs({ "refs/heads/main": DECLARES });
    expect(await projectDeclaresAptPackages("/repo", ["feature", "main"], reader)).toBe(true);
  });

  test("a list setup will refuse still counts, so setup can say why", async () => {
    const reader = blobs({ "refs/remotes/origin/main": JSON.stringify({ aptPackages: ["sudo"] }) });
    expect(await projectDeclaresAptPackages("/repo", ["main"], reader)).toBe(true);
  });

  test("no checkout, no branch, no file or an empty list opens nothing", async () => {
    expect(await projectDeclaresAptPackages(null, ["main"], blobs({}))).toBe(false);
    expect(await projectDeclaresAptPackages("/repo", ["main"], blobs({}))).toBe(false);
    expect(
      await projectDeclaresAptPackages(
        "/repo",
        ["main"],
        blobs({ "refs/remotes/origin/main": "" }),
      ),
    ).toBe(false);
    expect(
      await projectDeclaresAptPackages(
        "/repo",
        ["main"],
        blobs({ "refs/remotes/origin/main": JSON.stringify({ aptPackages: [] }) }),
      ),
    ).toBe(false);
    // An invalid branch name is never read.
    const reader = blobs({});
    expect(await projectDeclaresAptPackages("/repo", ["--upload-pack=x"], reader)).toBe(false);
    expect(reader.reads).toEqual([]);
  });

  test("only a restricted runtime behind a gateway, on a capable image, qualifies", () => {
    expect(
      runtimeInstallsAptPackages({
        networkMode: "restricted",
        enforcement: "gateway",
        imageAptPackagesVersion: 1,
      }),
    ).toBe(true);
    for (const input of [
      { networkMode: "full", enforcement: "none", imageAptPackagesVersion: 1 },
      { networkMode: "restricted", enforcement: "container", imageAptPackagesVersion: 1 },
      { networkMode: "restricted", enforcement: "gateway", imageAptPackagesVersion: 0 },
    ] as const) {
      expect(runtimeInstallsAptPackages(input)).toBe(false);
    }
  });
});
