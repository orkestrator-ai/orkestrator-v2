/**
 * Test fixtures for package registries: in-memory tarballs, signed indexes
 * and an injected fetch that serves them. No network is used.
 */
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import {
  CAPABILITY_REGISTRY_INDEX_FORMAT,
  capabilityRegistrySigningPayload,
} from "@orkestrator/protocol/capability-registry";

import { generateGraphSharingKeyPair, signGraphBundlePayload } from "../graph-template-signing.js";
import type { RegistryFetch } from "./registry.js";

export interface TarEntry {
  name: string;
  content?: string | Buffer;
  /** Tar type flag: "0" file, "5" directory, "2" symlink, "1" hard link, "3" device, "x" pax. */
  type?: string;
  mode?: number;
  linkName?: string;
}

function octal(value: number, length: number): string {
  return `${value.toString(8).padStart(length - 1, "0")}\0`;
}

function tarHeader(entry: TarEntry, size: number): Buffer {
  const header = Buffer.alloc(512, 0);
  header.write(entry.name.slice(0, 100), 0, "utf8");
  header.write(octal(entry.mode ?? 0o644, 8), 100, "latin1");
  header.write(octal(0, 8), 108, "latin1");
  header.write(octal(0, 8), 116, "latin1");
  header.write(octal(size, 12), 124, "latin1");
  header.write(octal(0, 12), 136, "latin1");
  header.write("        ", 148, "latin1");
  header.write(entry.type ?? "0", 156, "latin1");
  if (entry.linkName) header.write(entry.linkName, 157, "utf8");
  header.write("ustar\0", 257, "latin1");
  header.write("00", 263, "latin1");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
  return header;
}

/** A tar archive (gzip-compressed unless `gzip: false`). */
export function makeTarball(entries: TarEntry[], options: { gzip?: boolean } = {}): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const body = Buffer.isBuffer(entry.content)
      ? entry.content
      : Buffer.from(entry.content ?? "", "utf8");
    blocks.push(tarHeader(entry, body.length));
    blocks.push(body);
    const pad = (512 - (body.length % 512)) % 512;
    if (pad) blocks.push(Buffer.alloc(pad, 0));
  }
  blocks.push(Buffer.alloc(1024, 0));
  const tar = Buffer.concat(blocks);
  return options.gzip === false ? tar : gzipSync(tar);
}

/** A pax extended header whose `path` record overrides the next entry's name. */
export function paxPathEntry(pathValue: string): TarEntry {
  const record = (length: number) => `${length} path=${pathValue}\n`;
  let length = record(0).length;
  while (record(length).length !== length) length = record(length).length;
  return { name: "PaxHeader", type: "x", content: record(length) };
}

export function sha256Of(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export function skillTarball(name: string, body: string, root = "package"): Buffer {
  return makeTarball([
    { name: `${root}/`, type: "5", mode: 0o755 },
    {
      name: `${root}/${name}/SKILL.md`,
      content: `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n`,
    },
  ]);
}

/** A registry index document, optionally signed with `key`. */
export function registryIndex(
  packages: Record<string, unknown>,
  key?: { publicKey: string; privateKey: string; keyId: string },
): Record<string, unknown> {
  const document: Record<string, unknown> = {
    format: CAPABILITY_REGISTRY_INDEX_FORMAT,
    version: 1,
    packages,
  };
  if (key) {
    document.signature = {
      algorithm: "ed25519",
      keyId: key.keyId,
      value: signGraphBundlePayload(key, capabilityRegistrySigningPayload(document)),
    };
  }
  return document;
}

export function registryKey() {
  return generateGraphSharingKeyPair(new Date("2026-11-19T00:00:00Z"));
}

/**
 * A fetch over an in-memory map of https URLs. Each entry is a body, or a
 * `Response` factory for redirects and errors. Calls are counted.
 */
export function fakeRegistryFetch(
  routes: Map<string, Buffer | string | (() => Response)>,
): RegistryFetch & { calls: string[] } {
  const calls: string[] = [];
  const serve: RegistryFetch = async (input, init) => {
    calls.push(input);
    if (init.signal.aborted) throw new Error("aborted");
    const route = routes.get(input);
    if (route === undefined) return new Response("missing", { status: 404 });
    if (typeof route === "function") return route();
    return new Response(typeof route === "string" ? route : new Uint8Array(route), {
      status: 200,
    });
  };
  const fetcher = Object.assign(serve, { calls });
  return fetcher;
}
