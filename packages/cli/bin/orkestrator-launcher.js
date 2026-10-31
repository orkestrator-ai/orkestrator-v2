#!/usr/bin/env bun
/**
 * The process launchd or systemd runs for a standalone backend installed with
 * `orkestrator service install`.
 *
 * It starts `<dataDir>/backend/current`, with the Bun and serve arguments in
 * `service.json`, and supervises it:
 *
 * - A release that has not reached readiness (a backend-instance.json naming
 *   its process and version) gets two boots. After that the launcher points
 *   `current` back at `previous` and records the rollback, which the restored
 *   backend reports as the outcome of its update. A release restored this way
 *   runs with the serve arguments it had before the install that replaced it.
 * - Each boot that exits without reaching readiness is recorded, so
 *   `service install` can stop waiting and report it.
 * - When the backend exits after writing `restart-requested` (its self-update
 *   just switched `current`), the launcher starts the new release at once.
 * - SIGTERM and SIGINT are forwarded; the launcher then exits with the
 *   backend's status, and the service manager decides what happens next.
 *
 * This file is copied out of the release into `<dataDir>/backend/launcher.js`,
 * so it must not import anything outside Node's and Bun's built-ins. It
 * repeats the layout in `packages/protocol/src/node/standalone-service.ts`.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const MAX_BOOT_ATTEMPTS = 2;
const READY_TIMEOUT_MS = Number(process.env.ORKESTRATOR_LAUNCHER_READY_TIMEOUT_MS ?? 120_000);
const RETRY_DELAY_MS = Number(process.env.ORKESTRATOR_LAUNCHER_RETRY_DELAY_MS ?? 2_000);
const CRASH_DELAY_MS = Number(process.env.ORKESTRATOR_LAUNCHER_CRASH_DELAY_MS ?? 5_000);
const STOP_TIMEOUT_MS = Number(process.env.ORKESTRATOR_LAUNCHER_STOP_TIMEOUT_MS ?? 10_000);
const TOOLCHAIN_TIMEOUT_MS = 20 * 60 * 1000;

const dataDir = path.resolve(process.argv[2] ?? "");
if (!process.argv[2]) {
  console.error("usage: launcher.js <data-dir>");
  process.exit(2);
}
const root = path.join(dataDir, "backend");
const layout = {
  current: path.join(root, "current"),
  previous: path.join(root, "previous"),
  serviceFile: path.join(root, "service.json"),
  stateFile: path.join(root, "launcher-state.json"),
  restartMarker: path.join(root, "restart-requested"),
  instance: path.join(dataDir, "backend-instance.json"),
};

function log(message) {
  console.error(`[launcher] ${new Date().toISOString()} ${message}`);
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readState() {
  const value = readJson(layout.stateFile) ?? {};
  return {
    version: 1,
    lastReadyVersion: typeof value.lastReadyVersion === "string" ? value.lastReadyVersion : null,
    bootAttempts:
      value.bootAttempts && typeof value.bootAttempts === "object" ? value.bootAttempts : {},
    rollback: value.rollback ?? null,
    bootFailure: value.bootFailure ?? null,
  };
}

function writeState(state) {
  const temporary = `${layout.stateFile}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, layout.stateFile);
}

function linked(link) {
  try {
    return readlinkSync(link);
  } catch {
    return null;
  }
}

function pointLink(link, target) {
  const temporary = `${link}.${process.pid}.tmp`;
  rmSync(temporary, { force: true });
  symlinkSync(target, temporary);
  renameSync(temporary, link);
}

function entryOf(release) {
  return path.join(release, "node_modules", "orkestrator", "bin", "orkestrator.js");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const service = readJson(layout.serviceFile);
if (!service || typeof service.bun !== "string" || !Array.isArray(service.args)) {
  log(`${layout.serviceFile} is missing or invalid; run \`orkestrator service install\``);
  process.exit(1);
}

/**
 * After a rollback `current` and `previous` name the same release. Only then do
 * the arguments recorded for it apply: the same version reached by a later
 * self-update runs with the service's own.
 */
