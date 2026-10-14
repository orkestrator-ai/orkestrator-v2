// Some tests import a module through a query-suffixed specifier. Bun keys its
// module cache (and mock.module()) by the full specifier, so the suffix loads a
// fresh copy that bypasses the mocks registered for the plain path. TypeScript
// cannot resolve the suffix, so each specifier is declared as the real module.

declare module "*/lib/native/backend.ts?real" {
  export * from "@/lib/native/backend";
}

declare module "*/lib/native/clipboard.ts?real" {
  export * from "@/lib/native/clipboard";
}

declare module "*/lib/native/events.ts?real" {
  export * from "@/lib/native/events";
}

declare module "*/lib/native/window.ts?real" {
  export * from "@/lib/native/window";
}

declare module "*/lib/native/process.ts?real" {
  export * from "@/lib/native/process";
}

declare module "*/stores/kanbanStore.ts?kanban-store-test" {
  export * from "@/stores/kanbanStore";
}
