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

  constructor(plugin: z5Linter) {
    this.plugin = plugin;
  }

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
    await this.pruneReports(undefined, this.plugin.settings.keepReports);
    return { path, results };
  }

  // Save results JSON to reports folder; returns created path
  public async saveReport(
    results: LintResult[],
    folder?: string,
    prefix?: string
  ): Promise<{ mdPath: string; jsonPath: string; results: LintResult[] }> {

    const reportsFolder = (folder || this.plugin.settings.reportsFolder || "reports/linter")
      .trim()
      .replace(/^\/+|\/+$/g, "");

    await this.ensureFolderExists(reportsFolder);

    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const ts = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

    const base = `${prefix || "linter-report"}-${ts}`;

    const jsonFilename = `${base}.json`;
    const mdFilename = `${base}.md`;

    const jsonPath = `${reportsFolder}/${jsonFilename}`;
    const mdPath = `${reportsFolder}/${mdFilename}`;

    // 1. Write JSON file
    const jsonContent = this.generateJsonReport(results);
    await this.plugin.app.vault.create(jsonPath, jsonContent);

    // 2. Write Markdown report (links to JSON)
    const mdContent = this.generateMarkdownReport(results, jsonPath);
    await this.plugin.app.vault.create(mdPath, mdContent);

    return { mdPath, jsonPath, results };
  }

  /**
   * Compute per-file summaries from the results array.
   * Returns an object keyed by file path:
   * {
   *   "<path>": { errors, warnings, info, total, highest, firstIndex }
   * }
   */
  private computeFileSummaries(results: LintResult[]) {
    const map: Record<string, {
      errors: number;
      warnings: number;
      info: number;
      total: number;
      highest: "error" | "warning" | "info";
      firstIndex: number;
    }> = {};

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const filePath = r.file ?? r.path ?? r.filename ?? "unknown";
      if (!map[filePath]) {
        map[filePath] = { errors: 0, warnings: 0, info: 0, total: 0, highest: "info", firstIndex: i };
      }
      const entry = map[filePath];
      const sev = (r.severity || "info").toLowerCase();
      if (sev === "error") entry.errors += 1;
      else if (sev === "warning") entry.warnings += 1;
      else entry.info += 1;
      entry.total += 1;

      // update highest severity
      if (entry.highest !== "error") {
        if (sev === "error") entry.highest = "error";
        else if (sev === "warning" && entry.highest === "info") entry.highest = "warning";
      }

      // keep earliest index
      if (i < entry.firstIndex) entry.firstIndex = i;
    }

    return map;
  }

  private generateJsonReport(results: LintResult[]): string {
    const fileSummaries = this.computeFileSummaries(results);

    return JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        pluginVersion: this.plugin.manifest.version,
        results,
        // include per-file aggregates to speed up sidebar rendering and sorting
        fileSummaries
      },
      null,
      2
    );
  }

  // Prune old reports, keeping last N (by mtime)
  public async pruneReports(folder?: string, keepLast = 10): Promise<void> {
    const reportsFolder = (folder || this.plugin.settings.reportsFolder || "reports/linter")
      .trim()
      .replace(/^\/+|\/+$/g, "");

    // Get all files in the reports folder
    const allFiles = this.plugin.app.vault
      .getFiles()
      .filter(f => f.path.startsWith(reportsFolder + "/"));

    if (allFiles.length === 0) return;

    // Group by base name (prefix before extension)
    // Example: linter-report-20260530-204500.md → "linter-report-20260530-204500"
    const groups: Record<string, TFile[]> = {};

    for (const f of allFiles) {
      const name = f.name;
      const match = name.match(/^(.*?)-\d{8}-\d{6}/); // prefix + timestamp
      if (!match) continue;

      const base = match[0]; // e.g. "linter-report-20260530-204500"
      if (!groups[base]) groups[base] = [];
      groups[base].push(f);
    }

    const groupEntries = Object.entries(groups);

    if (groupEntries.length <= keepLast) return;

    // Sort groups by newest mtime
    groupEntries.sort(([, filesA], [, filesB]) => {
      const newestA = Math.max(...filesA.map(f => f.stat?.mtime ?? 0));
      const newestB = Math.max(...filesB.map(f => f.stat?.mtime ?? 0));
      return newestB - newestA; // newest first
    });

    // Determine which groups to delete
    const toDelete = groupEntries.slice(keepLast);

    for (const [, files] of toDelete) {
      for (const f of files) {
        try {
          await this.plugin.app.vault.delete(f);
        } catch (e) {
          console.warn("VaultLinter: failed to delete old report", f.path, e);
        }
      }
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

  public async getLatestReport(): Promise<{ path: string; content: any } | null> {
    const rawFolder = (this.plugin.settings.reportsFolder ?? "reports/linter").trim();
    const folder = rawFolder.replace(/^\/+|\/+$/g, ""); // normalize
    const prefix = folder + "/";

    // Collect files in the folder
    const files = this.plugin.app.vault.getFiles().filter(f => f.path.startsWith(prefix));
    if (!files.length) return null;

    // Prefer JSON files; group by base run prefix (timestamp)
    const jsonFiles = files.filter(f => f.extension === "json");
    const candidates = jsonFiles.length ? jsonFiles : files; // fallback to any file if no json

    // Sort by mtime descending
    candidates.sort((a, b) => (b.stat?.mtime ?? 0) - (a.stat?.mtime ?? 0));
    const latest = candidates[0];
    if (!latest) return null;

    try {
      const raw = await this.plugin.app.vault.read(latest);
      const parsed = JSON.parse(raw);
      return { path: latest.path, content: parsed };
    } catch (e) {
      console.warn("VaultLinter.getLatestReport: failed to read/parse", latest.path, e);
      return null;
    }
  }

  private generateMarkdownReport(results: LintResult[], jsonPath: string): string {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const ts = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

    const vaultName = this.plugin.app.vault.getName();

    // Group results by severity → rule
    const grouped: Record<string, Record<string, LintResult[]>> = {
      error: {},
      warning: {},
      info: {}
    };

    for (const r of results) {
      const sev = r.severity || "info";
      if (!grouped[sev][r.rule]) grouped[sev][r.rule] = [];
      grouped[sev][r.rule].push(r);
    }

    const count = {
      error: results.filter(r => r.severity === "error").length,
      warning: results.filter(r => r.severity === "warning").length,
      info: results.filter(r => r.severity === "info").length
    };

    let md = "";
    md += `---\n`;
    md += `type: linter-report\n`;
    md += `created: ${now.toISOString()}\n`;
    md += `tags:\n  - meta/linter\n`;
    md += `---\n\n`;

    md += `# Vault Lint Report — ${ts}\n\n`;
    md += `notes_scanned:: ${results.length}\n`;
    md += `errors:: ${count.error}\n`;
    md += `warnings:: ${count.warning}\n`;
    md += `infos:: ${count.info}\n`;
    md += `runtime:: ${now.toISOString()}\n`;
    md += `schema_version:: "${this.plugin.settings.schemaVersion || "1.0"}"\n\n`;

    md += `---\n\n## Summary\n\n`;
    md += `| Severity | Count |\n`;
    md += `|----------|-------|\n`;
    md += `| 🔴 Error | ${count.error} |\n`;
    md += `| 🟡 Warning | ${count.warning} |\n`;
    md += `| 🔵 Info | ${count.info} |\n\n`;

    const sevOrder = [
      { key: "error", label: "🔴 Errors" },
      { key: "warning", label: "🟡 Warnings" },
      { key: "info", label: "🔵 Info" }
    ];

    for (const { key, label } of sevOrder) {
      const rules = grouped[key];
      if (!rules || Object.keys(rules).length === 0) continue;

      md += `---\n\n## ${label}\n\n`;

      for (const rule of Object.keys(rules)) {
        const items = rules[rule];
        if (!items.length) continue;

        md += `> [!details]- ${rule} — ${items.length} file(s)\n`;
        md += `> _${items[0].message || ""}_\n`;

        for (const r of items) {
          const encoded = encodeURIComponent(r.file);
          md += `> - [Open](obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encoded}) — \`${r.file}\`\n`;
        }

        md += `\n`;
      }
    }

    md += `---\n\n## Raw JSON\n\n`;
    md += `The full JSON report is stored separately for performance reasons.\n\n`;
    md += `👉 [Open raw JSON](obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(jsonPath)})\n`;

    return md;
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
