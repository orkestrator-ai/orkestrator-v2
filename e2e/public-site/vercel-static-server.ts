/**
 * Serves a built public client the way Vercel serves `apps/web-public`: a
 * matching file first, then `vercel.json`'s rewrites, with every matching
 * `headers` rule applied to the request path. `vite preview` sends none of
 * those headers, so a page that only works without the hosted policies would
 * pass under it; under this server the browser enforces the same
 * Content-Security-Policy a deployment sends.
 *
 * The matching is `apps/web-public/vercel-routing.ts`'s model of Vercel. Only a
 * real deployment proves Vercel itself matches that way (7568, 4650 task 1).
 *
 * Usage: bun vercel-static-server.ts --dist <dir> --config <vercel.json> --port <n>
 */
import { realpathSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  type VercelConfig,
  vercelHeadersFor,
  vercelRewriteFor,
} from "../../apps/web-public/vercel-routing";

const { values } = parseArgs({
  options: {
    dist: { type: "string" },
    config: { type: "string" },
    port: { type: "string" },
    host: { type: "string", default: "127.0.0.1" },
  },
});
if (!values.dist || !values.config || !values.port) {
  throw new Error("Usage: vercel-static-server.ts --dist <dir> --config <vercel.json> --port <n>");
}

const distDirectory = realpathSync(values.dist);
const config = (await Bun.file(values.config).json()) as VercelConfig;

/** The file a path names inside the build, or null for a missing file or one outside it. */
async function fileFor(pathname: string): Promise<ReturnType<typeof Bun.file> | null> {
  const relative = pathname.endsWith("/") ? `${pathname}index.html` : pathname;
  const resolved = path.resolve(distDirectory, `.${relative}`);
  if (resolved !== distDirectory && !resolved.startsWith(`${distDirectory}${path.sep}`)) {
    return null;
  }
  const file = Bun.file(resolved);
  if (!(await file.exists())) return null;
  // A directory reports as existing with no type worth serving.
  try {
    if ((await file.stat()).isDirectory()) return null;
  } catch {
    return null;
  }
  return file;
}

const server = Bun.serve({
  hostname: values.host,
  port: Number.parseInt(values.port, 10),
  async fetch(request) {
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      return new Response("Bad request", { status: 400 });
    }
    let file = await fileFor(pathname);
    if (!file) {
      const destination = vercelRewriteFor(config, pathname);
      if (destination) file = await fileFor(destination);
    }
    // Vercel applies header rules to the requested path, rewritten or not.
    const headers = new Headers();
    for (const header of vercelHeadersFor(config, pathname)) {
      headers.append(header.key, header.value);
    }
    if (!file) return new Response("Not found", { status: 404, headers });
    headers.set("Content-Type", file.type);
    return new Response(request.method === "HEAD" ? null : file, { headers });
  },
});

process.stdout.write(`Serving ${distDirectory} with vercel.json rules on ${server.url}\n`);
