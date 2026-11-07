import type { Session } from "electron";
import { createLogger } from "@orkestrator/protocol/logger";
import { installRendererFilePolicy } from "./renderer-file-policy.js";
import { isTrustedRendererUrl } from "./trusted-renderer-url.js";

const log = createLogger("desktop.permissions");

/**
 * What the app's own document uses. Chromium asks for the clipboard write behind
 * `navigator.clipboard.writeText`, for fullscreen when a `<video controls>`
 * button is pressed, and for notifications behind the question alert's
 * `new Notification(...)` (whether one is shown is the user's setting).
 * Clipboard reads and images go through IPC instead.
 */
const GRANTED_PERMISSIONS: ReadonlySet<string> = new Set([
  "clipboard-sanitized-write",
  "fullscreen",
  "notifications",
]);

/**
 * Electron's default handler grants every request, so a script in the renderer
 * could take the camera or microphone without a prompt. Deny
 * everything the app does not use, and everything asked for by a subframe or
 * any document other than the renderer itself.
 *
 * Partitions outlive a window, and the legacy default session is shared, so the
 * handlers are replaced on every call. Their inputs are the same each time.
 */
export function installRendererPermissionPolicy(
  session: Pick<
    Session,
    "setPermissionCheckHandler" | "setPermissionRequestHandler" | "webRequest"
  >,
  trustedRendererUrl: string,
): void {
  installRendererFilePolicy(session.webRequest, trustedRendererUrl);
  const granted = (permission: string, requestingUrl: string | undefined, isMainFrame: boolean) =>
    isMainFrame &&
    GRANTED_PERMISSIONS.has(permission) &&
    requestingUrl !== undefined &&
    isTrustedRendererUrl(requestingUrl, trustedRendererUrl);

  // A refused permission fails silently in the page, so name each one once.
  const reported = new Set<string>();
  const decide = (permission: string, requestingUrl: string | undefined, isMainFrame: boolean) => {
    const allow = granted(permission, requestingUrl, isMainFrame);
    if (!allow && !reported.has(permission)) {
      reported.add(permission);
      log.info("denied", { permission });
    }
    return allow;
  };
  session.setPermissionCheckHandler((_contents, permission, _origin, details) =>
    decide(permission, details.requestingUrl, details.isMainFrame),
  );
  session.setPermissionRequestHandler((_contents, permission, callback, details) => {
    callback(decide(permission, details.requestingUrl, details.isMainFrame));
  });
}
