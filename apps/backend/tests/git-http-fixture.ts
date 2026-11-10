/**
 * A smart-HTTP Git remote on loopback for tests: `git http-backend` behind
 * `Bun.serve`, on a port the kernel picks. With `credentials` it answers 401 to
 * any request without exactly that Basic authorization, as a private
 * repository does to an anonymous clone.
 */
import os from "node:os";

export type GitHttpRemote = {
  /** `http://127.0.0.1:<port>`; append `/<repository>` relative to `root`. */
  origin: string;
  /** Requests answered 401 for a missing or wrong authorization. */
  refused: () => number;
  stop: () => Promise<void>;
};

export function startGitHttpRemote(
  root: string,
  options: { credentials?: { username: string; password: string } } = {},
): GitHttpRemote {
  const expected = options.credentials
    ? `Basic ${Buffer.from(`${options.credentials.username}:${options.credentials.password}`).toString("base64")}`
    : null;
  let refused = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (expected && request.headers.get("authorization") !== expected) {
        refused += 1;
        return new Response("", {
          status: 401,
          headers: { "WWW-Authenticate": 'Basic realm="fixture"' },
        });
      }
      const url = new URL(request.url);
      const body = new Uint8Array(await request.arrayBuffer());
      const child = Bun.spawn(["git", "http-backend"], {
        env: {
          PATH: process.env.PATH ?? "",
          HOME: root,
          GIT_CONFIG_GLOBAL: os.devNull,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_PROJECT_ROOT: root,
          GIT_HTTP_EXPORT_ALL: "1",
          REQUEST_METHOD: request.method,
          PATH_INFO: decodeURIComponent(url.pathname),
          QUERY_STRING: url.search.slice(1),
          CONTENT_TYPE: request.headers.get("content-type") ?? "",
          CONTENT_LENGTH: String(body.byteLength),
          HTTP_CONTENT_ENCODING: request.headers.get("content-encoding") ?? "",
          HTTP_GIT_PROTOCOL: request.headers.get("git-protocol") ?? "",
          REMOTE_ADDR: "127.0.0.1",
          REMOTE_USER: options.credentials?.username ?? "",
        },
        stdin: body,
        stdout: "pipe",
        stderr: "ignore",
      });
      const output = Buffer.from(await new Response(child.stdout).arrayBuffer());
      await child.exited;
      const split = output.indexOf("\r\n\r\n");
      const headerText = output.subarray(0, split < 0 ? 0 : split).toString("latin1");
      const headers = new Headers();
      let status = 200;
      for (const line of headerText.split("\r\n")) {
        const colon = line.indexOf(":");
        if (colon <= 0) continue;
        const name = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).trim();
        if (name.toLowerCase() === "status") status = Number.parseInt(value, 10) || 500;
        else headers.append(name, value);
      }
      return new Response(output.subarray(split < 0 ? 0 : split + 4), { status, headers });
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    refused: () => refused,
    stop: () => server.stop(true),
  };
}
