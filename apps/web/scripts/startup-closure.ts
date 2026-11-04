// Sizes what a renderer launch loads: index.html's static imports, plus
// renderer-entry (imported unconditionally at bootstrap) and its static imports.
//
//   bunx vite build --manifest && bun run scripts/startup-closure.ts [outDir] [rows]
import { readFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

interface ManifestChunk {
  file: string;
  isEntry?: boolean;
  imports?: string[];
}

const outDir = path.resolve(process.argv[2] ?? path.join(import.meta.dir, "../dist"));
const rows = Number(process.argv[3] ?? 15);
const manifest = JSON.parse(
  readFileSync(path.join(outDir, ".vite/manifest.json"), "utf8"),
) as Record<string, ManifestChunk>;

const closure = new Set<string>();
function visit(key: string): void {
  if (closure.has(key)) return;
  closure.add(key);
  for (const imported of manifest[key]?.imports ?? []) visit(imported);
}
for (const [key, chunk] of Object.entries(manifest)) {
  if (chunk.isEntry || key === "src/renderer-entry.tsx") visit(key);
}

const chunks = [...closure]
  .map((key) => {
    const file = manifest[key]!.file;
    const bytes = readFileSync(path.join(outDir, file));
    return { file, bytes: bytes.byteLength, gzip: gzipSync(bytes).byteLength };
  })
  .sort((a, b) => b.bytes - a.bytes);
const total = chunks.reduce((sum, chunk) => sum + chunk.bytes, 0);
const gzip = chunks.reduce((sum, chunk) => sum + chunk.gzip, 0);

console.log(`${chunks.length} chunks, ${total} bytes of JavaScript, ${gzip} gzip`);
for (const chunk of chunks.slice(0, rows)) {
  console.log(`${String(chunk.bytes).padStart(9)} ${String(chunk.gzip).padStart(8)} ${chunk.file}`);
}
