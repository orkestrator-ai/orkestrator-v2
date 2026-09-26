#!/usr/bin/env bun

import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = await Bun.file(path.join(packageRoot, "package.json")).json();
const version = typeof manifest.version === "string" ? manifest.version : "0.0.0";

// Decide service versus client before the backend is imported: help, version
// and client commands must never initialize storage, listeners, or bridges.
const client = await import("../dist/client.js");
const argv = process.argv.slice(2);
const invocation = client.classifyInvocation(argv);

if (invocation.mode === "serve") {
  // `serve` is an explicit spelling of the historical no-subcommand form; the
  // backend's own parser reads the remaining service options from argv.
  process.argv.splice(2, process.argv.length - 2, ...invocation.args);
  // The standalone bundle is deliberately laid out like the desktop resources,
  // but it lives in Bun's package cache instead of an application bundle. Make
  // those roots authoritative before main.ts calculates any path defaults.
  process.env.NODE_ENV ??= "production";
  process.env.ORKESTRATOR_APP_ROOT ??= packageRoot;
  process.env.ORKESTRATOR_RESOURCE_ROOT ??= path.join(packageRoot, "resources");
  process.env.ORKESTRATOR_VERSION ??= version;
  await import("../dist/main.js");
} else if (invocation.mode === "client") {
  process.exitCode = await client.runClientProcess(invocation.argv, version);
} else {
  process.exitCode = client.renderInvocationError(argv, invocation.message);
}
