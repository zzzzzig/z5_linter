import { App, MarkdownView, Notice, Plugin, ItemView, WorkspaceLeaf, TFile } from 'obsidian';
import { DEFAULT_SETTINGS, z5LinterSettings, z5LinterSettingsTab } from "./settings";
import { Z5LinterEngine } from "./linter"; // linter module
import { setIcon } from "obsidian";


// (keep any other imports you need)


const VIEW_TYPE_LINTER = 'z5-linter-view';

export default class z5Linter extends Plugin {
  settings: z5LinterSettings;
  private refreshTimer: number | null = null;
  private _canonicalSchemaLeaf: WorkspaceLeaf | null = null;
  public linter: Z5LinterEngine;
  public latestLintResults: LintResult[] = [];


  async onload() {
    await this.loadSettings();

    // instantiate linter engine (it reads plugin.settings internally)
    this.linter = new Z5LinterEngine(this);

    // Register the sidebar view
    this.registerView(
      VIEW_TYPE_LINTER,
      (leaf: WorkspaceLeaf) => new LinterSidebarView(leaf, this)
    );

    // Add ribbon icon to open the sidebar (reuses existing leaf if present)
    this.addRibbonIcon('dice', 'Open Schema YAML', async () => {
      await this.openSchemaSidebar();
    });

    // Add a command to open the sidebar
    this.addCommand({
      id: 'z5linter-open-schema-sidebar',
      name: 'Open Schema YAML sidebar',
      callback: async () => {
        await this.openSchemaSidebar();
      }
    });

    // Register command
    this.addCommand({
      id: "z5-run-vault-lint-and-save",
      name: "Run vault lint and save report",
      callback: async () => {
        await this.runVaultLintAndSave();
      }
    });

    // Create the settings tab
    this.settingsTabInstance = new z5LinterSettingsTab(this.app, this);
    this.addSettingTab(this.settingsTabInstance);

    // Create status bar if enabled
    if (this.settings.show_status_bar) this.createStatusBar();

    // Vault events: refresh linter on modify/create/delete/rename
    this.registerEvent(this.app.vault.on('modify', (file) => {
      this.onVaultFileChanged(file.path);
    }));
    this.registerEvent(this.app.vault.on('create', (file) => {
      this.onVaultFileChanged(file.path);
    }));
    this.registerEvent(this.app.vault.on('delete', (file) => {
      this.onVaultFileChanged(file.path);
    }));
    this.registerEvent(this.app.vault.on('rename', (file: any, oldPath: string) => {
      if (oldPath === this.settings.schema_doc || (file && file.path === this.settings.schema_doc)) {
        this.onVaultFileChanged(this.settings.schema_doc);
      }
      // also trigger linter refresh because active file may have been renamed
      this.onVaultFileChanged(file.path);
    }));

    // Keep canonical leaf cache in sync when layout changes or active leaf changes
    this.registerEvent(this.app.workspace.on('layout-change', () => {
      this.resolveCanonicalLeaf();
    }));
    this.registerEvent(this.app.workspace.on('active-leaf-change', async () => {
      // run linter when active leaf changes
      await this.linter.onActiveLeafChange();
      // if our sidebar is open, refresh its view
      this.refreshSchemaViews();
    }));

    // Run an initial lint for the active file
    await this.linter.runLintForActiveFile();
  }


