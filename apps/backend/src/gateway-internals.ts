// Single re-export surface for the gateway layers. `export *` forwards every
// value and type from the support modules as a live binding, which is what the
// mutable counters there (`activeDynamicCompressions`) need: an explicit
// `export const { ... } = support` reads each namespace accessor once, so it
// would shadow the star export with a value frozen at module-evaluation time.
export * from "./gateway-support.js";
