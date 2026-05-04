import { registerSW } from "virtual:pwa-register";
import "./game.css";
import { bootGame } from "./game";

registerSW({ immediate: true });

bootGame();

/**
 * Wait for webfonts (when supported), a short minimum beat, and two frames so
 * the first paint uses loaded CSS before we fade the boot splash away.
 */
async function markAppReady(): Promise<void> {
  const minMs = 420;
  const minDelay = new Promise<void>((resolve) => {
    window.setTimeout(resolve, minMs);
  });
  const fontsReady =
    document.fonts?.ready?.catch(() => undefined) ?? Promise.resolve(undefined);
  await Promise.all([minDelay, fontsReady]);
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
  document.body.classList.remove("app-booting");
  document.body.classList.add("app-ready");
  const splash = document.getElementById("bootSplash");
  if (splash) splash.setAttribute("aria-busy", "false");
}

void markAppReady();
