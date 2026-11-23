// The benchmark overlays main.tsx onto archived revisions. Keep the browser
// specs' helpers here so the overlay does not depend on them.
import "./main";
import { installFixtureModules } from "./fixture-modules";

installFixtureModules();
