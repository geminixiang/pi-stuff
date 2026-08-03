document.documentElement.classList.add("js");

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const reveals = document.querySelectorAll(".reveal");

if ("IntersectionObserver" in window && !reducedMotion.matches) {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      }
    },
    { rootMargin: "0px 0px -10%", threshold: 0.08 },
  );
  for (const element of reveals) observer.observe(element);
} else {
  for (const element of reveals) element.classList.add("is-visible");
}

const copyButton = document.querySelector("[data-copy]");
copyButton?.addEventListener("click", async () => {
  const value = copyButton.getAttribute("data-copy");
  if (!value || !navigator.clipboard) return;
  try {
    await navigator.clipboard.writeText(value);
    copyButton.textContent = "copied";
    window.setTimeout(() => {
      copyButton.textContent = "copy";
    }, 1600);
  } catch {
    copyButton.textContent = "select to copy";
  }
});

const canvas = document.querySelector("#field");
const context = canvas?.getContext("2d");
if (canvas && context && !reducedMotion.matches) {
  let width = 0;
  let height = 0;
  let frame = 0;
  let lastFrame = 0;
  let visible = !document.hidden;
  const points = Array.from({ length: 28 }, (_, index) => ({
    phase: index * 0.71,
    radius: 0.17 + (index % 7) * 0.032,
    speed: 0.00006 + (index % 5) * 0.000012,
  }));

  const resize = () => {
    const bounds = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
    width = bounds.width;
    height = bounds.height;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  const draw = (time) => {
    if (!visible) return;
    if (time - lastFrame >= 32) {
      lastFrame = time;
      context.clearRect(0, 0, width, height);
      const positions = points.map((point, index) => {
        const angle = point.phase + time * point.speed;
        const x = width * (0.72 + Math.cos(angle * (index % 2 ? 1 : -1)) * point.radius);
        const y = height * (0.42 + Math.sin(angle * 1.13) * point.radius * 1.3);
        return { x, y };
      });
      context.lineWidth = 0.7;
      for (let index = 0; index < positions.length; index += 1) {
        const point = positions[index];
        const next = positions[(index + 7) % positions.length];
        context.strokeStyle = "rgba(21,21,21,0.12)";
        context.beginPath();
        context.moveTo(point.x, point.y);
        context.lineTo(next.x, next.y);
        context.stroke();
        context.fillStyle = index % 8 === 0 ? "#ff4d20" : "rgba(21,21,21,0.45)";
        context.beginPath();
        context.arc(point.x, point.y, index % 8 === 0 ? 2.5 : 1.2, 0, Math.PI * 2);
        context.fill();
      }
    }
    frame = window.requestAnimationFrame(draw);
  };

  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas);
  document.addEventListener("visibilitychange", () => {
    visible = !document.hidden;
    if (visible) frame = window.requestAnimationFrame(draw);
    else window.cancelAnimationFrame(frame);
  });
  resize();
  frame = window.requestAnimationFrame(draw);
}
