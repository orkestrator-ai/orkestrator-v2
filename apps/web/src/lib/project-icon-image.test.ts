import { describe, expect, test } from "bun:test";
import { fileFromHostImage, isProjectIconFile } from "./project-icon-image";

describe("isProjectIconFile", () => {
  test("accepts any image type, favicons included", () => {
    for (const type of ["image/png", "image/x-icon", "image/vnd.microsoft.icon", "image/svg+xml"]) {
      expect(isProjectIconFile({ name: "icon", type })).toBe(true);
    }
  });

  test("falls back to the name when the system gives a favicon no type", () => {
    expect(isProjectIconFile({ name: "favicon.ico", type: "" })).toBe(true);
    expect(isProjectIconFile({ name: "Logo.PNG", type: "" })).toBe(true);
    expect(isProjectIconFile({ name: "notes.txt", type: "" })).toBe(false);
  });

  test("rejects a typed file that is not an image", () => {
    expect(isProjectIconFile({ name: "favicon.ico", type: "text/plain" })).toBe(false);
  });
});

describe("fileFromHostImage", () => {
  test("rebuilds the host file's bytes, name and type", async () => {
    const file = fileFromHostImage({
      path: "/repo/public/favicon.ico",
      name: "favicon.ico",
      mimeType: "image/x-icon",
      base64: btoa(String.fromCharCode(0, 0, 1, 0, 255)),
    });

    expect(file.name).toBe("favicon.ico");
    expect(file.type).toBe("image/x-icon");
    expect(isProjectIconFile(file)).toBe(true);
    expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([0, 0, 1, 0, 255]);
  });
});

// Exercise the real decoder/canvas path; settings tests replace this module.
import { afterEach, beforeEach, mock, spyOn } from "bun:test";
import { MAX_PROJECT_ICON_LENGTH } from "@orkestrator/protocol/project-icon";
import { projectIconFromFile } from "./project-icon-image";

const PNG = "data:image/png;base64,YQ==";
const WEBP = "data:image/webp;base64,Yg==";
let image: HTMLImageElement;
let drawImage = mock((..._args: unknown[]) => {});
let encode = mock((_type?: string, _quality?: number) => PNG);
let restore: Array<() => void> = [];

beforeEach(() => {
  drawImage = mock((..._args: unknown[]) => {});
  encode = mock((_type?: string, _quality?: number) => PNG);
  class TestImage {
    naturalWidth = 240;
    naturalHeight = 120;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() {
      image = this as unknown as HTMLImageElement;
    }
    set src(_value: string) {}
  }
  const originalImage = globalThis.Image;
  globalThis.Image = TestImage as unknown as typeof Image;
  const createURL = spyOn(URL, "createObjectURL").mockReturnValue("blob:project-icon");
  const revokeURL = spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const context = spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage,
  } as unknown as CanvasRenderingContext2D);
  const dataURL = spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(
    (type, quality) => encode(type, quality),
  );
  restore = [
    () => {
      globalThis.Image = originalImage;
    },
    () => createURL.mockRestore(),
    () => revokeURL.mockRestore(),
    () => context.mockRestore(),
    () => dataURL.mockRestore(),
  ];
});

afterEach(() => {
  for (const reset of restore) reset();
});

const file = () => new File(["image"], "logo.ico", { type: "image/x-icon" });
const decoded = () => image.onload?.(new Event("load"));

test("waits for decode, centre-crops the wide image to 64x64, and releases its URL", async () => {
  const pending = projectIconFromFile(file());
  expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  expect(drawImage).not.toHaveBeenCalled();
  expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  decoded();
  expect(await pending).toBe(PNG);
  expect(drawImage).toHaveBeenCalledWith(image, 60, 0, 120, 120, 0, 0, 64, 64);
  expect(encode).toHaveBeenCalledWith("image/png", undefined);
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:project-icon");
});

test("centre-crops a tall image without stretching", async () => {
  const pending = projectIconFromFile(file());
  Object.assign(image, { naturalWidth: 80, naturalHeight: 160 });
  decoded();
  await pending;
  expect(drawImage).toHaveBeenCalledWith(image, 0, 40, 80, 80, 0, 0, 64, 64);
});

test("falls back to WebP when the PNG exceeds the bound", async () => {
  encode
    .mockReturnValueOnce(`data:image/png;base64,${"A".repeat(MAX_PROJECT_ICON_LENGTH)}`)
    .mockReturnValueOnce(WEBP);
  const pending = projectIconFromFile(file());
  decoded();
  expect(await pending).toBe(WEBP);
  expect(encode.mock.calls).toEqual([
    ["image/png", undefined],
    ["image/webp", 0.85],
  ]);
});

test("rejects conversions that remain too large", async () => {
  encode.mockReturnValue(`data:image/png;base64,${"A".repeat(MAX_PROJECT_ICON_LENGTH)}`);
  const pending = projectIconFromFile(file());
  decoded();
  await expect(pending).rejects.toThrow("could not be made small enough");
  expect(encode).toHaveBeenCalledTimes(2);
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
});

test("rejects unreadable images and releases the URL", async () => {
  const pending = projectIconFromFile(file());
  image.onerror?.(new Event("error"));
  await expect(pending).rejects.toThrow("could not be read");
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:project-icon");
  expect(drawImage).not.toHaveBeenCalled();
});

test("rejects empty images after decode and releases the URL", async () => {
  const pending = projectIconFromFile(file());
  Object.assign(image, { naturalWidth: 0 });
  decoded();
  await expect(pending).rejects.toThrow("image is empty");
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
});

test("reports a missing 2D context and releases the URL", async () => {
  spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  const pending = projectIconFromFile(file());
  decoded();
  await expect(pending).rejects.toThrow("cannot resize images");
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
});

test("rejects non-images before creating an object URL", async () => {
  await expect(
    projectIconFromFile(new File(["x"], "notes.txt", { type: "text/plain" })),
  ).rejects.toThrow("Choose an image file");
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});
