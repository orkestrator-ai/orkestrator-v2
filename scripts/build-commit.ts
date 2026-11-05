#!/usr/bin/env bun
/**
 * Print the commit a build of this tree should report, or nothing when none
 * describes it exactly. The `mise` build tasks export the result as
 * `ORKESTRATOR_BUILD_COMMIT`; printing nothing leaves the build reporting `null`.
 */
import path from "node:path";
import { readBuildCommit } from "../packages/protocol/src/node/build-commit.js";

process.stdout.write(readBuildCommit(path.resolve(import.meta.dir, "..")) ?? "");
