import type z5Linter from "./main";
import type { LinterSidebarView } from "./sidebar";

/**
 * Single-file controller: obtains results for the active file and updates the view.
 * Keep logic here minimal: get results from plugin.linter and call view methods.
 */

export async function updateActiveFileUI(results: any[], view: LinterSidebarView | null) {
  if (!view) return;
  // update counts and render results
  view.updateHeaderCounts(results || []);
  view.renderResults(results || []);
}

/**
 * Optional helper to fetch results from the engine and update the view.
 * Use this from main.ts when active leaf changes.
 */
export async function refreshActiveFileFromEngine(plugin: z5Linter) {
  // Prefer a cached property on the engine; fall back to running the active-file lint
  let results: any[] = [];
  if ((plugin.linter as any).lastActiveFileResults) {
    results = (plugin.linter as any).lastActiveFileResults;
  } else if (typeof (plugin.linter as any).runLintForActiveFile === "function") {
    results = await (plugin.linter as any).runLintForActiveFile();
  }
  const view = plugin.getSidebarViewInstance?.();
  await updateActiveFileUI(results, view as any);
  // store canonical latest results on plugin
  (plugin as any).latestLintResults = results;
}
