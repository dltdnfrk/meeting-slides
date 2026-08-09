// Operator view switching is intentionally client-only navigation.
// It focuses existing surfaces and never duplicates or persists their content.
(() => {
  const items = [...document.querySelectorAll(".output-switcher__item")];

  for (const item of items) {
    item.addEventListener("click", (event) => {
      if (!(item instanceof HTMLElement) || item.matches(":disabled")) return;
      const targetId = item.dataset.outputTarget;
      if (!targetId) return;
      const target = document.getElementById(targetId);
      if (!target || target.hidden) return;

      event.preventDefault();
      for (const candidate of items) candidate.removeAttribute("aria-current");
      item.setAttribute("aria-current", "page");
      target.focus({ preventScroll: true });
      target.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  }
})();
