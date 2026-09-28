#!/usr/bin/env bun
/**
 * Image manifest generator and capability probe.
 *
 *   bun docker/image-manifest.ts generate --out <file>   (inside the image build)
 *   bun docker/image-manifest.ts capabilities --repo .   (on the build host)
 *
 * Capabilities are never declared by hand. Each contract script carries a
 * `ORKESTRATOR_CAPABILITY <name>=<version>` marker, and a capability is
 * declared only when its marker is present in the file installed at the
 * contract path. `generate` probes the installed image; `capabilities` probes
 * the repository sources those files are copied from, so the host can stamp
 * the same list into an image label. When the build passes that label value
 * in `ORKESTRATOR_IMAGE_CAPABILITIES`, `generate` fails unless the image
 * agrees with it.
 *
 * Versions come from the Dockerfile's ARG pins (passed as environment), not
 * from a second hand-maintained list.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import {
  IMAGE_CAPABILITIES,
  IMAGE_MANIFEST_SCHEMA_VERSION,
  formatCapabilityLabel,
  isImageCapability,
  parseImageManifest,
  type ImageCapability,
  type ImageManifest,
} from "../packages/protocol/src/image-manifest";

/** Installed contract file → repository source it is copied from. */
export const CONTRACT_FILES: ReadonlyArray<{ installed: string; source: string }> = [
  { installed: "/usr/local/bin/workspace-setup.sh", source: "docker/workspace-setup.sh" },
  { installed: "/usr/local/bin/entrypoint.sh", source: "docker/entrypoint.sh" },
  { installed: "/usr/local/bin/init-firewall.sh", source: "docker/init-firewall.sh" },
  {
    installed: "/usr/local/lib/orkestrator/firewall-domains.sh",
    source: "docker/firewall-domains.sh",
  },
  { installed: "/usr/local/bin/orkestrator-drain.sh", source: "docker/orkestrator-drain.sh" },
  { installed: "/usr/local/bin/orkestrator-storage.sh", source: "docker/orkestrator-storage.sh" },
  { installed: "/usr/local/bin/orkestrator-migrate.sh", source: "docker/orkestrator-migrate.sh" },
  {
    installed: "/usr/local/bin/orkestrator-log-writer",
    source: "docker/orkestrator-log-writer.sh",
  },
];

const MARKER = /ORKESTRATOR_CAPABILITY ([a-z-]+)=(\d+)/g;

export function probeCapabilities(
  read: (file: { installed: string; source: string }) => string | null,
): Partial<Record<ImageCapability, number>> {
  const found: Partial<Record<ImageCapability, number>> = {};
  for (const file of CONTRACT_FILES) {
    const text = read(file);
    if (text === null) continue;
    for (const match of text.matchAll(MARKER)) {
      const name = match[1];
      const version = Number(match[2]);
      if (!isImageCapability(name)) {
        throw new Error(`Unknown capability marker ${name} in ${file.source}`);
      }
      if (version > IMAGE_CAPABILITIES[name]) {
        throw new Error(
          `${file.source} declares ${name}=${version}, newer than the contract (${IMAGE_CAPABILITIES[name]})`,
        );
      }
      found[name] = Math.max(found[name] ?? 0, version);
    }
  }
  return found;
}

function readIfPresent(filePath: string): string | null {
  return existsSync(filePath) ? readFileSync(filePath, "utf8") : null;
}

function stateFormatsFor(
  capabilities: Partial<Record<ImageCapability, number>>,
): ImageManifest["stateFormats"] {
  if (!capabilities["persistent-workspace"]) return {};
  return {
    workspace: { read: [1], write: [1] },
    "provider-state": { read: [1], write: [1] },
  };
}

function env(name: string): string {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : "unknown";
}

/** Bridges the image ships: a built entry point, not merely a directory. */
export const IMAGE_BRIDGES = [
  "claude-bridge",
  "codex-bridge",
  "cursor-bridge",
  "pi-bridge",
  "acp-bridge",
] as const;

