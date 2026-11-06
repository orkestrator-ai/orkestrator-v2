// Test-only PATH shim. Never installed in the host PATH or used by production.
// `docker-qualification-bin/docker` runs this only for `network create` and
// execs the real CLI for everything else; the pass-through below serves direct
// invocations, which are short-lived.
import { spawnSync } from "node:child_process";
import path from "node:path";

// The credential-free backend allowlists environment variables. Resolve past
// this shim from PATH there, without broadening that credential boundary.
const shimDir = path.join(import.meta.dir, "docker-qualification-bin");
const real =
  process.env.ORKESTRATOR_QUALIFICATION_DOCKER ??
  Bun.which("docker", {
    PATH: (process.env.PATH ?? "")
      .split(path.delimiter)
      .filter((entry) => entry !== shimDir)
      .join(path.delimiter),
  });
if (!real) throw new Error("Missing qualification Docker executable");
const args = process.argv.slice(2);
const create = args[0] === "network" && args[1] === "create";
const owned = args.some((arg) => arg.startsWith("orkestrator-owner="));
if (!create || !owned || args.some((arg) => arg.startsWith("--subnet"))) {
  const result = spawnSync(real, args, { stdio: "inherit" });
  process.exit(result.status ?? 1);
}
let result = spawnSync(real, args, { encoding: "utf8" });
if (
  result.status !== 0 &&
  /all predefined address pools have been fully subnetted|could not find an available, non-overlapping IPv4 address pool/i.test(
    result.stderr,
  )
) {
  // The shared host can exhaust automatic pools. Use only otherwise-unrouted
  // /29s; Docker atomically refuses overlaps with other Docker allocations.
  const defaults = spawnSync("ip", ["-j", "route", "show", "default"], { encoding: "utf8" });
  const defaultRoute = defaults.status === 0 ? JSON.parse(defaults.stdout)[0] : undefined;
  for (let index = 0; index < 128; index++) {
    const base = `172.16.${240 + Math.floor(index / 32)}.${(index % 32) * 8}`;
    const route = spawnSync("ip", ["-j", "route", "get", base], { encoding: "utf8" });
    if (route.status !== 0) break; // No safe host-route check, no fallback.
    const routes = JSON.parse(route.stdout);
    // A gateway route is required; directly connected/VPN destinations stay untouched.
    if (
      !defaultRoute?.gateway ||
      routes[0]?.gateway !== defaultRoute.gateway ||
      routes[0]?.dev !== defaultRoute.dev
    )
      continue;
    result = spawnSync(real, ["network", "create", "--subnet", `${base}/29`, ...args.slice(2)], {
      encoding: "utf8",
    });
    if (result.status === 0 || !/overlap/i.test(result.stderr)) break;
  }
}
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
process.exit(result.status ?? 1);
