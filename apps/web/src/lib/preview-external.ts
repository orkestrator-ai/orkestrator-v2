import type { BrowserPreviewServiceTarget } from "@orkestrator/protocol/browser-preview";
import { previewFailure } from "@orkestrator/protocol/preview-services";

import * as backend from "@/lib/backend";

/**
 * Submit the one-use grant to the bootstrap authority with a top-level POST in
 * a new browsing context. The grant never enters a URL, history entry, or
 * Referer, and the opened page gets no handle back to this window.
 *
 * Must run inside the user's click handler (before any await) or popup
 * blockers may silently drop it; callers therefore pre-open the window.
 */
export function submitPreviewBootstrap(
  target: Window,
  descriptor: { action: string; grant: string; attachmentId: string },
): void {
  const document = target.document;
  document.open();
  document.write(
    '<!doctype html><meta name="referrer" content="no-referrer"><title>Opening preview…</title><p style="font:14px system-ui">Opening preview…</p>',
  );
  document.close();
  const form = document.createElement("form");
  form.method = "POST";
  form.action = descriptor.action;
  form.enctype = "application/x-www-form-urlencoded";
  form.referrerPolicy = "no-referrer";
  for (const [name, value] of [
    ["attachment", descriptor.attachmentId],
    ["grant", descriptor.grant],
  ] as const) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
}

/**
 * Open a service preview in a normal browser tab.
 *
 * - Desktop: main owns the handoff (a one-use loopback page that POSTs the
 *   grant), because `shell.openExternal` can only carry a URL.
 * - Web client: pre-open a blank window synchronously in the click, obtain a
 *   short-lived grant through the authenticated control API, then POST it.
 */
export async function openServiceExternally(
  target: BrowserPreviewServiceTarget,
  options: { opener?: Window | null } = {},
): Promise<void> {
  const nativeOpen = window.orkestrator?.browserPreview?.openServiceExternally;
  if (nativeOpen) {
    await nativeOpen(target);
    return;
  }
  const pending = options.opener ?? window.open("about:blank", "_blank");
  if (!pending)
    throw previewFailure("unsupported", {
      message: "The browser blocked the preview window. Allow pop-ups and try again.",
    });
  try {
    pending.opener = null;
  } catch {
    // Some browsers disallow resetting opener on about:blank; noopener is best effort.
  }
  try {
    const attachment = await backend.createPreviewAttachment({
      serviceId: target.serviceId,
      surface: "browser-top-level",
      path: target.path,
      clientKey: "web-client",
    });
    if (!attachment.bootstrap) throw previewFailure("unsupported");
    submitPreviewBootstrap(pending, {
      ...attachment.bootstrap,
      attachmentId: attachment.attachmentId,
    });
  } catch (error) {
    pending.close();
    throw error;
  }
}

/** The clean, shareable private address of a published service (never a grant). */
export function previewPublicUrl(origin: string, path: string): string {
  return `${origin.replace(/\/$/, "")}${path}`;
}
