import { App, Notice, Plugin, WorkspaceLeaf, TFile } from "obsidian";
import { DEFAULT_SETTINGS, z5LinterSettings, z5LinterSettingsTab } from "./settings";
import { Z5LinterEngine, LintResult } from "./linter";
import { LinterSidebarView } from "./sidebar";
import { refreshActiveFileFromEngine } from "./sidebar_single_file";
import { initVaultUI } from "./sidebar_vault";
//import { createStatusBar as createStatusBarUI, updateStatusBarCounts as updateStatusBarUI, removeStatusBar as removeStatusBarUI } from "./status_bar";
import { createStatusBar, updateStatusBarCounts, removeStatusBar } from "./status_bar";
import { VaultLinter } from "./vault_linter";


const VIEW_TYPE_LINTER = "z5-linter-view";


// This is the plugin itself. Everything goes through here.
export default class z5Linter extends Plugin {

  // the class we access settings though, given a name
  public settings: z5LinterSettings;

  // the linter engine, which runs the actual linting operations
  public linter: Z5LinterEngine;

  // the settings page itself
  public settingsTabInstance: z5LinterSettingsTab | null = null;

  // the sidebar instance. it registers itself by calling plugin.registerSidebarInstance().
  private sidebarInstance: LinterSidebarView | null = null;

  // the status bar instance. it registers itself by calling plugin.registerStatusBarInstance()
  private statusBarInstance: HTMLElement | null = null;


  // Vault Linter, the linter wrapper that handles the whole vault
  public vaultLinter: VaultLinter | null = null;

  // a blank table in which we store whatever linting results occurred most recently
  // concern: are we sharing single-file and full-vault results here?
  // will single-file results during a full-vault lint cause issues?
  public latestLintResults: LintResult[] = [];

  // used for debouncing the UI refresh. 
  private refreshTimer: number | null = null;

  // the sidebar we use for our UI
  // TODO: rename this to something less shit
  // TODO: shouldn't this live in sidebar.ts?
  private _canonicalSchemaLeaf: WorkspaceLeaf | null = null;

  async onload() {
    // loads our settings data, required for 
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
      callback: async () => { await this.vaultLinter.runVaultLintAndSave(); }
    });

    // Ribbon button
    // Add ribbon icon to open the sidebar (reuses existing leaf if present)
    this.addRibbonIcon('dice', 'Open Schema YAML', async () => {
      await this.openSchemaSidebar();
    });


    // Settings tab
    this.settingsTabInstance = new z5LinterSettingsTab(this.app, this);
    this.addSettingTab(this.settingsTabInstance);

    // Status bar
    if (this.settings.show_status_bar) createStatusBar(this);


    // Vault Linter
    this.vaultLinter = new VaultLinter(this);

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
      //await this.linter.onActiveLeafChange();
      // lightweight update of sidebar active-file UI
      await this.runActiveFileLint();
    }));

    // Run initial lint for active file (engine may cache results)
    try {
      await this.runActiveFileLint();
    } catch (e) {
      console.warn("z5Linter: initial lint failed", e);
    }
  }

  onunload() {
    // cleanup UI pieces
    removeStatusBar();
  }


  // load settings from obsidian
  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<z5LinterSettings>);
  }

  // saves settings after modification
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
      await this.runActiveFileLint();
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
        setTimeout(() => {
          try {
            const view = (canonical.view as any);
            if (view?.containerEl && typeof view.containerEl.focus === 'function') {
              view.containerEl.focus();
            }
          } catch (e) {}
        }, 40);

        // lightweight update
        await this.runActiveFileLint();
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
      await this.runActiveFileLint();
      return canonical;
    } catch (err) {
      console.error("z5Linter: openSchemaSidebar failed:", err);
      new Notice("z5Linter: could not open schema sidebar (see console)");
      return null;
    }
  }

  public async runActiveFileLint(): Promise<void> {
    try {
      // lints the active file
      const results = await this.linter.runLintForActiveFile();
      this.latestLintResults = results;

      // update the status bar with our results
      if (this.settings.show_status_bar) {
        updateStatusBarCounts(results);
      }

      // update the sidebar with our results
      if (this.sidebarInstance) {
          this.sidebarInstance.updateHeaderCounts(results);
          this.sidebarInstance.renderResults(results);
      }

    } catch (err) {
      console.warn("z5Linter: runActiveFileLint failed", err);
    }
  }




  // called by the sidebar on creation. used to register the sidebar here, in the plugin. 
  public registerSidebarInstance(view: LinterSidebarView) {
    this.sidebarInstance = view;
  }

  public registerStatusBarInstance(el: HTMLElement) {
    this.statusBarInstance = el;
  }

}
