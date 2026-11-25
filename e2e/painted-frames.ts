/**
 * Calls `sample` at most once per rendered frame, only while the layout it
 * would read is the one that frame painted. Returns a stop function.
 */
export type EachPaintedFrame = (sample: () => void) => () => void;

/**
 * Defines `window.__eachPaintedFrame`. Self-contained, so it can be passed to
 * `page.evaluate` or `locator.evaluate` as is; defining it twice is harmless.
 *
 * A sample runs in a task posted from `requestAnimationFrame`, which is after
 * that frame's paint. Being after the paint is not enough: on a busy page the
 * task can be late, and reading geometry then forces a layout no frame
 * rendered. Chromium moves the animation clock forward in such a task, so a
 * running height animation is read ahead of the scroll correction that its
 * next frame makes (flake 1012), and a viewport resize that arrived meanwhile
 * is read before the resize steps and observers of its frame run (flake
 * 10027). Neither is ever on screen. A sample whose animation clock or
 * viewport is no longer its frame's is skipped, so a probe must check that it
 * took some.
 */
export function definePaintedFrames(): void {
  const target = window as unknown as { __eachPaintedFrame?: EachPaintedFrame };
  target.__eachPaintedFrame ??= (sample) => {
    const channel = new MessageChannel();
    const rendered = () => `${document.timeline.currentTime} ${innerWidth}x${innerHeight}`;
    let running = true;
    let frame = 0;
    let painted = "";
    const post = () => {
      painted = rendered();
      channel.port2.postMessage(0);
    };
    channel.port1.onmessage = () => {
      if (!running) return;
      if (rendered() === painted) sample();
      frame = requestAnimationFrame(post);
    };
    frame = requestAnimationFrame(post);
    return () => {
      running = false;
      cancelAnimationFrame(frame);
      channel.port1.close();
    };
  };
}
