import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { brotliCompress, constants as zlibConstants, gzip } from "node:zlib";
import { promisify } from "node:util";

const brotliCompressAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

const distRoot = path.resolve(import.meta.dir, "../dist");

function contentTypeFor(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".css":
      return "text/css";
    case ".html":
      return "text/html";
    case ".js":
    case ".mjs":
      return "text/javascript";
    case ".json":
      return "application/json";
    case ".map":
      return "application/json";
    case ".svg":
      return "image/svg+xml";
    case ".txt":
      return "text/plain";
    case ".xml":
      return "application/xml";
    default:
      return "application/octet-stream";
  }
}

function shouldPrecompress(filePath: string): boolean {
  const contentType = contentTypeFor(filePath);
  if (contentType === "application/octet-stream") return false;
  if (contentType.startsWith("font/")) return false;
  if (contentType.startsWith("image/") && contentType !== "image/svg+xml") return false;
  return !filePath.endsWith(".br") && !filePath.endsWith(".gz");
}

async function* walk(root: string): AsyncGenerator<string> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walk(entryPath);
      continue;
    }
    if (entry.isFile()) yield entryPath;
  }
}

async function writeCompressedVariant(
  sourcePath: string,
  extension: ".br" | ".gz",
  content: Buffer,
): Promise<void> {
  const targetPath = `${sourcePath}${extension}`;
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, content);
}

async function removeVariant(sourcePath: string, extension: ".br" | ".gz"): Promise<void> {
  await rm(`${sourcePath}${extension}`, { force: true });
}

async function main(): Promise<void> {
  await stat(distRoot);
  let compressedCount = 0;
  for await (const filePath of walk(distRoot)) {
    if (!shouldPrecompress(filePath)) continue;
    const source = await readFile(filePath);

    const brotli = await brotliCompressAsync(source, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
      },
    });
    if (brotli.byteLength < source.byteLength) {
      await writeCompressedVariant(filePath, ".br", brotli);
      compressedCount += 1;
    } else {
      await removeVariant(filePath, ".br");
    }

    const gzipped = await gzipAsync(source, { level: 9 });
    if (gzipped.byteLength < source.byteLength) {
      await writeCompressedVariant(filePath, ".gz", gzipped);
      compressedCount += 1;
    } else {
      await removeVariant(filePath, ".gz");
    }
  }

  console.log(`[precompress] Wrote ${compressedCount} compressed asset variants in ${distRoot}`);
}

await main();
