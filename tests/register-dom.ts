// This must be a separate, earlier preload. Static imports in tests/setup.ts
// evaluate before that module's body, and Testing Library binds `screen` when
// it evaluates. Registering the document in the preceding preload keeps setup
// synchronous, which Bun requires for reliable mock.module registration.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
