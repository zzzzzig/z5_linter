import { App, Notice, Plugin, WorkspaceLeaf, TFile } from "obsidian";
import { DEFAULT_SETTINGS, z5LinterSettings, z5LinterSettingsTab } from "./settings";
import { Z5LinterEngine, LintResult } from "./linter";
import { LinterSidebarView } from "./sidebar";
import { refreshActiveFileFromEngine } from "./sidebar_single_file";
import { initVaultUI } from "./sidebar_vault";
import { createStatusBar as createStatusBarUI, updateStatusBarCounts as updateStatusBarUI, removeStatusBar as removeStatusBarUI } from "./status_bar";

const VIEW_TYPE_LINTER = "z5-linter-view";

export default class z5Linter extends Plugin {
  settings: z5LinterSettings;
  public linter: Z5LinterEngine;
  public settingsTabInstance: z5LinterSettingsTab | null = null;
  public latestLintResults: LintResult[] = [];
  private refreshTimer: number | null = null;
  private _canonicalSchemaLeaf: WorkspaceLeaf | null = null;
  private statusBarEl: HTMLElement | null = null;

  async onload() {
    await this.loadSettings();

    // instantiate linter engine (it reads plugin.settings internally)
    this.linter = new Z5LinterEngine(this);

    // Register the sidebar view
    this.registerView(VIEW_TYPE_LINTER, (leaf: WorkspaceLeaf) => new LinterSidebarView(leaf, this));

    // Commands
    this.addCommand({
      id: "z5linter-open-schema-sidebar",
      name: "Open Schema YAML sidebar",
      callback: async () => { await this.openSchemaSidebar(); }
    });

    this.addCommand({
      id: "z5-run-vault-lint-and-save",
      name: "Run vault lint and save report",
      callback: async () => { await this.runVaultLintAndSave(); }
    });

    // Settings tab
    this.settingsTabInstance = new z5LinterSettingsTab(this.app, this);
    this.addSettingTab(this.settingsTabInstance);

    // Status bar
    if (this.settings.show_status_bar) this.createStatusBar();

    // Vault events
    this.registerEvent(this.app.vault.on("modify", (file) => this.onVaultFileChanged(file.path)));
    this.registerEvent(this.app.vault.on("create", (file) => this.onVaultFileChanged(file.path)));
    this.registerEvent(this.app.vault.on("delete", (file) => this.onVaultFileChanged(file.path)));
    this.registerEvent(this.app.vault.on("rename", (file: any, oldPath: string) => {
      try {
        if (oldPath === this.settings.schema_doc || (file && file.path === this.settings.schema_doc)) {
          this.onVaultFileChanged(this.settings.schema_doc);
        }
        if (file && file.path) this.onVaultFileChanged(file.path);
      } catch (e) {
        console.warn("z5Linter: rename handler error", e);
      }
    }));

    // Workspace events
    this.registerEvent(this.app.workspace.on("layout-change", () => this.resolveCanonicalLeaf()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", async () => {
      await this.linter.onActiveLeafChange();
      // lightweight update of sidebar active-file UI
      await this.updateSidebarForActiveFile();
    }));

