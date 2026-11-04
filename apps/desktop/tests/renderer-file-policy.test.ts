import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { installRendererFilePolicy } from "../electron/renderer-file-policy";

test("renderer file requests are scoped to the real web root, including symlinks", () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "renderer-files-"));
  try {
    const root = path.join(temporary, "web");
    mkdirSync(root);
    writeFileSync(path.join(root, "index.html"), "");
    writeFileSync(path.join(root, "app.js"), "");
    const outside = path.join(temporary, "outside.js");
    writeFileSync(outside, "");
    symlinkSync(outside, path.join(root, "link.js"));
    let handler: any;
    installRendererFilePolicy(
      {
        onBeforeRequest: ((_filter: unknown, listener: unknown) => {
          handler = listener;
        }) as never,
      },
      pathToFileURL(path.join(root, "index.html")).href,
    );
    for (const [file, cancel] of [
      [path.join(root, "app.js"), false],
      [outside, true],
      [path.join(root, "link.js"), true],
      [path.join(root, "missing.js"), true],
    ] as const) {
      let result: unknown;
      handler({ url: pathToFileURL(file).href }, (value: unknown) => {
        result = value;
      });
      expect(result).toEqual({ cancel });
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
