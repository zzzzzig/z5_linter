// status_bar.ts (replace createStatusBar and updateStatusBarCounts)

import { setIcon } from "obsidian";
import type z5Linter from "./main";

let statusEl: HTMLElement | null = null;
let pluginRef: z5Linter | null = null;

// Keep references to the three blocks so we can update titles later
let errBlock: HTMLElement | null = null;
let warnBlock: HTMLElement | null = null;
let infoBlock: HTMLElement | null = null;

export function createStatusBar(plugin: z5Linter) {
  pluginRef = plugin;
  plugin.registerStatusBarInstance?.(statusEl);
  if (statusEl) return statusEl;
  const el = plugin.addStatusBarItem();
  el.addClass("z5-linter-status");
  el.innerHTML = "";

  const makeBlock = (cls: string, iconName: string) => {
    const block = document.createElement("span");
    block.className = `z5-ls ${cls}`;
    const iconWrap = document.createElement("span");
    iconWrap.className = "z5-ls-icon";
    try { setIcon(iconWrap, iconName); } catch {}
    const count = document.createElement("span");
    count.className = "z5-ls-count";
    count.textContent = "0";
    block.appendChild(iconWrap);
    block.appendChild(count);
    return block;
  };

  // create blocks and append
  const eBlock = makeBlock("err", "octagon-x");
  const wBlock = makeBlock("warn", "triangle-alert");
  const iBlock = makeBlock("info", "info");
  el.appendChild(eBlock);
  el.appendChild(wBlock);
  el.appendChild(iBlock);

  // store references for later updates
  errBlock = eBlock;
  warnBlock = wBlock;
  infoBlock = iBlock;

  el.onclick = () => {
    if (!pluginRef) return;
    try {
      if (typeof (pluginRef as any).openLinterSidebar === "function") {
        (pluginRef as any).openLinterSidebar();
      } else if (typeof (pluginRef as any).openSchemaSidebar === "function") {
        (pluginRef as any).openSchemaSidebar();
      }
    } catch (e) {
      console.warn("z5Linter: status bar click handler failed", e);
    }
  };

  el.title = "Click to open z5 Linter";
  statusEl = el;
  return el;
}

export function removeStatusBar() {
  if (!statusEl) return;
  try { statusEl.remove(); } catch {}
  statusEl = null;
  errBlock = warnBlock = infoBlock = null;
}

/**
 * Update counts and set per-severity top-message tooltips.
 * results: array of lint result objects (expected fields: severity, message, rule, file/path)
 */
export function updateStatusBarCounts(results: any[]) {
  if (!statusEl) return;

  // counts
  const counts = { error: 0, warning: 0, info: 0 };

  // top message per severity (first-seen)
  const topMsg: Record<string, string | undefined> = { error: undefined, warning: undefined, info: undefined };

  for (const r of results || []) {
    const sevRaw = (r.severity ?? "info").toString();
    const sev = sevRaw.toLowerCase();
    const msg = (r.message || r.rule || "").toString();

    if (sev === "error") {
      counts.error++;
      if (!topMsg.error && msg) topMsg.error = msg;
    } else if (sev === "warning") {
      counts.warning++;
      if (!topMsg.warning && msg) topMsg.warning = msg;
    } else {
      counts.info++;
      if (!topMsg.info && msg) topMsg.info = msg;
    }
  }

  // update numeric counts in DOM
  const errCountEl = statusEl.querySelector(".z5-ls.err .z5-ls-count") as HTMLElement | null;
  const warnCountEl = statusEl.querySelector(".z5-ls.warn .z5-ls-count") as HTMLElement | null;
  const infoCountEl = statusEl.querySelector(".z5-ls.info .z5-ls-count") as HTMLElement | null;
  if (errCountEl) errCountEl.textContent = String(counts.error);
  if (warnCountEl) warnCountEl.textContent = String(counts.warning);
  if (infoCountEl) infoCountEl.textContent = String(counts.info);

  if (errBlock) errBlock.title = topMsg.error ? `Error: ${safeTitle(topMsg.error)}` : "No errors";
  if (warnBlock) warnBlock.title = topMsg.warning ? `Warning: ${safeTitle(topMsg.warning)}` : "No warnings";
  if (infoBlock) infoBlock.title = topMsg.info ? `Info: ${safeTitle(topMsg.info)}` : "No info messages";

  if (topMsg.error) statusEl.title = `Top error: ${safeTitle(topMsg.error)}`;
  else if (topMsg.warning) statusEl.title = `Top warning: ${safeTitle(topMsg.warning)}`;
  else if (topMsg.info) statusEl.title = `Top info: ${safeTitle(topMsg.info)}`;
  else statusEl.title = "Click to open z5 Linter";

}


/** Helper: sanitize and truncate tooltip text for native title */
function safeTitle(text: string | undefined, max = 200) {
  if (!text) return "";
  // remove newlines and collapse whitespace
  const single = String(text).replace(/\s+/g, " ").trim();
  if (single.length <= max) return single;
  return single.slice(0, max - 1) + "…";
}
