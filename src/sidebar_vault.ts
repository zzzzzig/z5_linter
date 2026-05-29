import { Notice } from "obsidian";
import type z5Linter from "./main";

/**
 * Vault panel helpers: load latest report and wire the "Load latest report" button.
 */

export function initVaultUI(container: HTMLElement, plugin: z5Linter) {
  const loadBtn = container.createEl("button", { text: "Load latest report" });
  loadBtn.addEventListener("click", async () => {
    const rep = await plugin.getLatestReport();
    if (!rep) {
      new Notice("No reports found in " + (plugin.settings.reportsFolder || "reports/linter"));
      return;
    }
    // update the active file area with the report results (reuse existing view methods)
    const view = plugin.getSidebarViewInstance?.();
    if (view) {
      view.updateHeaderCounts(rep.content.results || []);
      view.renderResults(rep.content.results || []);
    }
    new Notice("Loaded report: " + rep.path);
  });
}

/* Export a helper to parse a report file if you need it elsewhere */
export async function loadLatestReport(plugin: z5Linter) {
  return await plugin.getLatestReport();
}
