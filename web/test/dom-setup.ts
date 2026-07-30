// A DOM for `bun test` (spec 024 FR-002: component tests). Bun has no
// document, so happy-dom's globals are registered here and nowhere else.
//
// Registration is scoped to the file that asks for it, and undone afterwards,
// because `bun test` runs every test file in one process and happy-dom
// replaces 35 globals that Bun owns, `fetch`, `Response`, and `Request`
// among them. Leaving them replaced breaks the API territory's own route
// tests, which serve real HTTP over a real Bun.serve in the same run. Hence
// beforeAll/afterAll rather than a module-level side effect: a module is
// evaluated once for the whole process, but these hooks run per file.
import { afterAll, beforeAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

declare global {
  // React's own switch for act(): without it every act() call warns.
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

// Called at the top level of each component test file.
export function useDom(): void {
  beforeAll(() => {
    GlobalRegistrator.register();
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
    await GlobalRegistrator.unregister();
  });
}
