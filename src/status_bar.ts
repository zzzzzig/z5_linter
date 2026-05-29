import { setIcon } from "obsidian";
import type z5Linter from "./main";

/**
 * Encapsulate status bar DOM and updates.
 * main.ts should call createStatusBar(plugin) and updateCounts(plugin, results).
 */

let statusEl: HTMLElement | null = null;

export function createStatusBar(plugin: z5Linter) {
  if (statusEl) return statusEl;
  const el = plugin.addStatusBarItem();
  el.addClass("z5-linter-status");
  el.innerHTML = "";
  const makeBlock = (cls: string, iconName: string) => {
    const block = document.createElement("span");
    block.className = `z5-ls ${cls}`;
    const iconWrap = document.createElement("span"); iconWrap.className = "z5-ls-icon";
    try { setIcon(iconWrap, iconName); } catch {}
    const count = document.createElement("span"); count.className = "z5-ls-count"; count.textContent = "0";
    block.appendChild(iconWrap); block.appendChild(count);
    return block;
  };
  el.appendChild(makeBlock("err","octagon-x"));
  el.appendChild(makeBlock("warn","triangle-alert"));
  el.appendChild(makeBlock("info","info"));
  el.onclick = () => plugin.openLinterSidebar();
  el.title = "Click to open z5 Linter";
  statusEl = el;
  return el;
}

export function removeStatusBar() {
  if (!statusEl) return;
  try { statusEl.remove(); } catch {}
  statusEl = null;
}

export function updateStatusBarCounts(results: any[]) {
  if (!statusEl) return;
  const counts = { error: 0, warning: 0, info: 0 };
  for (const r of results) {
    if (r.severity === "error") counts.error++;
    else if (r.severity === "warning") counts.warning++;
    else counts.info++;
  }
  const err = statusEl.querySelector(".z5-ls.err .z5-ls-count") as HTMLElement | null;
  const warn = statusEl.querySelector(".z5-ls.warn .z5-ls-count") as HTMLElement | null;
  const info = statusEl.querySelector(".z5-ls.info .z5-ls-count") as HTMLElement | null;
  if (err) err.textContent = String(counts.error);
  if (warn) warn.textContent = String(counts.warning);
  if (info) info.textContent = String(counts.info);
}
