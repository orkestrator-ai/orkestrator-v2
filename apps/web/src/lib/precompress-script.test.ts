import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import {
  contentTypeFor,
  precompressDirectory,
  shouldPrecompress,
  walk,
} from "../../scripts/precompress";

const tempDirectories: string[] = [];

async function createTempDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ork-precompress-test-"));
  tempDirectories.push(root);
  return root;
}

async function writeFixture(
  root: string,
  relativePath: string,
  content: string | Buffer,
): Promise<string> {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
  return filePath;
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

describe("precompress asset selection", () => {
  test("recognizes every eligible text extension and skips binary and compressed files", () => {
    const eligible = [
      "app.css",
      "index.html",
      "app.js",
      "worker.mjs",
      "manifest.json",
      "app.js.map",
      "icon.svg",
      "robots.txt",
      "feed.xml",
    ];
    for (const filePath of eligible) {
      expect(shouldPrecompress(filePath)).toBe(true);
    }

    for (const filePath of [
      "font.woff2",
      "photo.png",
      "archive.bin",
      "app.js.br",
      "app.js.gz",
    ]) {
      expect(shouldPrecompress(filePath)).toBe(false);
    }

    expect(contentTypeFor("APP.JS")).toBe("text/javascript");
    expect(contentTypeFor("font.woff2")).toBe("application/octet-stream");
  });
});

describe("precompressDirectory", () => {
  test("walks nested output and writes smaller, decodable Brotli and gzip siblings", async () => {
    const root = await createTempDirectory();
    const javascript = "console.log('representative asset');\n".repeat(400);
    const stylesheet = ".panel { color: rebeccapurple; }\n".repeat(300);
    const javascriptPath = await writeFixture(root, "assets/app.js", javascript);
    const stylesheetPath = await writeFixture(root, "nested/styles/app.css", stylesheet);

    const result = await precompressDirectory(root);

    expect(result).toEqual({
      compressedCount: 4,
      processedFileCount: 2,
    });
    for (const [sourcePath, source] of [
      [javascriptPath, javascript],
      [stylesheetPath, stylesheet],
    ] as const) {
      const sourceSize = Buffer.byteLength(source);
      const brotli = await readFile(`${sourcePath}.br`);
      const gzip = await readFile(`${sourcePath}.gz`);
      expect(brotli.byteLength).toBeLessThan(sourceSize);
      expect(gzip.byteLength).toBeLessThan(sourceSize);
      expect(brotliDecompressSync(brotli).toString("utf8")).toBe(source);
      expect(gunzipSync(gzip).toString("utf8")).toBe(source);
    }

    const walked = [...await Array.fromAsync(walk(root))]
      .map((filePath) => path.relative(root, filePath))
      .sort();
    expect(walked).toContain("nested/styles/app.css");
    expect(walked).toContain("nested/styles/app.css.br");
    expect(walked).toContain("nested/styles/app.css.gz");
  });

  test("removes stale variants when compression is not beneficial", async () => {
    const root = await createTempDirectory();
    const sourcePath = await writeFixture(root, "tiny.txt", "x");
    await writeFile(`${sourcePath}.br`, "stale Brotli");
    await writeFile(`${sourcePath}.gz`, "stale gzip");

    const result = await precompressDirectory(root);

    expect(result).toEqual({
      compressedCount: 0,
      processedFileCount: 1,
    });
    await expect(stat(`${sourcePath}.br`)).rejects.toThrow();
    await expect(stat(`${sourcePath}.gz`)).rejects.toThrow();
  });

  test("leaves binary files and orphan compressed siblings untouched", async () => {
    const root = await createTempDirectory();
    const font = Buffer.from([0, 1, 2, 3, 4, 5]);
    await writeFixture(root, "assets/font.woff2", font);
    await writeFixture(root, "assets/orphan.js.br", "existing Brotli");
    await writeFixture(root, "assets/orphan.js.gz", "existing gzip");

    const result = await precompressDirectory(root);

    expect(result).toEqual({
      compressedCount: 0,
      processedFileCount: 0,
    });
    expect(await readFile(path.join(root, "assets/font.woff2"))).toEqual(font);
    expect(await readFile(path.join(root, "assets/orphan.js.br"), "utf8"))
      .toBe("existing Brotli");
    expect(await readFile(path.join(root, "assets/orphan.js.gz"), "utf8"))
      .toBe("existing gzip");
    expect((await readdir(path.join(root, "assets"))).sort()).toEqual([
      "font.woff2",
      "orphan.js.br",
      "orphan.js.gz",
    ]);
  });
});

describe("web build asset contract", () => {
  test("runs precompression after Vite and references bundled WOFF2 fonts", async () => {
    const webRoot = path.resolve(import.meta.dir, "../..");
    const packageJson = JSON.parse(
      await readFile(path.join(webRoot, "package.json"), "utf8"),
    ) as { scripts?: { build?: string } };
    expect(packageJson.scripts?.build).toBe(
      "bunx tsc && bunx vite build && bun run scripts/precompress.ts",
    );

    const stylesheet = await readFile(path.join(webRoot, "src/index.css"), "utf8");
    for (const weight of ["Regular", "Bold"]) {
      const fileName = `FiraCodeNerdFont-${weight}.woff2`;
      expect(stylesheet).toContain(`url("./assets/fonts/${fileName}") format("woff2")`);
      const fontStat = await stat(path.join(webRoot, "src/assets/fonts", fileName));
      expect(fontStat.isFile()).toBe(true);
      expect(fontStat.size).toBeGreaterThan(0);
    }
    expect(stylesheet).not.toContain(".ttf");
  });
});
