/**
 * Pure file encoders for downloading frames as images: a store-only ZIP
 * archive, a PDF with one full-bleed image per page, and safe file names.
 * No DOM here, so every byte these produce is covered by unit tests; the
 * browser half (capture, rasterise, save) is `design-frame-download.ts`.
 */

export type DesignImageFormat = "png" | "webp" | "pdf";

/** Characters a file name keeps; everything else becomes a dash. */
export function safeFileStem(name: string, fallback = "frame"): string {
  const stem = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return stem || fallback;
}

/**
 * Unique file names for frames inside one archive, in canvas order, numbered
 * so they sort the way the frames are laid out ("01-Keep-or-pass.png").
 */
export function frameFileNames(names: readonly string[], extension: string): string[] {
  const width = Math.max(2, String(names.length).length);
  const used = new Set<string>();
  return names.map((name, index) => {
    const base = `${String(index + 1).padStart(width, "0")}-${safeFileStem(name)}`;
    let candidate = `${base}.${extension}`;
    for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${base}-${n}.${extension}`;
    used.add(candidate.toLowerCase());
    return candidate;
  });
}

export function base64ToBytes(data: string): Uint8Array<ArrayBuffer> {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

// ---------------------------------------------------------------------------
// ZIP (store only: PNG and WEBP are already compressed)

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index++)
    crc = CRC_TABLE[(crc ^ bytes[index]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.min(2107, Math.max(1980, date.getFullYear()));
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** Bounds of the classic (non-ZIP64) format this writer emits. */
export const ZIP_MAX_ENTRIES = 0xffff;
export const ZIP_MAX_BYTES = 0xffffffff;

/**
 * A ZIP archive of the given files, stored without compression. Names are
 * UTF-8 (general purpose flag bit 11).
 */
export function buildZip(
  files: ReadonlyArray<{ name: string; data: Uint8Array }>,
  modified = new Date(),
): Uint8Array<ArrayBuffer> {
  if (files.length > ZIP_MAX_ENTRIES) throw new Error("Too many files for one archive");
  const encoder = new TextEncoder();
  const stamp = dosDateTime(modified);
  const entries = files.map((file) => ({
    name: encoder.encode(file.name),
    data: file.data,
    crc: crc32(file.data),
  }));
  const localSize = entries.reduce(
    (sum, entry) => sum + 30 + entry.name.length + entry.data.length,
    0,
  );
  const centralSize = entries.reduce((sum, entry) => sum + 46 + entry.name.length, 0);
  const total = localSize + centralSize + 22;
  if (total > ZIP_MAX_BYTES) throw new Error("The archive is too large");
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let offset = 0;
  const offsets: number[] = [];
  for (const entry of entries) {
    offsets.push(offset);
    view.setUint32(offset, 0x04034b50, true);
    view.setUint16(offset + 4, 20, true); // version needed
    view.setUint16(offset + 6, 0x0800, true); // UTF-8 names
    view.setUint16(offset + 8, 0, true); // stored
    view.setUint16(offset + 10, stamp.time, true);
    view.setUint16(offset + 12, stamp.date, true);
    view.setUint32(offset + 14, entry.crc, true);
    view.setUint32(offset + 18, entry.data.length, true);
    view.setUint32(offset + 22, entry.data.length, true);
    view.setUint16(offset + 26, entry.name.length, true);
    view.setUint16(offset + 28, 0, true);
    out.set(entry.name, offset + 30);
    out.set(entry.data, offset + 30 + entry.name.length);
    offset += 30 + entry.name.length + entry.data.length;
  }
  const centralStart = offset;
  entries.forEach((entry, index) => {
    view.setUint32(offset, 0x02014b50, true);
    view.setUint16(offset + 4, 20, true); // version made by
    view.setUint16(offset + 6, 20, true); // version needed
    view.setUint16(offset + 8, 0x0800, true);
    view.setUint16(offset + 10, 0, true);
    view.setUint16(offset + 12, stamp.time, true);
    view.setUint16(offset + 14, stamp.date, true);
    view.setUint32(offset + 16, entry.crc, true);
    view.setUint32(offset + 20, entry.data.length, true);
    view.setUint32(offset + 24, entry.data.length, true);
    view.setUint16(offset + 28, entry.name.length, true);
    // extra, comment, disk, internal attributes, external attributes: zero.
    view.setUint32(offset + 42, offsets[index]!, true);
    out.set(entry.name, offset + 46);
    offset += 46 + entry.name.length;
  });
  view.setUint32(offset, 0x06054b50, true);
  view.setUint16(offset + 8, entries.length, true);
  view.setUint16(offset + 10, entries.length, true);
  view.setUint32(offset + 12, offset - centralStart, true);
  view.setUint32(offset + 16, centralStart, true);
  return out;
}

// ---------------------------------------------------------------------------
// PDF

/**
 * One page: an image `pixelWidth` × `pixelHeight`, as zlib-compressed 8-bit
 * RGB samples (FlateDecode), shown full bleed on a page `width` × `height`
 * points.
 */
export interface DesignPdfPage {
  width: number;
  height: number;
  pixelWidth: number;
  pixelHeight: number;
  /** zlib stream (RFC 1950) of the RGB samples, row by row. */
  rgbDeflated: Uint8Array;
}

/** CSS pixels to PDF points (96 px per inch, 72 pt per inch). */
export const PX_TO_PT = 72 / 96;

const pdfNumber = (value: number) => String(Math.round(value * 100) / 100);

/**
 * A PDF 1.4 document with one page per image. Lossless: slides keep crisp
 * text, unlike a JPEG (DCTDecode) page.
 */
export function buildPdf(pages: readonly DesignPdfPage[], title?: string): Uint8Array<ArrayBuffer> {
  if (pages.length === 0) throw new Error("A PDF needs at least one page");
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const offsets: number[] = [];
  const push = (chunk: string | Uint8Array) => {
    const bytes = typeof chunk === "string" ? encoder.encode(chunk) : chunk;
    chunks.push(bytes);
    length += bytes.length;
  };
  // Object numbers: 1 catalog, 2 pages, 3 info, then per page: page, content, image.
  const pageObject = (index: number) => 4 + index * 3;
  const object = (id: number, body: () => void) => {
    offsets[id] = length;
    push(`${id} 0 obj\n`);
    body();
    push("\nendobj\n");
  };
  push("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n");
  object(1, () => push("<< /Type /Catalog /Pages 2 0 R >>"));
  object(2, () =>
    push(
      `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, index) => `${pageObject(index)} 0 R`).join(" ")}] >>`,
    ),
  );
  object(3, () => {
    // Title as UTF-16BE hex so any name survives.
    const titleHex = title
      ? `/Title <FEFF${Array.from(title.slice(0, 200))
          .map((char) => {
            const code = char.codePointAt(0)!;
            const units =
              code > 0xffff
                ? [0xd800 + ((code - 0x10000) >> 10), 0xdc00 + ((code - 0x10000) & 0x3ff)]
                : [code];
            return units.map((unit) => unit.toString(16).toUpperCase().padStart(4, "0")).join("");
          })
          .join("")}> `
      : "";
    push(`<< ${titleHex}/Producer (Orkestrator) >>`);
  });
  pages.forEach((page, index) => {
    const id = pageObject(index);
    const width = pdfNumber(page.width);
    const height = pdfNumber(page.height);
    object(id, () =>
      push(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /XObject << /Im0 ${id + 2} 0 R >> >> /Contents ${id + 1} 0 R >>`,
      ),
    );
    const content = `q ${width} 0 0 ${height} 0 0 cm /Im0 Do Q`;
    object(id + 1, () => push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
    object(id + 2, () => {
      push(
        `<< /Type /XObject /Subtype /Image /Width ${page.pixelWidth} /Height ${page.pixelHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${page.rgbDeflated.length} >>\nstream\n`,
      );
      push(page.rgbDeflated);
      push("\nendstream");
    });
  });
  const count = 4 + pages.length * 3;
  const xref = length;
  let table = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let id = 1; id < count; id++) table += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  push(table);
  push(`trailer\n<< /Size ${count} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Drops alpha from RGBA samples, compositing onto white. */
export function rgbaToRgb(rgba: Uint8ClampedArray | Uint8Array): Uint8Array<ArrayBuffer> {
  const pixels = rgba.length / 4;
  const rgb = new Uint8Array(pixels * 3);
  for (let index = 0; index < pixels; index++) {
    const alpha = rgba[index * 4 + 3]! / 255;
    for (let channel = 0; channel < 3; channel++)
      rgb[index * 3 + channel] = Math.round(rgba[index * 4 + channel]! * alpha + 255 * (1 - alpha));
  }
  return rgb;
}
