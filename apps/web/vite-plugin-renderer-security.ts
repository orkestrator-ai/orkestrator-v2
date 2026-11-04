import { createHash } from "node:crypto";
import {
  DESIGN_FRAME_DOCUMENT,
  RENDERER_CONTENT_SECURITY_POLICY,
} from "@orkestrator/protocol/renderer-content-security-policy";
import { runnerImport, type Plugin } from "vite";

const CHARSET_TAG = /<meta charset="[^"]*"\s*\/?>/i;

/** Adds the policy straight after the charset, ahead of every script and stylesheet. */
export function withRendererContentSecurityPolicy(html: string): string {
  if (!CHARSET_TAG.test(html)) {
    throw new Error("index.html needs a charset tag to place its Content-Security-Policy after");
  }
  return html.replace(
    CHARSET_TAG,
    (charset) =>
      `${charset}\n    <meta http-equiv="Content-Security-Policy" content="${RENDERER_CONTENT_SECURITY_POLICY}" />`,
  );
}

export function sha256Base64(script: string): string {
  return createHash("sha256").update(script).digest("base64");
}

/**
 * Through Vite's module runner because Vite's config bundler, which loads this
 * file, cannot follow the `.js` relative imports of the protocol's TypeScript.
 */
async function designFrameHtml(): Promise<string> {
  const { module } = await runnerImport<typeof import("@orkestrator/protocol/design-runtime")>(
    "@orkestrator/protocol/design-runtime",
    { configFile: false, logLevel: "error" },
  );
  return module.designFrameDocument(sha256Base64);
}

/**
 * Production builds only: the dev server's React preamble is an inline script
 * the policy would refuse, and a dev frame keeps using `srcdoc`.
 */
export function rendererSecurityPlugin(): Plugin {
  return {
    name: "orkestrator-renderer-security",
    apply: "build",
    config: () => ({
      define: {
        "import.meta.env.ORKESTRATOR_DESIGN_FRAME_DOCUMENT": JSON.stringify(DESIGN_FRAME_DOCUMENT),
      },
    }),
    transformIndexHtml: { order: "post", handler: withRendererContentSecurityPolicy },
    async generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: DESIGN_FRAME_DOCUMENT,
        source: await designFrameHtml(),
      });
    },
  };
}
