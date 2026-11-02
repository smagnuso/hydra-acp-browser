// iOS has no event for a status-bar tap; it just scrolls the page's main
// scroll view to the top. body is position:fixed (see index.html) so the
// document normally sits at 0 and the tap is a no-op. index.html gives the
// document 2px of scroll range and we rest at REST_Y; a scroll event that
// drops below it with no finger down is the status-bar tap, which we
// redirect to the session list.
const REST_Y = 1;

const isEditable = (el: Element | null): boolean =>
  !!el && (el.matches("input, textarea, select") || (el as HTMLElement).isContentEditable);

export function initStatusBarScroll(): void {
  let touching = false;
  let editing = isEditable(document.activeElement);
  const root = document.documentElement;
  root.classList.toggle("editing", editing);

  // With a field focused iOS pans the page for the keyboard; don't fight it.
  const setEditing = (): void => {
    editing = isEditable(document.activeElement);
    root.classList.toggle("editing", editing);
    rest();
  };
  document.addEventListener("focusin", setEditing);
  document.addEventListener("focusout", () => setTimeout(setEditing, 0));

  const rest = (): void => {
    if (editing) {
      return;
    }
    if (window.scrollY !== REST_Y) {
      window.scrollTo({ top: REST_Y, left: 0, behavior: "instant" });
    }
  };

  window.addEventListener(
    "touchstart",
    () => {
      touching = true;
    },
    { capture: true, passive: true }
  );
  const release = (e: TouchEvent): void => {
    if (e.touches.length > 0) return;
    touching = false;
    rest();
  };
  window.addEventListener("touchend", release, { capture: true, passive: true });
  window.addEventListener("touchcancel", release, { capture: true, passive: true });

  window.addEventListener(
    "scroll",
    () => {
      if (editing || touching || window.scrollY >= REST_Y) {
        return;
      }
      document.querySelector<HTMLElement>(".list")?.scrollTo({ top: 0, behavior: "smooth" });
      rest();
    },
    { passive: true }
  );

  window.addEventListener("pageshow", rest);
  window.addEventListener("load", rest);
  rest();
}
