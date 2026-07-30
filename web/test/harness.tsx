// A minimal render harness for the component tests (spec 024 FR-002).
//
// Deliberately hand-rolled rather than pulling in a testing library: the tests
// need three things (mount, click, read text by test id), and spec 024 B-1's
// "no external anything" posture is easier to keep honest with a dependency
// list this short. Every interaction goes through React's own `act`, so a
// state update triggered by a click is flushed before the assertion runs.
//
// react-dom is imported here, before any DOM exists; it only reaches for a
// document when a root actually renders, which is inside a test and therefore
// after `useDom()`'s beforeAll has installed one.
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ReactNode } from "react";

export { useDom } from "./dom-setup";

export interface Mounted {
  readonly container: HTMLElement;
  query(testId: string): HTMLElement | null;
  find(testId: string): HTMLElement;
  text(testId: string): string;
  click(testId: string): Promise<void>;
  update(node: ReactNode): Promise<void>;
  unmount(): void;
}

// Collapses whitespace so an assertion can match rendered prose without
// caring how JSX happened to wrap it.
export function flat(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export async function mount(node: ReactNode): Promise<Mounted> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(node);
  });

  const query = (testId: string): HTMLElement | null =>
    container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

  const find = (testId: string): HTMLElement => {
    const found = query(testId);
    if (found === null) throw new Error(`harness: no element with data-testid="${testId}"`);
    return found;
  };

  return {
    container,
    query,
    find,
    text: (testId) => flat(find(testId).textContent ?? ""),
    async click(testId) {
      const element = find(testId);
      await act(async () => {
        element.click();
      });
    },
    async update(next) {
      await act(async () => {
        root.render(next);
      });
    },
    unmount() {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}
