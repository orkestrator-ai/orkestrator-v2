#!/usr/bin/env bun

import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = await Bun.file(path.join(packageRoot, "package.json")).json();

// The standalone bundle is deliberately laid out like the desktop resources,
// but it lives in Bun's package cache instead of an application bundle. Make
// those roots authoritative before main.ts calculates any path defaults.
process.env.NODE_ENV ??= "production";
process.env.ORKESTRATOR_APP_ROOT ??= packageRoot;
process.env.ORKESTRATOR_RESOURCE_ROOT ??= path.join(packageRoot, "resources");
process.env.ORKESTRATOR_VERSION ??=
  typeof manifest.version === "string" ? manifest.version : "0.0.0";

await import("../dist/main.js");
