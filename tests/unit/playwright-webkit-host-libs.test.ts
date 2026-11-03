/**
 * `scripts/playwright-webkit-host-libs.ts` builds a private Playwright browsers
 * directory in which WebKit finds the Ubuntu 24.04 libraries an Arch host
 * lacks. What matters is that it installs only bytes matching the pinned
 * digests, that nothing in a package can write outside the library directory,
 * and that it never changes the shared browser cache.
 *
 * Nothing here touches the network; packages are synthetic `.deb` files.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  HOST_LIBRARY_PACKAGES,
  type HostLibraryPackage,
  defaultPrivateDirectory,
  downloadVerifiedPackage,
  installLibraries,
  packageUrls,
  parseArgs,
  parseLddMissing,
  preparePrivateBrowsers,
  readAr,
  readTar,
  sharedBrowsersDirectory,
  sharedLibrariesInDeb,
  validatePrivateDirectory,
  WEBKIT_LIBRARY_DIRECTORY,
} from "../../scripts/playwright-webkit-host-libs";

const root = path.resolve(import.meta.dir, "..", "..");
const encoder = new TextEncoder();

interface FixtureEntry {
  path: string;
  data?: string;
  linkTarget?: string;
}

function concat(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function tarHeader(
  name: string,
  size: number,
  typeflag: string,
  linkTarget = "",
): Uint8Array<ArrayBuffer> {
  const header = new Uint8Array(512);
  const put = (offset: number, value: string) => header.set(encoder.encode(value), offset);
  put(0, name);
  put(100, "0000644\0");
  put(108, "0000000\0");
  put(116, "0000000\0");
  put(124, `${size.toString(8).padStart(11, "0")}\0`);
  put(136, "00000000000\0");
  put(148, "        ");
  put(156, typeflag);
  put(157, linkTarget);
  put(257, "ustar\0");
  put(263, "00");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  put(148, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

function padded(data: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(Math.ceil(data.length / 512) * 512);
  out.set(data);
  return out;
}

function makeTar(entries: readonly FixtureEntry[]): Uint8Array<ArrayBuffer> {
  const parts: Uint8Array[] = [];
  for (const entry of entries) {
    if (entry.path.length > 100) {
      const longName = encoder.encode(`${entry.path}\0`);
      parts.push(tarHeader("././@LongLink", longName.length, "L"), padded(longName));
    }
    const name = entry.path.slice(0, 100);
    if (entry.linkTarget !== undefined) {
      parts.push(tarHeader(name, 0, "2", entry.linkTarget));
    } else {
      const data = encoder.encode(entry.data ?? "");
      parts.push(tarHeader(name, data.length, "0"), padded(data));
    }
  }
  parts.push(new Uint8Array(1024));
  return concat(parts);
}

function arMember(name: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const header =
    name.padEnd(16) +
    "0".padEnd(12) +
    "0".padEnd(6) +
    "0".padEnd(6) +
    "100644".padEnd(8) +
    String(data.length).padEnd(10) +
    "`\n";
  const pad = data.length % 2 ? new Uint8Array([0x0a]) : new Uint8Array();
  return concat([encoder.encode(header), data, pad]);
}

function makeDeb(entries: readonly FixtureEntry[]): Uint8Array<ArrayBuffer> {
  return concat([
    encoder.encode("!<arch>\n"),
    arMember("debian-binary", encoder.encode("2.0\n")),
    arMember("control.tar.zst", Bun.zstdCompressSync(makeTar([]))),
    arMember("data.tar.zst", Bun.zstdCompressSync(makeTar(entries))),
  ]);
}

function pinFor(name: string, bytes: Uint8Array): HostLibraryPackage {
  return {
    name,
    version: "1.0-1",
    filename: `pool/main/x/${name}/${name}_1.0-1_amd64.deb`,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "webkit-host-libs-test-"));
}

const LIB = "./usr/lib/x86_64-linux-gnu";

describe("package reading", () => {
  test("reads the libraries a package installs into the multiarch directory", () => {
    const deb = makeDeb([
      { path: `${LIB}/libicuuc.so.74.2`, data: "icu" },
      { path: `${LIB}/libicuuc.so.74`, linkTarget: "libicuuc.so.74.2" },
      { path: "./usr/share/doc/libicu74/copyright", data: "doc" },
    ]);
    expect(readAr(deb).map((member) => member.name)).toEqual([
      "debian-binary",
      "control.tar.zst",
      "data.tar.zst",
    ]);
    const libraries = sharedLibrariesInDeb(deb);
    expect(libraries.map((library) => library.name)).toEqual([
      "libicuuc.so.74.2",
      "libicuuc.so.74",
    ]);
    expect(new TextDecoder().decode(libraries[0]!.data)).toBe("icu");
    expect(libraries[1]!.linkTarget).toBe("libicuuc.so.74.2");
  });

  test("ignores anything that could name a path outside the library directory", () => {
    const deb = makeDeb([
      { path: `${LIB}/../../../../etc/libevil.so`, data: "x" },
      { path: `${LIB}/sub/libnested.so.1`, data: "x" },
      { path: `${LIB}/libescape.so.1`, linkTarget: "/etc/passwd" },
      { path: `${LIB}/librelative.so.1`, linkTarget: "../libother.so.1" },
      { path: `${LIB}/notalib.txt`, data: "x" },
      { path: `./usr/lib/aarch64-linux-gnu/libwrongarch.so.1`, data: "x" },
      { path: `${LIB}/libok.so.1`, data: "ok" },
    ]);
    expect(sharedLibrariesInDeb(deb).map((library) => library.name)).toEqual(["libok.so.1"]);
  });

  test("follows GNU long names", () => {
    const longName = `${LIB}/${"a".repeat(60)}/../lib${"b".repeat(60)}.so.1`;
    const entries = readTar(makeTar([{ path: longName, data: "x" }]));
    expect(entries.map((entry) => entry.path)).toEqual([longName]);
  });

  test("rejects a truncated archive", () => {
    const tar = makeTar([{ path: `${LIB}/libx.so.1`, data: "x".repeat(2000) }]);
    expect(() => readTar(tar.subarray(0, 1024))).toThrow(/truncated/);
    expect(() => readAr(encoder.encode("not an archive"))).toThrow(/not an ar archive/);
  });
});

describe("verified download", () => {
  const good = makeDeb([{ path: `${LIB}/libgood.so.1`, data: "good" }]);
  const pin = pinFor("libgood1", good);

  test("falls back to the next mirror when one serves the wrong bytes", async () => {
    const directory = await tempDir();
    const requested: string[] = [];
    try {
      const bytes = await downloadVerifiedPackage(pin, directory, async (url) => {
        requested.push(url);
        const body = requested.length === 1 ? new Uint8Array(good.length) : good;
        return new Response(body);
      });
      expect(Buffer.from(bytes).equals(Buffer.from(good))).toBe(true);
      expect(requested).toEqual(packageUrls(pin));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("refuses when no mirror serves the pinned bytes, and leaves nothing behind", async () => {
    const directory = await tempDir();
    try {
      const tampered = new Uint8Array(good);
      tampered[0] = tampered[0]! ^ 0xff;
      await expect(
        downloadVerifiedPackage(pin, directory, async () => new Response(tampered)),
      ).rejects.toThrow(/SHA-256/);
      await expect(
        downloadVerifiedPackage(pin, directory, async () => new Response(concat([good, good]))),
      ).rejects.toThrow(/more than the pinned/);
      await expect(
        downloadVerifiedPackage(pin, directory, async () => new Response("gone", { status: 404 })),
      ).rejects.toThrow(/HTTP 404/);
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("private browsers directory", () => {
  test("adds the libraries to a copy of WebKit and links the other browsers, leaving the shared cache alone", async () => {
    const base = await tempDir();
    try {
      const shared = path.join(base, "ms-playwright");
      const sharedWebkit = path.join(shared, "webkit-9999");
      const sharedLibs = path.join(sharedWebkit, WEBKIT_LIBRARY_DIRECTORY);
      await mkdir(sharedLibs, { recursive: true });
      await writeFile(path.join(sharedWebkit, "INSTALLATION_COMPLETE"), "");
      await writeFile(path.join(sharedLibs, "libbundled.so.1"), "bundle's own");
      await mkdir(path.join(shared, "chromium-1"), { recursive: true });
      await mkdir(path.join(shared, ".links"), { recursive: true });

      const deb = makeDeb([
        { path: `${LIB}/libextra.so.1.2`, data: "extra" },
        { path: `${LIB}/libextra.so.1`, linkTarget: "libextra.so.1.2" },
        { path: `${LIB}/libbundled.so.1`, data: "must not replace the bundle's copy" },
      ]);
      const pin = pinFor("libextra1", deb);
      let fetches = 0;
      const options = {
        directory: path.join(base, "private"),
        shared,
        revision: "9999",
        packages: [pin],
        fetchImpl: async () => {
          fetches += 1;
          return new Response(deb);
        },
        log: () => {},
      };

      const privateWebkit = await preparePrivateBrowsers(options);
      const privateLibs = path.join(privateWebkit, WEBKIT_LIBRARY_DIRECTORY);
      expect(await readFile(path.join(privateLibs, "libextra.so.1.2"), "utf8")).toBe("extra");
      expect(await readlink(path.join(privateLibs, "libextra.so.1"))).toBe("libextra.so.1.2");
      expect(await readFile(path.join(privateLibs, "libbundled.so.1"), "utf8")).toBe(
        "bundle's own",
      );
      expect(await readlink(path.join(options.directory, "chromium-1"))).toBe(
        path.join(shared, "chromium-1"),
      );
      expect((await readdir(options.directory)).sort()).toEqual(["chromium-1", "webkit-9999"]);
      expect((await readdir(sharedLibs)).sort()).toEqual(["libbundled.so.1"]);

      // A second run with the same pins reuses the prepared copy.
      await preparePrivateBrowsers(options);
      expect(fetches).toBe(1);
      // A changed pin rebuilds it.
      await preparePrivateBrowsers({ ...options, packages: [{ ...pin, version: "1.0-2" }] });
      expect(fetches).toBe(2);
      expect((await readdir(options.directory)).sort()).toEqual(["chromium-1", "webkit-9999"]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("asks for the engine when the shared cache has no complete WebKit", async () => {
    const base = await tempDir();
    try {
      await expect(
        preparePrivateBrowsers({
          directory: path.join(base, "private"),
          shared: path.join(base, "ms-playwright"),
          revision: "9999",
          log: () => {},
        }),
      ).rejects.toThrow(/playwright install webkit/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("never replaces an existing file in the library directory", async () => {
    const directory = await tempDir();
    try {
      await writeFile(path.join(directory, "libkeep.so.1"), "original");
      const installed = await installLibraries(
        [
          { name: "libkeep.so.1", data: encoder.encode("replacement") },
          { name: "libnew.so.1", data: encoder.encode("new") },
        ],
        directory,
      );
      expect(installed).toBe(1);
      expect(await readFile(path.join(directory, "libkeep.so.1"), "utf8")).toBe("original");
      expect((await lstat(path.join(directory, "libnew.so.1"))).mode & 0o777).toBe(0o644);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("refuses a directory inside the repository or overlapping the shared cache", () => {
    const shared = path.join(tmpdir(), "ms-playwright");
    expect(() => validatePrivateDirectory(path.join(root, "output", "browsers"), shared)).toThrow(
      /inside the repository/,
    );
    expect(() => validatePrivateDirectory(path.join(shared, "private"), shared)).toThrow(
      /overlaps/,
    );
    expect(() => validatePrivateDirectory(tmpdir(), shared)).toThrow(/overlaps/);
    expect(() =>
      validatePrivateDirectory(path.join(tmpdir(), "private-browsers"), shared),
    ).not.toThrow();
  });

  test("resolves the shared and private directories the way Playwright does", () => {
    expect(sharedBrowsersDirectory({}, "/home/u")).toBe("/home/u/.cache/ms-playwright");
    expect(sharedBrowsersDirectory({ XDG_CACHE_HOME: "/x" }, "/home/u")).toBe("/x/ms-playwright");
    expect(sharedBrowsersDirectory({ PLAYWRIGHT_BROWSERS_PATH: "/b" }, "/home/u")).toBe("/b");
    expect(sharedBrowsersDirectory({ PLAYWRIGHT_BROWSERS_PATH: "0" }, "/home/u")).toBe(
      "/home/u/.cache/ms-playwright",
    );
    expect(defaultPrivateDirectory({}, "/home/u")).toBe(
      "/home/u/.cache/orkestrator/playwright-browsers-ubuntu24.04-libs",
    );
  });
});

describe("pins and command line", () => {
  test("every pinned package is an amd64 Ubuntu pool file with a SHA-256 and HTTPS mirrors", () => {
    expect(HOST_LIBRARY_PACKAGES.map((pkg) => pkg.name).sort()).toEqual([
      "libflite1",
      "libicu74",
      "libxml2",
    ]);
    for (const pkg of HOST_LIBRARY_PACKAGES) {
      expect(pkg.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(pkg.size).toBeGreaterThan(0);
      expect(path.posix.basename(pkg.filename)).toBe(`${pkg.name}_${pkg.version}_amd64.deb`);
      expect(pkg.filename).toMatch(/^pool\/(main|universe)\//);
      for (const url of packageUrls(pkg)) expect(url.startsWith("https://")).toBe(true);
    }
  });

  test("parses ldd's not-found lines only", () => {
    const output = [
      "\tlinux-vdso.so.1 (0x00007ffd)",
      "\tlibicuuc.so.74 => not found",
      "\tlibxml2.so.2 => not found",
      "\tlibc.so.6 => /usr/lib/libc.so.6 (0x00007f)",
    ].join("\n");
    expect(parseLddMissing(output)).toEqual(["libicuuc.so.74", "libxml2.so.2"]);
  });

  test("parses its arguments", () => {
    expect(parseArgs([])).toEqual({
      printPath: false,
      force: false,
      launchCheck: true,
      help: false,
    });
    expect(parseArgs(["--dir", "/p", "--print-path", "--force", "--no-launch-check"])).toEqual({
      directory: "/p",
      printPath: true,
      force: true,
      launchCheck: false,
      help: false,
    });
    expect(parseArgs(["--dir=/q"]).directory).toBe("/q");
    expect(() => parseArgs(["--dir"])).toThrow(/needs a path/);
    expect(() => parseArgs(["--nope"])).toThrow(/unknown argument/);
  });

  test("a mise task runs the script and the testing guide points at it", async () => {
    const tasks = Bun.TOML.parse(await readFile(path.join(root, "mise.toml"), "utf8")) as {
      tasks: Record<string, { run?: string }>;
    };
    expect(tasks.tasks["test:preview:webkit-libs"]?.run).toBe(
      "bun scripts/playwright-webkit-host-libs.ts",
    );
    const guide = await readFile(path.join(root, "docs/development/testing-guide.md"), "utf8");
    expect(guide).toContain("mise run test:preview:webkit-libs");
  });
});
