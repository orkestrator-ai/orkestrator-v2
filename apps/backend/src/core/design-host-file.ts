import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { DESIGN_MAX_DOCUMENT_BYTES } from "@orkestrator/protocol/design-canvas";
import { DesignError } from "./design-errors.js";

/** One handle pins the selected file; no read or allocation exceeds the limit plus one sentinel byte. */
export async function readDesignHostFile(filePath: string, openFile = open): Promise<string> {
  const handle = await openFile(filePath, constants.O_RDONLY | constants.O_NONBLOCK).catch(() => {
    throw new DesignError("not-found", "That design file does not exist.");
  });
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new DesignError("not-found", "That design file does not exist.");
    if (info.size > DESIGN_MAX_DOCUMENT_BYTES)
      throw new DesignError("invalid-input", "Design file exceeds 4 MiB.");
    const buffer = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > info.size)
      throw new DesignError("invalid-input", "Design file changed during read. Choose it again.");
    return buffer.subarray(0, length).toString("utf8");
  } finally {
    await handle.close();
  }
}
