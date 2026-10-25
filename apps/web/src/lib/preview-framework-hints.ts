/**
 * Copyable framework setup hints for a service opened through a private
 * preview origin. They restate `docs/architecture/browser-previews.md`
 * §"Framework configuration" for one service, with its own origin filled in.
 * Orkestrator never edits the user's project; these are text to copy.
 *
 * Each hint names the versions it was written against. Keep them in step
 * with that section when the forwarding rules change.
 */
export interface FrameworkHint {
  id: string;
  framework: string;
  /** The versions the advice applies to, shown next to the framework. */
  versions: string;
  summary: string;
  /** File the snippet belongs in, for the label. */
  file: string;
  snippet: string;
}

/** Stand-in shown until the service is published on a private origin. */
export const PLACEHOLDER_PREVIEW_ORIGIN = "https://s-<service>.<preview domain>";

export function frameworkHints(options: {
  /** The service's private origin, or null when it is not published. */
  origin: string | null;
  applicationPort: number;
}): FrameworkHint[] {
  const origin = options.origin ?? PLACEHOLDER_PREVIEW_ORIGIN;
  const port = options.applicationPort;
  return [
    {
      id: "vite",
      framework: "Vite",
      versions: "5–7 (fixture: 7.3.6)",
      summary:
        "No setting is needed: requests arrive with Host localhost, so allowedHosts and hmr stay unset. A frontend and API on two services cannot fetch each other; proxy the API through Vite so the browser sees one service.",
      file: "vite.config.ts",
      snippet: [
        "export default defineConfig({",
        "  server: {",
        "    proxy: {",
        `      "/api": "http://localhost:<api port>",`,
        "    },",
        "  },",
        "});",
      ].join("\n"),
    },
    {
      id: "authjs-v5",
      framework: "Auth.js (NextAuth v5)",
      versions: "v5",
      summary:
        "Set the public origin explicitly. X-Forwarded-Host is omitted on same-service writes and fetches, so AUTH_TRUST_HOST alone builds localhost redirect URLs. Register the callback with your OAuth provider.",
      file: ".env.local",
      snippet: [
        `AUTH_URL=${origin}/api/auth`,
        `# OAuth redirect URI: ${origin}/api/auth/callback/<provider>`,
      ].join("\n"),
    },
    {
      id: "nextauth-v4",
      framework: "NextAuth.js",
      versions: "v4",
      summary: "Set the public origin and register the callback with your OAuth provider.",
      file: ".env.local",
      snippet: [
        `NEXTAUTH_URL=${origin}`,
        `# OAuth redirect URI: ${origin}/api/auth/callback/<provider>`,
      ].join("\n"),
    },
    {
      id: "nextjs",
      framework: "Next.js",
      versions: "14–16",
      summary:
        "Server Actions work without serverActions.allowedOrigins: a same-service Origin is mapped to the private origin and X-Forwarded-Host is dropped, so the CSRF check compares against Host. Build absolute URLs from a configured origin rather than the request.",
      file: ".env.local",
      snippet: `PUBLIC_ORIGIN=${origin}`,
    },
    {
      id: "express",
      framework: "Express",
      versions: "4–5",
      summary:
        "Trust the loopback proxy so req.protocol reads X-Forwarded-Proto (https). Build absolute URLs from a configured origin: X-Forwarded-Host is absent on same-service writes and fetches, and Host is localhost.",
      file: "server.js",
      snippet: [
        `app.set("trust proxy", "loopback");`,
        `const publicOrigin = process.env.PUBLIC_ORIGIN ?? "${origin}";`,
      ].join("\n"),
    },
    {
      id: "oauth",
      framework: "Any OAuth provider",
      versions: "all",
      summary:
        "Register the service's public origin and callback path with the provider. Silent renewal through a hidden iframe is refused on private origins; use refresh tokens, a popup, or a top-level redirect.",
      file: "OAuth app settings",
      snippet: [
        `Authorized origin: ${origin}`,
        `Redirect URI: ${origin}/<callback path>`,
        `# Local development without a preview: http://localhost:${port}/<callback path>`,
      ].join("\n"),
    },
  ];
}
