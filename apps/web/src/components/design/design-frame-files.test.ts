import { describe, expect, test } from "bun:test";
import {
  PX_TO_PT,
  base64ToBytes,
  buildPdf,
  buildZip,
  crc32,
  frameFileNames,
  rgbaToRgb,
  safeFileStem,
} from "./design-frame-files";
import { TINY_PNG_BASE64 } from "./design-test-backend";

const text = (bytes: Uint8Array) => new TextDecoder("latin1").decode(bytes);
const pipe = async (bytes: Uint8Array<ArrayBuffer>, through: GenericTransformStream) =>
  new Uint8Array(
    await new Response(
      new Blob([bytes]).stream().pipeThrough(through as TransformStream<Uint8Array, Uint8Array>),
    ).arrayBuffer(),
  );

/** Reads a store-only archive back through its central directory. */
function readZip(zip: Uint8Array) {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = zip.length - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  expect(view.getUint32(end + 12, true)).toBe(end - offset);
  const files: Array<{ name: string; data: Uint8Array; crc: number }> = [];
  for (let index = 0; index < count; index++) {
    expect(view.getUint32(offset, true)).toBe(0x02014b50);
    expect(view.getUint16(offset + 10, true)).toBe(0);
    const crc = view.getUint32(offset + 16, true);
    const size = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const name = new TextDecoder().decode(zip.subarray(offset + 46, offset + 46 + nameLength));
    const local = view.getUint32(offset + 42, true);
    expect(view.getUint32(local, true)).toBe(0x04034b50);
    expect(view.getUint32(local + 14, true)).toBe(crc);
    const localName = view.getUint16(local + 26, true);
    const start = local + 30 + localName + view.getUint16(local + 28, true);
    files.push({ name, crc, data: zip.subarray(start, start + size) });
    offset += 46 + nameLength;
  }
  return files;
}

describe("design frame files", () => {
  test("file names are safe, numbered in canvas order and unique", () => {
    expect(safeFileStem("01 · Keep or pass · List view")).toBe("01-Keep-or-pass-List-view");
    expect(safeFileStem("../../etc/passwd")).toBe("etc-passwd");
    expect(safeFileStem("···")).toBe("frame");
    expect(safeFileStem("", "design")).toBe("design");
    expect(frameFileNames(["Home", "Home", "home", "Détail"], "png")).toEqual([
      "01-Home.png",
      "02-Home.png",
      "03-home.png",
      "04-Detail.png",
    ]);
    expect(
      frameFileNames(
        ["x", "x"].map(() => "Same"),
        "webp",
      )[1],
    ).toBe("02-Same.webp");
    expect(
      frameFileNames(
        Array.from({ length: 120 }, () => "F"),
        "png",
      )[0],
    ).toBe("001-F.png");
  });

  test("crc32 matches the standard check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  test("a ZIP stores every file intact with UTF-8 names", () => {
    const png = base64ToBytes(TINY_PNG_BASE64);
    const zip = buildZip(
      [
        { name: "01-Home.png", data: png },
        { name: "02-Café.png", data: new Uint8Array([1, 2, 3]) },
      ],
      new Date(2026, 10, 17, 12, 30, 10),
    );
    const files = readZip(zip);
    expect(files.map((file) => file.name)).toEqual(["01-Home.png", "02-Café.png"]);
    expect(Array.from(files[0]!.data)).toEqual(Array.from(png));
    expect(files[0]!.crc).toBe(crc32(png));
    expect(Array.from(files[1]!.data)).toEqual([1, 2, 3]);
    // UTF-8 flag on both headers.
    expect(new DataView(zip.buffer).getUint16(6, true)).toBe(0x0800);
  });

  test("a PDF has one full-bleed image page per frame and a valid cross-reference table", () => {
    const rgb = new Uint8Array([255, 0, 0, 0, 0, 255]);
    const page = (width: number, height: number) => ({
      width: width * PX_TO_PT,
      height: height * PX_TO_PT,
      pixelWidth: width,
      pixelHeight: height,
      rgbDeflated: rgb,
    });
    const pdf = buildPdf([page(1480, 1016), page(390, 844)], "Keep or pass · Ünïcode");
    const body = text(pdf);
    expect(body.startsWith("%PDF-1.4\n")).toBe(true);
    expect(body.endsWith("%%EOF\n")).toBe(true);
    expect(body).toContain("/Type /Pages /Count 2 /Kids [4 0 R 7 0 R]");
    expect(body).toContain("/MediaBox [0 0 1110 762]");
    expect(body).toContain("/MediaBox [0 0 292.5 633]");
    expect(body).toContain("/Width 1480 /Height 1016 /ColorSpace /DeviceRGB");
    expect(body).toContain("q 1110 0 0 762 0 0 cm /Im0 Do Q");
    expect(body).toContain("/Title <FEFF004B0065");

    // Every xref entry points at its object's header.
    const startxref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(body)![1]);
    const table = body.slice(startxref).split("\n");
    expect(table[0]).toBe("xref");
    const count = Number(table[1]!.split(" ")[1]);
    expect(count).toBe(10);
    for (let id = 1; id < count; id++) {
      const offset = Number(table[2 + id]!.slice(0, 10));
      expect(body.slice(offset, offset + `${id} 0 obj`.length)).toBe(`${id} 0 obj`);
    }
    // Each stream's /Length is exact.
    for (const match of body.matchAll(/\/Length (\d+) >>\nstream\n/g)) {
      const start = match.index! + match[0].length;
      expect(body.slice(start + Number(match[1]), start + Number(match[1]) + 10)).toBe(
        "\nendstream",
      );
    }
  });

  test("the PDF image stream decodes as zlib to the RGB samples", async () => {
    const rgb = new Uint8Array([10, 20, 30, 40, 50, 60]);
    const zlib = await pipe(rgb, new CompressionStream("deflate"));
    const pdf = buildPdf([
      { width: 1.5, height: 0.75, pixelWidth: 2, pixelHeight: 1, rgbDeflated: zlib },
    ]);
    const match = /\/Filter \/FlateDecode \/Length (\d+) >>\nstream\n/.exec(text(pdf))!;
    const start = match.index + match[0].length;
    const stream = pdf.slice(start, start + Number(match[1]));
    expect(Array.from(await pipe(stream, new DecompressionStream("deflate")))).toEqual(
      Array.from(rgb),
    );
  });

  test("a PDF needs at least one page", () => {
    expect(() => buildPdf([])).toThrow("at least one page");
  });

  test("RGBA samples composite onto white", () => {
    expect(
      Array.from(rgbaToRgb(new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 128]))),
    ).toEqual([255, 0, 0, 255, 255, 255, 127, 127, 127]);
  });
});