  onunload() {
    // Obsidian will clean up registered events and views
    this.removeStatusBar();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<z5LinterSettings>);
  }

  async saveSettings() {
    await this.saveData(this.settings);
    // When settings change (schema file/heading), refresh linter and views
    this.linter.settings = this.settings;
    this.linter.onVaultChange(); // schedule a reload
    this.refreshSchemaViewsDebounced();
  }

  // Called when vault events indicate a file changed; debounce to avoid thrash
  private onVaultFileChanged(changedPath: string) {
    // If the schema file changed, reload schema; if active file changed, re-run linter
    if (!this.settings) return;
    // Always notify linter (it will decide whether to reload schema or re-run)
    this.linter.onVaultChange();
    // Also refresh the sidebar view (debounced)
    this.refreshSchemaViewsDebounced();
  }

  // Debounced refresh to coalesce rapid file events
  private refreshSchemaViewsDebounced(delay = 200) {
    if (this.refreshTimer) {
      window.clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      this.refreshSchemaViews();
    }, delay);
  }

  // Resolve and normalize canonical leaf for our view type
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
        this.refreshSchemaViews();
        return canonical;
      }

      // prefer existing right leaf to avoid splitting
      let rightLeaf = this.app.workspace.getRightLeaf(false);
      if (!rightLeaf) {
        rightLeaf = this.app.workspace.getRightLeaf(true);
        if (!rightLeaf) throw new Error("getRightLeaf returned no leaf");
      }

      await rightLeaf.setViewState({ type: VIEW_TYPE_LINTER, active: true });

      // re-resolve canonical leaf (Obsidian may have created the real instance)
      canonical = this.resolveCanonicalLeaf();
      if (!canonical) {
        canonical = rightLeaf;
        this._canonicalSchemaLeaf = canonical;
      }

      this.app.workspace.revealLeaf(canonical);
      //this.refreshSchemaViews();
      return canonical;
    } catch (err) {
      console.error("z5Linter: openSchemaSidebar failed:", err);
      new Notice("z5Linter: could not open schema sidebar (see console)");
      return null;
    }
  }

  // Implementation
  public async runVaultLintAndSave(): Promise<void> {
    const reportPath = this.buildReportFilename();
    try {
      await this.ensureReportsFolderExists();

      // 1) Run your vault lint engine. Replace the next line with your engine call.
      // Example: const results = await this.linterEngine.runLintForVault();
      const results = await this.runVaultLint(); // implement this to return LintResult[]

      // 2) Serialize and write file
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


  public async getLatestReport(): Promise<{ path: string, content: any } | null> {
    const folder = this.settings.reportsFolder?.trim() || "reports/linter";
    // gather all files in vault and filter by path prefix
    const files = this.app.vault.getFiles().filter(f => f.path.startsWith(folder + "/"));
    if (!files.length) return null;

    // sort by mtime (descending)
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


  // fields on the plugin class
  private statusBarEl: HTMLElement | null = null;

  // Create a simple status bar entry if not already present
  public createStatusBar() {
    if (this.statusBarEl) return;

    const el = this.addStatusBarItem();
    el.addClass("z5-linter-status");

    // Build three blocks inside the status item
    el.innerHTML = ""; // ensure empty
    const makeBlock = (cls: string, iconName: string) => {
      const block = document.createElement("span");
      block.className = `z5-ls ${cls}`;
      // icon container
      const iconWrap = document.createElement("span");
      iconWrap.className = "z5-ls-icon";
      // setIcon will inject an <svg> into iconWrap
      setIcon(iconWrap, iconName);
      // count element
      const count = document.createElement("span");
      count.className = "z5-ls-count";
      count.textContent = "0";
      block.appendChild(iconWrap);
      block.appendChild(count);
      return block;
    };

    el.appendChild(makeBlock("err", "octagon-x"));
    el.appendChild(makeBlock("warn", "triangle-alert"));
    el.appendChild(makeBlock("info", "info"));

    el.onclick = () => this.openLinterSidebar();
    el.title = "Click to open z5 Linter";
    this.statusBarEl = el;
  }


  // Remove the status bar entry if present
  public removeStatusBar() {
    if (!this.statusBarEl) return;
    try { this.statusBarEl.remove(); } catch (e) { /* ignore */ }
    this.statusBarEl = null;
  }

  // Update the status bar text directly
  public updateStatusBarText(text: string) {
    if (!this.statusBarEl) return;
    if (typeof (this.statusBarEl as any).setText === "function") {
      (this.statusBarEl as any).setText(text);
    } else {
      this.statusBarEl.textContent = text;
    }
  }

  public updateStatusBarCounts(results: LintResult[]) {
    if (!this.settings.show_status_bar) return;
    if (!this.statusBarEl) this.createStatusBar();

    const counts = { error: 0, warning: 0, info: 0 };
    for (const r of results) {
      if (r.severity === "error") counts.error++;
      else if (r.severity === "warning") counts.warning++;
      else counts.info++;
    }

    const errBlock = this.statusBarEl.querySelector(".z5-ls.err");
    const warnBlock = this.statusBarEl.querySelector(".z5-ls.warn");
    const infoBlock = this.statusBarEl.querySelector(".z5-ls.info");

    if (errBlock) {
      const el = errBlock.querySelector(".z5-ls-count") as HTMLElement | null;
      if (el) el.textContent = String(counts.error);
    }
    if (warnBlock) {
      const el = warnBlock.querySelector(".z5-ls-count") as HTMLElement | null;
      if (el) el.textContent = String(counts.warning);
    }
    if (infoBlock) {
      const el = infoBlock.querySelector(".z5-ls-count") as HTMLElement | null;
      if (el) el.textContent = String(counts.info);
    }

    // update titles/tooltips if you want top message preview
    const errors = results.filter(r => r.severity === "error");
    if (errBlock) errBlock.title = errors.length ? errors[0].message : "No errors";
    // ...same for warn/info
  }





  // Open or reveal the linter sidebar/view
  public openLinterSidebar() {
    // Try to reveal an existing registered view first
    const viewType = VIEW_TYPE_LINTER;
    const leaves = this.app.workspace.getLeavesOfType(viewType);
    if (leaves.length > 0) {
      // reveal the first existing leaf
      this.app.workspace.revealLeaf(leaves[0]);
      return;
    }

    // Otherwise create a new right leaf and set the view type
    const leaf = this.app.workspace.getRightLeaf(false);
    leaf.setViewState({ type: viewType, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  public getSidebarViewInstance(): LinterSidebarView | null {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_LINTER);
    if (!leaves || leaves.length === 0) return null;
    const view = leaves[0].view;
    // Ensure the view exposes the methods we expect
    if (view && typeof (view as any).updateHeaderCounts === "function" && typeof (view as any).renderResults === "function") {
      return view as LinterSidebarView;
    }
    return null;
  }



  public onLintResults(results: LintResult[]) {
    this.updateStatusBarCounts(results);

    const view = this.getSidebarViewInstance();
    if (view) {
      view.updateHeaderCounts(results);
      view.renderResults(results);
    }
    // store latest results for other callers (optional but useful)
    (this as any).latestLintResults = results;
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
        // createFolder throws if parent missing, so create progressively
        await this.app.vault.createFolder(pathSoFar);
      }
    }
  }

  // Build a timestamped filename
  private buildReportFilename(): string {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const ts = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const folder = this.settings.reportsFolder?.trim() || "reports/linter";
    return `${folder}/linter-report-${ts}.json`;
  }

  private extractHeadingsFromContent(content: string): string[] {
    const headings: string[] = [];
    const atx = content.matchAll(/^#{1,6}\s+(.*)$/gm);
    for (const m of atx) {
      if (m[1]) headings.push(m[1].trim());
    }
    return headings;
  }
  // The real refreshSchemaViews implementation
  public async refreshSchemaViews(): Promise<void> {
    return
  }
}

/* -------------------------
   Sidebar view implementation (reused, now shows lint results)
   ------------------------- */

export class LinterSidebarView extends ItemView {
  plugin: z5Linter;
  private openState: Record<string, boolean> = { error: true, warning: false, info: false };

  constructor(leaf: WorkspaceLeaf, plugin: z5Linter) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() { return VIEW_TYPE_LINTER; }
  getDisplayText() { return "z5 Linter"; }

  onOpen() {
    this.containerEl.empty();

    // Active file box (label + header + lists)
    const activeBox = this.containerEl.createDiv("z5-linter-active-box");

    const activeLabel = activeBox.createDiv("z5-linter-active-label");
    activeLabel.textContent = "Active file";

    const activeContent = activeBox.createDiv("z5-linter-active-content");

    // Header (inside active content)
    const header = activeContent.createDiv("z5-linter-header");

    const makeBlock = (type: "error" | "warning" | "info", iconName: string) => {
      const cls = type === "error" ? "err" : type === "warning" ? "warn" : "info";
      const block = header.createDiv("z5-linter-head-block " + cls);
      block.dataset.type = type;
      block.setAttr("role", "button");
      block.setAttr("tabindex", "0");
      block.setAttr("aria-expanded", String(this.openState[type]));

      // icon container (setIcon will inject SVG)
      const iconWrap = block.createSpan("z5-ls-icon");
      try { setIcon(iconWrap, iconName); } catch (e) { /* setIcon may be unavailable in tests */ }

      const countEl = block.createSpan("z5-linter-head-count");
      countEl.textContent = "0";

      const arrow = block.createSpan("z5-linter-head-arrow");
      arrow.textContent = "▶";

      if (this.openState[type]) block.addClass("open");
      return block;
    };

    const errBlock  = makeBlock("error", "octagon-x");
    const warnBlock = makeBlock("warning", "triangle-alert");
    const infoBlock = makeBlock("info", "info");

    // Sections (lists) inside active content
    const errSection  = activeContent.createEl("ul", { cls: "z5-linter-results z5-linter-section-error" });
    const warnSection = activeContent.createEl("ul", { cls: "z5-linter-results z5-linter-section-warning" });
    const infoSection = activeContent.createEl("ul", { cls: "z5-linter-results z5-linter-section-info" });

    // Hidden class handling
    if (!this.openState.error)  errSection.addClass("hidden");
    if (!this.openState.warning) warnSection.addClass("hidden");
    if (!this.openState.info)    infoSection.addClass("hidden");

    // Click / keyboard handlers for expand/collapse
    header.querySelectorAll(".z5-linter-head-block").forEach((el) => {
      const block = el as HTMLElement;
      const type = block.dataset.type!;
      const section = activeContent.querySelector(`.z5-linter-section-${type}`) as HTMLElement;

      const toggle = () => {
        const isOpen = block.classList.toggle("open");
        this.openState[type] = isOpen;
        block.setAttr("aria-expanded", String(isOpen));
        if (isOpen) section.classList.remove("hidden");
        else section.classList.add("hidden");
      };

      block.addEventListener("click", toggle);
      block.addEventListener("keydown", (ev: KeyboardEvent) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          toggle();
        }
      });
    });

    // Vault box (separate area for vault-wide summary)
    const vaultBox = this.containerEl.createDiv("z5-linter-vault-box");
    const vaultLabel = vaultBox.createDiv("z5-linter-active-label");
    vaultLabel.textContent = "Vault";
    // Placeholder content — populate as you implement vault-wide features
    const vaultContent = vaultBox.createDiv("z5-linter-vault-content");
    vaultContent.textContent = ""; // fill later

    // Populate with latest results if available
    const latest = (this.plugin as any).latestLintResults ?? [];
    this.updateHeaderCounts(latest);
    this.renderResults(latest);


    // in LinterSidebarView.onOpen() or render area for Vault box
    const loadBtn = vaultContent.createEl("button", { text: "Load latest report" });
    loadBtn.addEventListener("click", async () => {
      const rep = await this.plugin.getLatestReport();
      if (!rep) {
        new Notice("No reports found in " + (this.plugin.settings.reportsFolder || "reports/linter"));
        return;
      }
      // rep.content.results is the array you saved earlier
      this.updateHeaderCounts(rep.content.results || []);
      this.renderResults(rep.content.results || []);
      new Notice("Loaded report: " + rep.path);
    });

  }

  onClose() {
    // nothing special for now
  }

  public updateHeaderCounts(results: LintResult[]) {
    const errors   = results.filter(r => r.severity === "error");
    const warnings = results.filter(r => r.severity === "warning");
    const infos    = results.filter(r => r.severity === "info");

    const errCountEl  = this.containerEl.querySelector('.z5-linter-head-block.err .z5-linter-head-count') as HTMLElement | null;
    const warnCountEl = this.containerEl.querySelector('.z5-linter-head-block.warn .z5-linter-head-count') as HTMLElement | null;
    const infoCountEl = this.containerEl.querySelector('.z5-linter-head-block.info .z5-linter-head-count') as HTMLElement | null;

    if (errCountEl)  errCountEl.textContent  = String(errors.length);
    if (warnCountEl) warnCountEl.textContent = String(warnings.length);
    if (infoCountEl) infoCountEl.textContent = String(infos.length);

    // tooltips: top message or fallback
    const errTip  = errors.length   ? errors[0].message   : "No errors";
    const warnTip = warnings.length ? warnings[0].message : "No warnings";
    const infoTip = infos.length    ? infos[0].message    : "No info messages";

    if (errCountEl)  errCountEl.title  = errTip;
    if (warnCountEl) warnCountEl.title = warnTip;
    if (infoCountEl) infoCountEl.title = infoTip;
  }

  public renderResults(results: LintResult[]) {
    const errSection  = this.containerEl.querySelector('.z5-linter-section-error') as HTMLElement;
    const warnSection = this.containerEl.querySelector('.z5-linter-section-warning') as HTMLElement;
    const infoSection = this.containerEl.querySelector('.z5-linter-section-info') as HTMLElement;

    if (!errSection || !warnSection || !infoSection) return;

    // clear
    errSection.innerHTML = "";
    warnSection.innerHTML = "";
    infoSection.innerHTML = "";

    for (const r of results) {
      const li = document.createElement("li");
      li.className = `z5-linter-${r.severity}`;
      // main message
      const msg = document.createElement("div");
      msg.textContent = r.message;
      li.appendChild(msg);

      // optional metadata
      if (r.field) {
        const f = document.createElement("div");
        f.className = "z5-linter-field";
        f.textContent = `Field: ${r.field}`;
        li.appendChild(f);
      }
      if (r.rule) {
        const ru = document.createElement("div");
        ru.className = "z5-linter-rule";
        ru.textContent = `Rule: ${r.rule}`;
        li.appendChild(ru);
      }

      // click to jump behavior (optional)
      li.addEventListener("click", () => {
        if (r.field && typeof (this.plugin as any).jumpToField === "function") {
          (this.plugin as any).jumpToField(r.field);
        }
      });

      if (r.severity === "error") errSection.appendChild(li);
      else if (r.severity === "warning") warnSection.appendChild(li);
      else infoSection.appendChild(li);
    }
  }
}



/* -------------------------
   Small helper
   ------------------------- */

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
