/**
 * The chromium engine, part 3 of 3: isolation, CSP sandbox and the viewer-shell attacks and channel.
 * The tests are defined once in `content-server.engines-lane-3-test-support.ts`;
 * this file runs them for chromium in its own `bun test --parallel` worker.
 */
import { defineEngineLane3 } from "./content-server.engines-lane-3-test-support.js";

defineEngineLane3("chromium");