function serveArguments(version, previousVersion) {
  const target = service.rollbackTarget;
  return target?.version === version && previousVersion === version && Array.isArray(target.args)
    ? target.args
    : service.args;
}

let child = null;
let stopping = false;
let failedBoots = { version: null, exits: 0 };
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    stopping = true;
    if (child && child.exitCode === null) child.kill(signal);
    else process.exit(0);
  });
}

async function waitForReady(pid, version, exited) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline && !exited()) {
    const instance = readJson(layout.instance);
    if (instance && instance.pid === pid && instance.appVersion === version) return true;
    await sleep(500);
  }
  return false;
}

while (!stopping) {
  const target = linked(layout.current);
  if (!target) {
    log(`${layout.current} does not point at a release`);
    process.exit(1);
  }
  const release = path.resolve(root, target);
  const version = path.basename(release);
  const state = readState();

  if (version !== state.lastReadyVersion) {
    const attempts = (state.bootAttempts[version] ?? 0) + 1;
    const previousTarget = linked(layout.previous);
    const previousVersion = previousTarget ? path.basename(previousTarget) : null;
    if (attempts > MAX_BOOT_ATTEMPTS && previousTarget && previousVersion !== version) {
      log(
        `${version} did not start after ${MAX_BOOT_ATTEMPTS} attempts; rolling back to ${previousVersion}`,
      );
      pointLink(layout.current, previousTarget);
      state.bootAttempts[version] = 0;
      state.rollback = {
        failedVersion: version,
        restoredVersion: previousVersion,
        at: new Date().toISOString(),
      };
      writeState(state);
      continue;
    }
    state.bootAttempts[version] = attempts;
    writeState(state);
  }

  const entry = entryOf(release);
  // Idempotent and quick when nothing changed; a new release installs its pins.
  const toolchain = spawnSync(service.bun, [entry, "toolchain", "install", "--data-dir", dataDir], {
    stdio: ["ignore", "ignore", "inherit"],
    timeout: TOOLCHAIN_TIMEOUT_MS,
  });
  if (toolchain.status !== 0) log(`toolchain install for ${version} failed; starting anyway`);

  rmSync(layout.restartMarker, { force: true });
  log(`starting ${version}`);
  let exited = false;
  const serveArgs = serveArguments(version, path.basename(linked(layout.previous) ?? ""));
  child = spawn(
    service.bun,
    [entry, "serve", ...serveArgs, "--data-dir", dataDir, "--standalone-updater", root],
    { stdio: "inherit", env: process.env },
  );
  const exit = new Promise((resolve) =>
    child.once("exit", (code, signal) => {
      exited = true;
      resolve({ code, signal });
    }),
  );
  const ready = await waitForReady(child.pid, version, () => exited);
  if (ready) {
    const next = readState();
    next.lastReadyVersion = version;
    next.bootAttempts[version] = 0;
    next.bootFailure = null;
    writeState(next);
    failedBoots = { version: null, exits: 0 };
    log(`${version} is ready`);
  }
  if (!ready && !exited) {
    log(`${version} missed its readiness deadline; stopping it`);
    child.kill("SIGTERM");
    let timer;
    await Promise.race([
      exit,
      new Promise((resolve) => {
        timer = setTimeout(resolve, STOP_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timer);
    if (!exited) child.kill("SIGKILL");
  }
  const { code, signal } = await exit;
  child = null;
  if (stopping) process.exit(code ?? 0);
  if (existsSync(layout.restartMarker)) {
    log(`${version} exited to restart into ${path.basename(linked(layout.current) ?? "")}`);
    continue;
  }
  log(`${version} exited (code ${code ?? "none"}, signal ${signal ?? "none"})`);
  if (!ready) {
    failedBoots = {
      version,
      exits: failedBoots.version === version ? failedBoots.exits + 1 : 1,
    };
    const next = readState();
    next.bootFailure = { ...failedBoots, at: new Date().toISOString() };
    writeState(next);
  }
  await sleep(ready ? CRASH_DELAY_MS : RETRY_DELAY_MS);
}
