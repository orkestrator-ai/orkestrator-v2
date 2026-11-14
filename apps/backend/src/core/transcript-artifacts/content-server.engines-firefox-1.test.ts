/**
 * The firefox engine, part 1 of 3: frame ancestors, script hashes, network and forms.
 * The tests are defined once in `content-server.engines-lane-1-test-support.ts`;
 * this file runs them for firefox in its own `bun test --parallel` worker.
 */
import { defineEngineLane1 } from "./content-server.engines-lane-1-test-support.js";

defineEngineLane1("firefox");
