// src/vault_linter.ts
import { App, Notice, TFile } from "obsidian";
import type z5Linter from "./main";
import type { LintResult } from "./linter";

export type RunOptions = {
  onProgress?: (progress: { processed: number; total?: number; currentFile?: string }) => void;
  signal?: AbortSignal;
  reportFilenamePrefix?: string;
};

export class VaultLinter {
  plugin: z5Linter;
  constructor(plugin: z5Linter) { this.plugin = plugin; }

  // Run the engine across the vault and return results (does not save)
  public async runVaultLint(options: RunOptions = {}): Promise<LintResult[]> {
    const { onProgress, signal } = options;

    const files = this.plugin.app.vault.getMarkdownFiles();
    const total = files.length;
    const results: LintResult[] = [];

    let processed = 0;
    for (const f of files) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const r = await this.plugin.linter.lintFile(f);
      if (Array.isArray(r)) results.push(...r);

      processed++;
      onProgress?.({ processed, total, currentFile: f.path });
    }

    return results;
  }


  // Run and save to a timestamped file in reports folder
  public async runVaultLintAndSave(options: RunOptions = {}): Promise<{ path: string; results: LintResult[] }> {
    const results = await this.runVaultLint(options);
    const path = await this.saveReport(results, undefined, options.reportFilenamePrefix);
    return { path, results };
  }

  // Save results JSON to reports folder; returns created path
  public async saveReport(results: LintResult[], folder?: string, prefix?: string): Promise<string> {
    const reportsFolder = (folder || this.plugin.settings.reportsFolder || "reports/linter").trim().replace(/^\/+|\/+$/g, "");
    // ensure folder exists
    await this.ensureFolderExists(reportsFolder);

    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const ts = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const filename = `${prefix || "linter-report"}-${ts}.json`;
    const path = `${reportsFolder}/${filename}`;

    const content = JSON.stringify({
      generatedAt: now.toISOString(),
      pluginVersion: this.plugin.manifest.version,
      results
    }, null, 2);

    // create file (vault.create throws if exists; timestamp avoids collisions)
    await this.plugin.app.vault.create(path, content);
    return path;
  }

  // Prune old reports, keeping last N (by mtime)
  public async pruneReports(folder?: string, keepLast = 10): Promise<void> {
    const reportsFolder = (folder || this.plugin.settings.reportsFolder || "reports/linter").trim().replace(/^\/+|\/+$/g, "");
    const files = this.plugin.app.vault.getFiles().filter(f => f.path.startsWith(reportsFolder + "/"));
    if (files.length <= keepLast) return;
    files.sort((a, b) => {
      const am = (a.stat && (a.stat.mtime || 0)) || 0;
      const bm = (b.stat && (b.stat.mtime || 0)) || 0;
      return bm - am;
    });
    const toDelete = files.slice(keepLast);
    for (const f of toDelete) {
      try { await this.plugin.app.vault.delete(f); } catch (e) { console.warn("VaultLinter: failed to delete old report", f.path, e); }
    }
  }

  // Return latest report path or null
  public async getLatestReportPath(folder?: string): Promise<string | null> {
    const reportsFolder = (folder || this.plugin.settings.reportsFolder || "reports/linter").trim().replace(/^\/+|\/+$/g, "");
    const files = this.plugin.app.vault.getFiles().filter(f => f.path.startsWith(reportsFolder + "/"));
    if (!files.length) return null;
    files.sort((a, b) => {
      const am = (a.stat && (a.stat.mtime || 0)) || 0;
      const bm = (b.stat && (b.stat.mtime || 0)) || 0;
      return bm - am;
    });
    return files[0].path;
  }

  // Helper to create intermediate folders
  private async ensureFolderExists(folder: string) {
    const parts = folder.split("/").filter(Boolean);
    let pathSoFar = "";
    for (const part of parts) {
      pathSoFar = pathSoFar ? `${pathSoFar}/${part}` : part;
      const af = this.plugin.app.vault.getAbstractFileByPath(pathSoFar);
      if (!af) {
        await this.plugin.app.vault.createFolder(pathSoFar);
      }
    }
  }
}
