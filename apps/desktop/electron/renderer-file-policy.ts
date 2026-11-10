import type { WebRequest } from "electron";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { answering } from "./webrequest-listener.js";

/** File origins do not scope CSP 'self' to a directory. Enforce that boundary separately. */
export function installRendererFilePolicy(
  webRequest: Pick<WebRequest, "onBeforeRequest">,
  trustedRendererUrl: string,
): void {
  if (!trustedRendererUrl.startsWith("file:")) return;
  // Resolve symlinks as well as URL escapes. A missing root fails closed.
  let root: string | undefined;
  try {
    root = realpathSync(path.dirname(fileURLToPath(trustedRendererUrl)));
  } catch {
    /* deny below */
  }
  // Renderer sessions own this listener; preview and artifact sessions are separate.
  webRequest.onBeforeRequest(
    { urls: ["file://*/*"] },
    answering(
      "renderer-file-policy",
      (details: { url: string }) => {
        let allowed = false;
        try {
          if (root) {
            const relative = path.relative(root, realpathSync(fileURLToPath(details.url)));
            allowed =
              relative !== ".." &&
              !relative.startsWith(`..${path.sep}`) &&
              !path.isAbsolute(relative);
          }
        } catch {
          /* Missing or malformed paths are refused. */
        }
        return { cancel: !allowed };
      },
      () => ({ cancel: true }),
    ),
  );
}