    // Run initial lint for active file (engine may cache results)
    try {
      const initial = await this.linter.runLintForActiveFile();
      this.onLintResults(initial || []);
    } catch (e) {
      console.warn("z5Linter: initial lint failed", e);
    }
  }

  onunload() {
    // cleanup UI pieces
    this.removeStatusBar();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<z5LinterSettings>);
  }

  async saveSettings() {
    await this.saveData(this.settings);
    // propagate settings to engine and schedule light refresh
    this.linter.settings = this.settings;
    this.linter.onVaultChange();
    this.refreshSchemaViewsDebounced();
  }

  // Called when vault events indicate a file changed; debounce to avoid thrash
  private onVaultFileChanged(changedPath: string) {
    if (!this.settings) return;
    this.linter.onVaultChange();
    this.refreshSchemaViewsDebounced();
  }

  // Debounced lightweight refresh (calls targeted updater)
  private refreshSchemaViewsDebounced(delay = 200) {
    if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(async () => {
      this.refreshTimer = null;
      await this.updateSidebarForActiveFile();
    }, delay);
  }

  // Resolve canonical leaf for our view type (keep one canonical instance)
  private resolveCanonicalLeaf(): WorkspaceLeaf | null {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_LINTER);
    if (leaves.length === 0) {
      this._canonicalSchemaLeaf = null;
      return null;
    }
    const primary = leaves[0];
    for (let i = 1; i < leaves.length; i++) {
      try { leaves[i].detach(); } catch (e) { console.warn("z5Linter: failed to detach extra schema leaf", e); }
    }
    this._canonicalSchemaLeaf = primary;
    return primary;
  }

  // Open the Schema YAML sidebar, reusing an existing leaf if present.
  async openSchemaSidebar(): Promise<WorkspaceLeaf | null> {
    try {
      let canonical = this.resolveCanonicalLeaf();
      if (canonical) {
        await canonical.setViewState({ type: VIEW_TYPE_LINTER, active: true });
        this.app.workspace.revealLeaf(canonical);
        // lightweight update
        await this.updateSidebarForActiveFile();
        return canonical;
      }

      // prefer existing right leaf to avoid splitting
      let rightLeaf = this.app.workspace.getRightLeaf(false);
      if (!rightLeaf) rightLeaf = this.app.workspace.getRightLeaf(true);
      if (!rightLeaf) throw new Error("Could not obtain a right leaf");

      await rightLeaf.setViewState({ type: VIEW_TYPE_LINTER, active: true });

      canonical = this.resolveCanonicalLeaf() || rightLeaf;
      this._canonicalSchemaLeaf = canonical;
      this.app.workspace.revealLeaf(canonical);
      // lightweight update
      await this.updateSidebarForActiveFile();
      return canonical;
    } catch (err) {
      console.error("z5Linter: openSchemaSidebar failed:", err);
      new Notice("z5Linter: could not open schema sidebar (see console)");
      return null;
    }
  }

  // Lightweight updater: refresh active-file results into any open sidebar view
  public async updateSidebarForActiveFile(): Promise<void> {
    try {
      await refreshActiveFileFromEngine(this);
    } catch (err) {
      console.warn("z5Linter: updateSidebarForActiveFile failed", err);
    }
  }

  // Backwards-compatible no-op so old call sites don't throw
  public async refreshSchemaViews(): Promise<void> {
    return;
  }

  // Status bar helpers (thin wrappers to the status_bar module)
  public createStatusBar() {
    const el = createStatusBarUI(this);
    this.statusBarEl = el;
  }
  public removeStatusBar() {
    removeStatusBarUI();
    this.statusBarEl = null;
  }
  public updateStatusBarCounts(results: LintResult[]) {
    updateStatusBarUI(results);
  }

  // Called by engine when new lint results are available
  public onLintResults(results: LintResult[]) {
    // store canonical results
    this.latestLintResults = results || [];
    // update status bar
    if (this.settings.show_status_bar) this.updateStatusBarCounts(results);
    // update sidebar if open
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_LINTER);
    if (leaves.length > 0) {
      const view = leaves[0].view as any;
      if (view && typeof view.updateHeaderCounts === "function" && typeof view.renderResults === "function") {
        view.updateHeaderCounts(results);
        view.renderResults(results);
      }
    }
  }

  // Run vault lint and save report (uses engine if available)
  public async runVaultLintAndSave(): Promise<void> {
    const reportPath = this.buildReportFilename();
    try {
      await this.ensureReportsFolderExists();

      const results = typeof (this.linter as any).runLintForVault === "function"
        ? await (this.linter as any).runLintForVault()
        : (await (this.linter as any).runLintForActiveFile()) || [];

      const content = JSON.stringify({
        generatedAt: new Date().toISOString(),
        pluginVersion: this.manifest.version,
        results
      }, null, 2);

      await this.app.vault.create(reportPath, content);
      new Notice(`Linter report saved: ${reportPath}`);
    } catch (err) {
      console.error("Failed to run vault lint or save report", err);
      new Notice("Failed to save linter report: " + String(err));
    }
  }

  // Read the most recent report from the reports folder
  public async getLatestReport(): Promise<{ path: string, content: any } | null> {
    const folder = this.settings.reportsFolder?.trim() || "reports/linter";
    const files = this.app.vault.getFiles().filter(f => f.path.startsWith(folder + "/"));
    if (!files.length) return null;
    files.sort((a, b) => {
      const am = (a.stat && (a.stat.mtime || 0)) || 0;
      const bm = (b.stat && (b.stat.mtime || 0)) || 0;
      return bm - am;
    });
    const latest = files[0];
    try {
      const raw = await this.app.vault.read(latest);
      const parsed = JSON.parse(raw);
      return { path: latest.path, content: parsed };
    } catch (e) {
      console.error("Failed to read/parse latest report", e);
      return null;
    }
  }

  // Ensure the reports folder exists (creates intermediate folders as needed)
  public async ensureReportsFolderExists(): Promise<void> {
    const folder = this.settings.reportsFolder?.trim() || "reports/linter";
    const parts = folder.split("/").filter(Boolean);
    let pathSoFar = "";
    for (const part of parts) {
      pathSoFar = pathSoFar ? `${pathSoFar}/${part}` : part;
      const af = this.app.vault.getAbstractFileByPath(pathSoFar);
      if (!af) {
        await this.app.vault.createFolder(pathSoFar);
      }
    }
  }

  // Build a timestamped filename for reports
  private buildReportFilename(): string {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const folder = this.settings.reportsFolder?.trim() || "reports/linter";
    return `${folder}/linter-report-${ts}.json`;
  }
}
