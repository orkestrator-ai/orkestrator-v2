/**
 * The webkit engine, part 2 of 3: popups, frame self-navigation, message validator and shell refusal.
 * The tests are defined once in `content-server.engines-lane-2-test-support.ts`;
 * this file runs them for webkit in its own `bun test --parallel` worker.
 */
import { defineEngineLane2 } from "./content-server.engines-lane-2-test-support.js";

defineEngineLane2("webkit");
