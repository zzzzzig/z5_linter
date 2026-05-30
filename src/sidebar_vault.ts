// src/sidebar_vault.ts
import { Notice } from "obsidian";
import type z5Linter from "./main";
import { VaultLinter } from "./vault_linter";

/**
 * Vault panel helpers: load latest report and wire the "Load latest report" and
 * "Run vault lint" buttons. The VaultLinter is instantiated per-plugin inside initVaultUI.
 */

export function initVaultUI(container: HTMLElement, plugin: z5Linter) {
  // Load latest report button
  const loadBtn = container.createEl("button", { text: "Load latest report" });
  loadBtn.addEventListener("click", async () => {
    const rep = await plugin.getLatestReport();
    if (!rep) {
      new Notice("No reports found in " + (plugin.settings.reportsFolder || "reports/linter"));
      return;
    }
    const view = plugin.getSidebarViewInstance?.();
    if (view) {
      view.updateHeaderCounts(rep.content.results || []);
      view.renderResults(rep.content.results || []);
    }
    new Notice("Loaded report: " + rep.path);
  });

  // Instantiate VaultLinter using the plugin instance
  const vaultLinter = new VaultLinter(plugin);

  // Run vault lint button + inline progress UI
  const runBtn = container.createEl("button", { text: "Run vault lint and save report" });
  const progressWrap = container.createDiv("z5-vault-lint-wrap");
  progressWrap.style.marginTop = "6px";

  runBtn.addEventListener("click", async () => {
    const ac = new AbortController();
    runBtn.setAttribute("disabled", "true");

    // progress UI
    progressWrap.innerHTML = "";
    const progressEl = progressWrap.createDiv("z5-vault-lint-progress");
    progressEl.textContent = "Starting…";
    const cancelBtn = progressWrap.createEl("button", { text: "Cancel" });
    cancelBtn.style.marginLeft = "8px";
    cancelBtn.addEventListener("click", () => ac.abort());

    try {
      const { path, results } = await vaultLinter.runVaultLintAndSave({
        onProgress: ({ processed, total, currentFile }) => {
          progressEl.textContent = total
            ? `Processed ${processed}/${total}: ${currentFile ?? ""}`
            : `Processed ${processed}: ${currentFile ?? ""}`;
        },
        signal: ac.signal
      });

      new Notice("Vault lint complete: " + path);

      // update view with results
      const view = plugin.getSidebarViewInstance?.();
      if (view) {
        view.updateHeaderCounts(results || []);
        view.renderResults(results || []);
      }

      // optional: prune old reports (keep last 10)
      await vaultLinter.pruneReports(undefined, 10);
    } catch (err) {
      if ((err as any)?.name === "AbortError") {
        new Notice("Vault lint cancelled");
      } else {
        console.error("Vault lint failed", err);
        new Notice("Vault lint failed (see console)");
      }
    } finally {
      runBtn.removeAttribute("disabled");
      progressWrap.innerHTML = "";
    }
  });

  // Append run button and progress area to container (if not already present)
  container.appendChild(runBtn);
  container.appendChild(progressWrap);
}

/* Export a helper to parse a report file if you need it elsewhere */
export async function loadLatestReport(plugin: z5Linter) {
  return await plugin.getLatestReport();
}
