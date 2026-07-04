/**
 * Page interactions for the caara site: scroll-reveal animation,
 * copy-to-clipboard buttons, and benchmark bar growth on first view.
 */
(() => {
  // scroll reveal
  const revealed = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("in");
          revealed.unobserve(entry.target);
        }
      }
    },
    { threshold: 0.12 },
  );
  for (const el of document.querySelectorAll(".reveal")) revealed.observe(el);

  // benchmark bars grow to their value when the figure scrolls into view
  const bench = document.querySelector(".bench");
  if (bench) {
    const grow = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        for (const row of bench.querySelectorAll(".bench-row")) {
          const value = Number(row.dataset.value);
          const max = Number(row.dataset.max);
          const bar = row.querySelector(".bench-bar");
          if (bar && value > 0 && max > 0) {
            bar.style.width = `${(value / max) * 100}%`;
          }
        }
        grow.disconnect();
      },
      { threshold: 0.4 },
    );
    grow.observe(bench);
  }

  // copy buttons
  for (const button of document.querySelectorAll(".copy")) {
    button.addEventListener("click", () => {
      navigator.clipboard.writeText(button.dataset.copy ?? "").then(() => {
        button.classList.add("copied");
        setTimeout(() => button.classList.remove("copied"), 1400);
      });
    });
  }
})();
