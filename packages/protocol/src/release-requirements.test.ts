import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  actionsOnHost,
  checkConsent,
  diffReleaseRequirements,
  parseReleaseRequirements,
  parseReleaseRequirementsBytes,
  requiredConsentIds,
  serializeReleaseRequirements,
  sha256Hex,
  verifyReleaseRequirementsSignature,
  type ReleaseRequirements,
} from "./release-requirements.js";

const COMMIT = "3f2a9c1d4e5f60718293a4b5c6d7e8f901234567";

function manifest(overrides: Partial<ReleaseRequirements> = {}): ReleaseRequirements {
  return {
    schema: "orkestrator-release-requirements",
    schemaVersion: 1,
    version: "2.21.0",
    channel: "stable",
    commit: COMMIT,
    compatibility: { updateProtocol: 1, minClientVersion: "2.20.0", minBackendVersion: "2.20.0" },
    storage: {
      schemaVersion: 3,
      migrations: [
        { version: 2, name: "import-legacy-json-stores", reversible: false },
        { version: 3, name: "record-shape-upgrade", reversible: false },
      ],
    },
    permissions: {
      macos: [
        {
          id: "desktop",
          label: "Desktop folder",
          settingsPane: "files-and-folders",
          infoPlistKey: "NSDesktopFolderUsageDescription",
          usage: "Agents work with files on the Desktop.",
          requirement: "required",
        },
        {
          id: "full-disk-access",
          label: "Full Disk Access",
          settingsPane: "full-disk-access",
          infoPlistKey: null,
          usage: null,
          requirement: "recommended",
        },
      ],
    },
    network: {
      egressHosts: [
        { host: "github.com", purposes: ["toolchain", "updates"] },
        { host: "registry.npmjs.org", purposes: ["toolchain"] },
      ],
    },
    toolchain: {
      versions: { claude: "2.1.296", gh: "2.102.0" },
      artifacts: [
        { name: "claude", version: "2.1.296", platform: "darwin", architecture: "arm64", extra: 1 },
      ],
    },
    container: {
      image: "ghcr.io/orkestrator-ai/orkestrator-v2",
      tag: "2.21.0",
      requiredImageCapabilities: { "workspace-prepare": 1 },
      imageCapabilities: { "workspace-prepare": 1, "network-policy": 2 },
    },
    ...overrides,
  };
}

function target(overrides: Partial<ReleaseRequirements> = {}): ReleaseRequirements {
  return manifest({
    version: "2.22.0",
    ...overrides,
    container: { ...manifest().container, tag: "2.22.0", ...overrides.container },
  });
}

describe("parsing", () => {
  test("round-trips a valid manifest and keeps unknown artifact fields", () => {
    const parsed = parseReleaseRequirements(JSON.parse(serializeReleaseRequirements(manifest())));
    expect(parsed).toEqual(manifest());
    expect(parsed.toolchain.artifacts[0]?.extra).toBe(1);
  });

  test.each([
    [{ schema: "x" }, "schema"],
    [{ schemaVersion: 2 }, "schemaVersion"],
    [{ version: "2.21.0-rc.1" }, "release channel version"],
    [{ channel: "beta" }, "does not match"],
    [{ commit: "abc" }, "commit"],
    [
      { compatibility: { updateProtocol: 1, minClientVersion: "x", minBackendVersion: "2.0.0" } },
      "semver",
    ],
    [{ network: { egressHosts: [{ host: "Bad Host", purposes: [] }] } }, "DNS name"],
    [{ storage: { schemaVersion: -1, migrations: [] } }, "non-negative"],
    [
      {
        toolchain: {
          versions: {},
          artifacts: [{ name: "../x", version: "1", platform: "darwin", architecture: "arm64" }],
        },
      },
      "lowercase identifier",
    ],
  ])("rejects %j", (override, message) => {
    expect(() => parseReleaseRequirements({ ...manifest(), ...override })).toThrow(message);
  });

  test("bounds the bytes it will parse and refuses invalid UTF-8", () => {
    expect(() => parseReleaseRequirementsBytes(new Uint8Array(512 * 1024 + 1))).toThrow(
      "too large",
    );
    expect(() => parseReleaseRequirementsBytes(new Uint8Array([0xff, 0xfe]))).toThrow("JSON");
  });
});

