import { act, fireEvent, screen } from "@testing-library/react";

/**
 * Drags a Linear board card onto a lane or beside another card in happy-dom, which lays nothing out:
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

const cardByTitle = (title: string) =>
  screen.getByText(title).closest("[data-testid='linear-board-card']") as HTMLElement;

type Point = { clientX: number; clientY: number };

/** Picks up `card` and moves the pointer to `end`, without letting go. */
async function pickUpAndMove(card: HTMLElement, end: Point): Promise<void> {
  const from = card.getBoundingClientRect();
  const start = { clientX: from.left + 20, clientY: from.top + 20 };
  await act(async () => {
    fireEvent.pointerDown(card, { ...start, button: 0, isPrimary: true, pointerId: 1 });
  });
  await act(async () => {
    fireEvent.pointerMove(document, { clientX: start.clientX + 10, clientY: start.clientY });
  });
  await act(async () => {
    fireEvent.pointerMove(document, end);
  });
}

async function release(card: HTMLElement, end: Point): Promise<void> {
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

/** Where the pointer sits over a lane, below its cards' boxes. */
function lanePoint(lane: string): Point {
  const region = screen.getByRole("region", { name: `${lane} lane` });
  const to = region.getBoundingClientRect();
  const cards = region.querySelectorAll("[data-testid='linear-board-card']").length;
  return { clientX: to.left + 40, clientY: to.top + Math.max(300, 60 + cards * 100 + 5) };
}

/** Where the pointer sits over the upper or lower half of the card titled `title`. */
function cardPoint(title: string, placement: "before" | "after"): Point {
  const to = cardByTitle(title).getBoundingClientRect();
  return {
    clientX: to.left + 40,
    clientY: placement === "before" ? to.top + 20 : to.bottom - 20,
  };
}

/** Drags the card titled `title` onto the lane named `lane`. */
export async function dragLinearCard(title: string, lane: string): Promise<void> {
  const card = cardByTitle(title);
  const end = lanePoint(lane);
  await pickUpAndMove(card, end);
  await release(card, end);
}

/** Drags the card titled `title` onto the upper (`before`) or lower half of the card titled `target`. */
export async function dragLinearCardBeside(
  title: string,
  target: string,
  placement: "before" | "after",
): Promise<void> {
  const card = cardByTitle(title);
  const end = cardPoint(target, placement);
  await pickUpAndMove(card, end);
  await release(card, end);
}

/**
 * Holds the card titled `title` over the upper (`before`) or lower half of the
 * card titled `target`; the returned function lets go.
 */
export async function holdLinearCardBeside(
  title: string,
  target: string,
  placement: "before" | "after",
): Promise<() => Promise<void>> {
  const card = cardByTitle(title);
  const end = cardPoint(target, placement);
  await pickUpAndMove(card, end);
  return () => release(card, end);
}

/** Holds at an exact viewport point, including a lane header or inter-card gap. */
export async function holdLinearCardAt(title: string, end: Point): Promise<() => Promise<void>> {
  const card = cardByTitle(title);
  await pickUpAndMove(card, end);
  return () => release(card, end);
}
