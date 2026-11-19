/**
 * Package registries: bounded HTTPS, safe tarball extraction, index
 * signatures, identity and the forbidden-source policy. Every fetch is the
 * injected in-memory one; no test touches the network.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

import {
  CAPABILITY_REGISTRY_LIMITS,
  type CapabilityRegistry,
} from "@orkestrator/protocol/capability-registry";
import { CAPABILITY_LIMITS } from "@orkestrator/protocol/capability-resources";

import {
  boundedHttpsGet,
  extractPackageTarball,
  fetchRegistryIndex,
  inspectRegistrySource,
  listRegistryPackages,
  registryLatestVersion,
  type RegistryContext,
} from "./registry.js";
import {
  fakeRegistryFetch,
  makeTarball,
  paxPathEntry,
  registryIndex,
  registryKey,
  sha256Of,
  skillTarball,
} from "./registry-test-support.js";

const INDEX = "https://registry.example.com/index.json";
const TARBALL = "https://cdn.example.com/review-1.0.0.tgz";

const registry = (extra: Partial<CapabilityRegistry> = {}): CapabilityRegistry => ({
  id: "team",
  label: "Team",
  indexUrl: INDEX,
  addedAt: "2026-11-19T00:00:00Z",
  updatedAt: "2026-11-19T00:00:00Z",
  ...extra,
});

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function workRoot() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "capability-registry-"));
  dirs.push(dir);
  return dir;
}

describe("tarball extraction", () => {
  test("unpacks the files under the subpath, keeping the executable bit", () => {
    const files = extractPackageTarball(
      makeTarball([
        { name: "package/", type: "5" },
        { name: "package/review/SKILL.md", content: "---\nname: review\n---\nBody" },
        { name: "package/review/run.sh", content: "#!/bin/sh", mode: 0o755 },
        { name: "other/ignored.md", content: "x" },
      ]),
      "package",
    );
    expect(files.map((file) => [file.path, file.executable])).toEqual([
      ["review/SKILL.md", false],
      ["review/run.sh", true],
    ]);
  });

  test("an uncompressed tar is read too", () => {
    const files = extractPackageTarball(
      makeTarball([{ name: "a/SKILL.md", content: "x" }], { gzip: false }),
    );
    expect(files[0]?.path).toBe("a/SKILL.md");
  });

  test.each([
    ["a parent-directory path", [{ name: "package/../../etc/passwd", content: "x" }], "escaping"],
    ["an absolute path", [{ name: "/etc/passwd", content: "x" }], "absolute"],
    ["a Windows drive path", [{ name: "C:/evil", content: "x" }], "absolute"],
    [
      "a pax path that escapes",
      [paxPathEntry("../outside"), { name: "fine.md", content: "x" }],
      "escaping",
    ],
    ["a symbolic link", [{ name: "link", type: "2", linkName: "/etc/passwd" }], "link"],
    ["a hard link", [{ name: "hard", type: "1", linkName: "package/x" }], "link"],
    ["a character device", [{ name: "dev", type: "3" }], "device"],
    ["a FIFO", [{ name: "fifo", type: "6" }], "FIFO"],
  ])("refuses %s", (_label, entries, message) => {
    expect(() => extractPackageTarball(makeTarball(entries))).toThrow(message);
  });

  test("refuses an archive that unpacks past the limit (a gzip bomb)", () => {
    const bomb = gzipSync(Buffer.alloc(CAPABILITY_REGISTRY_LIMITS.maxUnpackedBytes + 1024, 0));
    expect(() => extractPackageTarball(bomb)).toThrow("unpacks to more than the limit");
  });

  test("refuses a file over the per-file limit and a corrupted header", () => {
    const big = makeTarball(
      [{ name: "big.bin", content: Buffer.alloc(CAPABILITY_LIMITS.maxFileBytes + 1, 1) }],
      { gzip: false },
    );
    expect(() => extractPackageTarball(big)).toThrow("per-file limit");
    const corrupt = makeTarball([{ name: "a.md", content: "x" }], { gzip: false });
    corrupt[10] = 0x41;
    expect(() => extractPackageTarball(corrupt)).toThrow("malformed header");
  });

  test("an empty subpath result is reported", () => {
    expect(() => extractPackageTarball(skillTarball("review", "Body"), "missing")).toThrow(
      "nothing under that subpath",
    );
  });
});

describe("bounded HTTPS", () => {
  test("refuses http and credentials before fetching", async () => {
    const fetcher = fakeRegistryFetch(new Map());
    for (const url of ["http://registry.example.com/i.json", "https://u:p@registry.example.com/"]) {
      await expect(
        boundedHttpsGet(url, { fetch: fetcher, maxBytes: 10, timeoutMs: 1_000, what: "index" }),
      ).rejects.toThrow("https://");
    }
    expect(fetcher.calls).toEqual([]);
  });

  test("follows an https redirect but never a downgrade", async () => {
    const fetcher = fakeRegistryFetch(
      new Map<string, string | (() => Response)>([
        [
          "https://a.example.com/x",
          () => new Response(null, { status: 302, headers: { location: "/y" } }),
        ],
        ["https://a.example.com/y", "ok"],
        [
          "https://a.example.com/down",
          () =>
            new Response(null, { status: 301, headers: { location: "http://a.example.com/y" } }),
        ],
      ]),
    );
    const options = { fetch: fetcher, maxBytes: 100, timeoutMs: 1_000, what: "index" };
    expect((await boundedHttpsGet("https://a.example.com/x", options)).toString()).toBe("ok");
    await expect(boundedHttpsGet("https://a.example.com/down", options)).rejects.toThrow(
      "https://",
    );
  });

  test("stops reading past the size limit, declared or streamed", async () => {
    const fetcher = fakeRegistryFetch(
      new Map<string, string | (() => Response)>([
        ["https://a.example.com/streamed", "x".repeat(64)],
        [
          "https://a.example.com/declared",
          () => new Response("x", { status: 200, headers: { "content-length": "999999" } }),
        ],
        ["https://a.example.com/gone", () => new Response("no", { status: 410 })],
      ]),
    );
    const options = { fetch: fetcher, maxBytes: 16, timeoutMs: 1_000, what: "index" };
    await expect(boundedHttpsGet("https://a.example.com/streamed", options)).rejects.toThrow(
      "larger than the limit",
    );
    await expect(boundedHttpsGet("https://a.example.com/declared", options)).rejects.toThrow(
      "larger than the limit",
    );
    await expect(boundedHttpsGet("https://a.example.com/gone", options)).rejects.toThrow(
      "HTTP 410",
    );
  });

  test("gives up after the time limit", async () => {
    const hanging = (async (_url: string, init: { signal: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      })) as never;
    await expect(
      boundedHttpsGet("https://slow.example.com/", {
        fetch: hanging,
        maxBytes: 10,
        timeoutMs: 20,
        what: "registry index",
      }),
    ).rejects.toThrow("did not answer in time");
  });
});

describe("registry index", () => {
  const tarball = skillTarball("review", "Review carefully.");
  const packages = {
    "team/review": {
      displayName: "Review",
      latest: "1.0.0",
      versions: [
        {
          version: "1.0.0",
          tarball: { url: TARBALL, sha256: sha256Of(tarball), subpath: "package" },
        },
      ],
    },
  };

  test("a pinned key must sign the index", async () => {
    const key = registryKey();
    const signed = fakeRegistryFetch(
      new Map([[INDEX, JSON.stringify(registryIndex(packages, key))]]),
    );
    const index = await fetchRegistryIndex(registry({ signingKey: key.publicKey }), {
      fetch: signed,
    });
    expect(Object.keys(index.packages)).toEqual(["team/review"]);

    const tampered = structuredClone(registryIndex(packages, key));
    (tampered.packages as Record<string, { latest: string }>)["team/review"]!.latest = "1.0.0 ";
    const unsigned = registryIndex(packages);
    const other = registryIndex(packages, registryKey());
    for (const document of [tampered, unsigned, other]) {
      await expect(
        fetchRegistryIndex(registry({ signingKey: key.publicKey }), {
          fetch: fakeRegistryFetch(new Map([[INDEX, JSON.stringify(document)]])),
        }),
      ).rejects.toThrow("not signed by the registry's pinned key");
    }
  });

  test("a registry package is inspected at the published version under its registry identity", async () => {
    const fetcher = fakeRegistryFetch(
      new Map<string, string | Buffer>([
        [INDEX, JSON.stringify(registryIndex(packages))],
        [TARBALL, tarball],
      ]),
    );
    const context: RegistryContext = {
      registries: [registry()],
      forbiddenSources: [],
      workRoot: await workRoot(),
      fetch: fetcher,
    };
    const source = { kind: "registry" as const, registryId: "team", qualifiedId: "team/review" };
    const inspected = await inspectRegistrySource(source, context);
    expect(inspected.packageId).toBe("registry:team/team/review");
    expect(inspected.revision).toBe("1.0.0");
    expect(inspected.components.map((component) => component.kind)).toEqual(["skill"]);
    expect(await registryLatestVersion({ source }, context)).toBe("1.0.0");
    expect((await listRegistryPackages("team", context, "rev")).packages[0]).toMatchObject({
      qualifiedId: "team/review",
      latest: "1.0.0",
      versions: ["1.0.0"],
    });
    await expect(inspectRegistrySource(source, context, "9.9.9")).rejects.toThrow(
      "no longer in the registry",
    );
  });

  test("a tarball whose SHA-256 differs is refused before it is unpacked", async () => {
    const swapped = makeTarball([{ name: "package/../../evil", content: "x" }]);
    const context: RegistryContext = {
      registries: [registry()],
      forbiddenSources: [],
      workRoot: await workRoot(),
      fetch: fakeRegistryFetch(
        new Map<string, string | Buffer>([
          [INDEX, JSON.stringify(registryIndex(packages))],
          [TARBALL, swapped],
        ]),
      ),
    };
    await expect(
      inspectRegistrySource(
        { kind: "registry", registryId: "team", qualifiedId: "team/review" },
        context,
      ),
    ).rejects.toThrow("does not match the SHA-256");
  });

  test("forbiddenSources forbids a whole registry before anything is fetched", async () => {
    const fetcher = fakeRegistryFetch(new Map([[INDEX, JSON.stringify(registryIndex(packages))]]));
    const source = { kind: "registry" as const, registryId: "team", qualifiedId: "team/review" };
    for (const forbidden of ["registry:team/", "registry:team", "registry:"]) {
      const context: RegistryContext = {
        registries: [registry()],
        forbiddenSources: [forbidden],
        workRoot: await workRoot(),
        fetch: fetcher,
      };
      await expect(inspectRegistrySource(source, context)).rejects.toThrow("forbids");
      expect(await registryLatestVersion({ source }, context)).toBeNull();
    }
    expect(fetcher.calls).toEqual([]);
  });

  test("an unconfigured registry is named", async () => {
    await expect(
      inspectRegistrySource(
        { kind: "registry", registryId: "other", qualifiedId: "x" },
        { registries: [registry()], forbiddenSources: [], workRoot: await workRoot() },
      ),
    ).rejects.toThrow("No package registry named other");
  });

  test("a Git version goes through the safe Git fetch at the published commit", async () => {
    const commit = "a".repeat(40);
    const gitIndex = registryIndex({
      "team/lint": {
        latest: "2.0.0",
        versions: [
          {
            version: "2.0.0",
            git: { repo: "https://github.com/team/tools", subpath: "skills/lint", commit },
          },
        ],
      },
    });
    const calls: string[][] = [];
    let resolved = commit;
    const gitRun = (async (_command: string, args: string[] = []) => {
      calls.push(args);
      const dashC = args.indexOf("-C");
      const directory = dashC >= 0 ? args[dashC + 1]! : args[args.length - 1]!;
      if (args.includes("init")) await fs.mkdir(directory, { recursive: true });
      if (args.includes("checkout")) {
        const skill = path.join(directory, "skills", "lint");
        await fs.mkdir(skill, { recursive: true });
        await fs.writeFile(path.join(skill, "SKILL.md"), "---\nname: lint\n---\nLint.");
      }
      return { stdout: args.includes("rev-parse") ? `${resolved}\n` : "", stderr: "" };
    }) as never;
    const context: RegistryContext = {
      registries: [registry()],
      forbiddenSources: [],
      workRoot: await workRoot(),
      fetch: fakeRegistryFetch(new Map([[INDEX, JSON.stringify(gitIndex)]])),
      gitRun,
    };
    const source = { kind: "registry" as const, registryId: "team", qualifiedId: "team/lint" };
    const inspected = await inspectRegistrySource(source, context);
    expect(inspected.revision).toBe("2.0.0");
    expect(calls.some((args) => args.includes("fetch") && args.includes(commit))).toBe(true);
    expect(calls.flat()).toContain("core.hooksPath=/dev/null");

    resolved = "b".repeat(40);
    await expect(inspectRegistrySource(source, context)).rejects.toThrow(
      "did not resolve to the commit",
    );
    await expect(
      inspectRegistrySource(source, {
        ...context,
        forbiddenSources: ["git:github.com/team/tools"],
      }),
    ).rejects.toThrow("forbids the repository");
  });
});