describe("serialization", () => {
  test("is deterministic regardless of key insertion order", async () => {
    const shuffled = JSON.parse(JSON.stringify(manifest())) as Record<string, unknown>;
    const reordered = Object.fromEntries(Object.entries(shuffled).reverse()) as ReleaseRequirements;
    const a = serializeReleaseRequirements(manifest());
    const b = serializeReleaseRequirements(reordered);
    expect(a).toBe(b);
    expect(a.endsWith("}\n")).toBe(true);
    expect(await sha256Hex(a)).toBe(await sha256Hex(new TextEncoder().encode(b)));
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("signatures", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const publicKeyBase64 = Buffer.from(raw).toString("base64");
  const bytes = new TextEncoder().encode(serializeReleaseRequirements(manifest()));
  const signature = sign(null, bytes, privateKey).toString("base64");

  test("verifies against any trusted key", async () => {
    const other = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" });
    const otherBase64 = Buffer.from(other.subarray(-32)).toString("base64");
    expect(
      await verifyReleaseRequirementsSignature(bytes, signature, [otherBase64, publicKeyBase64]),
    ).toBe(true);
  });

  test("rejects tampered bytes, wrong keys and malformed input", async () => {
    const tampered = new Uint8Array(bytes);
    tampered[10] ^= 1;
    expect(await verifyReleaseRequirementsSignature(tampered, signature, [publicKeyBase64])).toBe(
      false,
    );
    expect(await verifyReleaseRequirementsSignature(bytes, signature, [])).toBe(false);
    expect(await verifyReleaseRequirementsSignature(bytes, "not base64!", [publicKeyBase64])).toBe(
      false,
    );
    expect(await verifyReleaseRequirementsSignature(bytes, signature, ["AAAA"])).toBe(false);
  });
});

describe("diffing", () => {
  test("an identical manifest needs no consent", () => {
    const diff = diffReleaseRequirements(manifest(), target());
    expect(diff).toMatchObject({
      fromVersion: "2.21.0",
      toVersion: "2.22.0",
      baseline: "manifest",
    });
    expect(diff.items).toEqual([]);
    expect(checkConsent(diff, [])).toEqual({ ok: true });
  });

  test("new permissions, hosts, tools and migrations need consent; version bumps are informational", () => {
    const next = target({
      storage: {
        schemaVersion: 4,
        migrations: [
          ...manifest().storage.migrations,
          { version: 4, name: "split-sessions", reversible: false },
        ],
      },
      permissions: {
        macos: [
          ...manifest().permissions.macos.map((permission) =>
            permission.id === "full-disk-access"
              ? { ...permission, requirement: "required" as const }
              : permission,
          ),
          {
            id: "downloads",
            label: "Downloads folder",
            settingsPane: "files-and-folders",
            infoPlistKey: "NSDownloadsFolderUsageDescription",
            usage: "Agents work with Downloads.",
            requirement: "required",
          },
        ],
      },
      network: {
        egressHosts: [
          { host: "github.com", purposes: ["toolchain", "updates"] },
          { host: "api.example.com", purposes: ["toolchain"] },
        ],
      },
      toolchain: { versions: { claude: "2.1.300", gh: "2.102.0", kiro: "1.0.0" }, artifacts: [] },
    });
    const diff = diffReleaseRequirements(manifest(), next, { platform: "darwin" });
    const byId = new Map(diff.items.map((entry) => [entry.id, entry]));
    expect(byId.get("storage-migration:schema-4")).toMatchObject({
      consent: true,
      change: "changed",
    });
    expect(byId.get("storage-migration:schema-4")?.detail).toContain("split-sessions");
    expect(byId.get("macos-permission:downloads")).toMatchObject({
      consent: true,
      actionOnHost: true,
      change: "added",
    });
    expect(byId.get("macos-permission:full-disk-access")).toMatchObject({
      consent: true,
      actionOnHost: true,
    });
    expect(byId.get("network-egress:api.example.com")).toMatchObject({
      consent: true,
      change: "added",
    });
    expect(byId.get("network-egress:registry.npmjs.org")).toMatchObject({
      consent: false,
      change: "removed",
    });
    expect(byId.get("provider-binary:kiro")).toMatchObject({ consent: true, change: "added" });
    expect(byId.get("provider-binary:claude")).toMatchObject({ consent: false, change: "changed" });
    expect(requiredConsentIds(diff).sort()).toEqual([
      "macos-permission:downloads",
      "macos-permission:full-disk-access",
      "network-egress:api.example.com",
      "provider-binary:kiro",
      "storage-migration:schema-4",
    ]);
    expect(
      actionsOnHost(diff)
        .map((entry) => entry.id)
        .sort(),
    ).toEqual(["macos-permission:downloads", "macos-permission:full-disk-access"]);
    // Consent items precede informational ones.
    const firstInformational = diff.items.findIndex((entry) => !entry.consent);
    expect(diff.items.slice(firstInformational).every((entry) => !entry.consent)).toBe(true);
    expect(checkConsent(diff, requiredConsentIds(diff).slice(1))).toMatchObject({
      ok: false,
      reason: "missing-consent",
    });
    expect(checkConsent(diff, requiredConsentIds(diff))).toEqual({ ok: true });
  });

  test("macOS permission items only apply to macOS hosts", () => {
    const next = target({ permissions: { macos: [] } });
    expect(diffReleaseRequirements(manifest(), next, { platform: "linux" }).items).toEqual([]);
    expect(diffReleaseRequirements(manifest(), next).items.map((entry) => entry.change)).toEqual([
      "removed",
      "removed",
    ]);
  });

  test("without a baseline every need is listed and consent-category items need approval", () => {
    const diff = diffReleaseRequirements(null, target(), {
      currentVersion: "2.20.1",
      platform: "darwin",
    });
    expect(diff).toMatchObject({ baseline: "none", fromVersion: "2.20.1" });
    expect(diff.items.every((entry) => entry.change === "required")).toBe(true);
    expect(requiredConsentIds(diff).sort()).toEqual([
      // The local image was not inspected, so its capabilities are unknown.
      "container-capability:workspace-prepare",
      "macos-permission:desktop",
      "network-egress:github.com",
      "network-egress:registry.npmjs.org",
      "storage-migration:schema-3",
    ]);
  });

  test("the database's actual schema version beats the baseline, and a lower target is blocked", () => {
    expect(
      diffReleaseRequirements(manifest(), target(), { storageSchemaVersion: 2 }).items,
    ).toMatchObject([{ id: "storage-migration:schema-3", change: "changed" }]);
    const blocked = diffReleaseRequirements(manifest(), target(), { storageSchemaVersion: 4 });
    expect(blocked.items[0]).toMatchObject({ id: "storage-migration:floor-3", blocking: true });
    expect(checkConsent(blocked, requiredConsentIds(blocked))).toEqual({
      ok: false,
      reason: "blocked",
      blockers: ["storage-migration:floor-3"],
    });
  });

  test("an old client is blocked until it updates itself", () => {
    const next = target({
      compatibility: { updateProtocol: 1, minClientVersion: "2.22.0", minBackendVersion: "2.21.0" },
    });
    expect(
      diffReleaseRequirements(manifest(), next, { clientVersion: "2.21.0" }).items[0],
    ).toMatchObject({
      id: "compatibility:client",
      blocking: true,
    });
    expect(diffReleaseRequirements(manifest(), next, { clientVersion: "2.22.0" }).items).toEqual(
      [],
    );
    expect(diffReleaseRequirements(manifest(), next, { clientVersion: null }).items).toEqual([]);
  });

  test("container capabilities compare against the local image when it was inspected", () => {
    const next = target({
      container: {
        ...target().container,
        requiredImageCapabilities: { "workspace-prepare": 1, "network-policy": 3 },
      },
    });
    expect(diffReleaseRequirements(manifest(), next).items).toMatchObject([
      { id: "container-capability:network-policy", consent: true, actionOnHost: false },
    ]);
    expect(
      diffReleaseRequirements(manifest(), next, {
        localImage: {
          capabilities: { "workspace-prepare": 1, "network-policy": 3 },
          source: "local",
        },
      }).items,
    ).toEqual([]);
    expect(
      diffReleaseRequirements(manifest(), next, {
        localImage: { capabilities: { "workspace-prepare": 1 }, source: "local" },
      }).items,
    ).toMatchObject([{ id: "container-capability:network-policy", actionOnHost: true }]);
    expect(
      diffReleaseRequirements(manifest(), next, {
        localImage: { capabilities: {}, source: "published" },
      }).items.map((entry) => [entry.id, entry.actionOnHost]),
    ).toEqual([
      ["container-capability:workspace-prepare", false],
      ["container-capability:network-policy", false],
    ]);
    expect(diffReleaseRequirements(manifest(), next, { localImage: null }).items).toEqual([]);
  });
});
