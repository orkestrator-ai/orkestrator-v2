import { configureGrokRuntime } from "./grok-runtime.js";

configureGrokRuntime(process.env);
await import("./index.js");