/** The version an installed CLI reports (first `x.y.z`), or null. */
export function reportedVersion(output: string): string | null {
  return /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/.exec(output)?.[1] ?? null;
}

/**
 * The version a CLI in the image reports. When the build pinned one, the two
 * must agree: the manifest names what is installed, never only what the
 * Dockerfile asked for.
 */
export function verifiedAgentVersion(
  name: string,
  pinned: string,
  run: (command: string) => string | null,
): string {
  const output = run(name);
  const installed = output === null ? null : reportedVersion(output);
  if (pinned !== "unknown") {
    if (!installed || installed !== pinned.replace(/^v/, "")) {
      throw new Error(`${name} reports ${installed ?? "no version"}; the image pins ${pinned}`);
    }
    return installed;
  }
  return installed ?? "unknown";
}

function runVersion(command: string): string | null {
  const result = spawnSync(command, ["--version"], { encoding: "utf8", timeout: 60_000 });
  if (result.status !== 0) return null;
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

function generate(outFile: string): void {
  const capabilities = probeCapabilities((file) => readIfPresent(file.installed));
  const expected = process.env.ORKESTRATOR_IMAGE_CAPABILITIES?.trim();
  const actual = formatCapabilityLabel(capabilities);
  if (expected && expected !== "unverified" && expected !== actual) {
    throw new Error(
      `Image capability label (${expected}) disagrees with the installed contracts (${actual})`,
    );
  }
  const packageJson = JSON.parse(readFileSync(env("ORKESTRATOR_PACKAGE_JSON"), "utf8")) as {
    version?: string;
  };
  const revision = process.env.ORKESTRATOR_SOURCE_REVISION?.trim();
  const manifest: ImageManifest = {
    schemaVersion: IMAGE_MANIFEST_SCHEMA_VERSION,
    appVersion: packageJson.version ?? "unknown",
    sourceRevision: revision && /^[0-9a-f]{7,40}$/.test(revision) ? revision : null,
    architecture: process.arch === "x64" ? "amd64" : process.arch,
    runtimes: {
      bun: verifiedAgentVersion("bun", env("BUN_VERSION"), runVersion),
      node: verifiedAgentVersion("node", env("NODE_VERSION"), runVersion),
    },
    agents: {
      claude: verifiedAgentVersion("claude", env("CLAUDE_CLI_VERSION"), runVersion),
      codex: verifiedAgentVersion("codex", env("CODEX_CLI_VERSION"), runVersion),
      opencode: verifiedAgentVersion("opencode", env("OPENCODE_CLI_VERSION"), runVersion),
      grok: verifiedAgentVersion("grok", env("GROK_BUILD_VERSION"), runVersion),
      pi: verifiedAgentVersion("pi", env("PI_CLI_VERSION"), runVersion),
      playwright: verifiedAgentVersion("playwright", env("PLAYWRIGHT_VERSION"), runVersion),
    },
    bridges: IMAGE_BRIDGES.filter((bridge) => existsSync(`/opt/${bridge}/dist/index.js`)),
    capabilities,
    stateFormats: stateFormatsFor(capabilities),
  };
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  // The reader's bounds apply to what is shipped: never publish a manifest the
  // backend would reject.
  const parsed = parseImageManifest(text);
  if (!parsed.ok) throw new Error(`Generated manifest is invalid: ${parsed.reason}`);
  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, text, { mode: 0o644 });
  console.log(`image manifest: ${actual || "(no capabilities)"}`);
}

function capabilitiesFromRepository(repo: string): string {
  return formatCapabilityLabel(
    probeCapabilities((file) => readIfPresent(path.join(repo, file.source))),
  );
}

if (import.meta.main) {
  const [command, flag, value] = process.argv.slice(2);
  try {
    if (command === "generate" && flag === "--out" && value) {
      generate(value);
    } else if (command === "capabilities" && flag === "--repo" && value) {
      process.stdout.write(`${capabilitiesFromRepository(value)}\n`);
    } else {
      throw new Error("usage: image-manifest.ts generate --out <file> | capabilities --repo <dir>");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
