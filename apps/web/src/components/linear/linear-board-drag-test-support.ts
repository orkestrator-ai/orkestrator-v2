import { act, fireEvent, screen } from "@testing-library/react";

/**
 * Drags a Linear board card onto a lane in happy-dom, which lays nothing out:
 * each lane is given a 300px-wide column (in DOM order) and each card a box
 * inside its lane, so dnd-kit's pointer sensor and `pointerWithin` see real
 * geometry. Returns a restore function for `afterEach`.
 */
export function layOutLinearBoard(): () => void {
  const original = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const lane = this.closest("section[aria-label$=' lane']");
    if (lane) {
      const lanes = Array.from(document.querySelectorAll("section[aria-label$=' lane']"));
      const left = lanes.indexOf(lane) * 300;
      if (this === lane) return new DOMRect(left, 0, 280, 800);
      const card = this.closest("[data-testid='linear-board-card']");
      if (card) {
        const cards = Array.from(lane.querySelectorAll("[data-testid='linear-board-card']"));
        return new DOMRect(left + 10, 60 + cards.indexOf(card) * 100, 260, 90);
      }
    }
    return original.call(this);
  };
  return () => {
    Element.prototype.getBoundingClientRect = original;
  };
}

/** Drags the card titled `title` onto the lane named `lane`. */
export async function dragLinearCard(title: string, lane: string): Promise<void> {
  const card = screen.getByText(title).closest("[data-testid='linear-board-card']") as HTMLElement;
  const target = screen.getByRole("region", { name: `${lane} lane` });
  const from = card.getBoundingClientRect();
  const to = target.getBoundingClientRect();
  const start = { clientX: from.left + 20, clientY: from.top + 20 };
  const end = { clientX: to.left + 40, clientY: to.top + 300 };
  await act(async () => {
    fireEvent.pointerDown(card, { ...start, button: 0, isPrimary: true, pointerId: 1 });
  });
  await act(async () => {
    fireEvent.pointerMove(document, { clientX: start.clientX + 10, clientY: start.clientY });
  });
  await act(async () => {
    fireEvent.pointerMove(document, end);
  });
  await act(async () => {
    fireEvent.pointerUp(document, end);
  });
  // A browser follows the release with a click on the card, which dnd-kit
  // swallows after a drag. dnd-kit removes that swallow 50 ms after the drag
  // ends (`AbstractPointerSensor.detach`), so wait it out: otherwise it eats
  // the next test's first click.
  await act(async () => {
    fireEvent.click(card);
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
}
