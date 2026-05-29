import { ItemView, WorkspaceLeaf, Notice, setIcon } from "obsidian";
import type z5Linter from "./main";
import { updateActiveFileUI } from "./sidebar_single_file";
import { initVaultUI } from "./sidebar_vault";

/**
 * LinterSidebarView: thin ItemView that delegates rendering to submodules.
 * Keep this file focused on DOM scaffolding and delegating updates.
 */
export class LinterSidebarView extends ItemView {
  plugin: z5Linter;
  private openState = { error: true, warning: false, info: false };

  constructor(leaf: WorkspaceLeaf, plugin: z5Linter) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() { return "z5-linter-view"; }
  getDisplayText() { return "z5 Linter"; }

  onOpen() {
    this.containerEl.empty();

    // Build the shared structure (Active box + Vault box)
    const activeBox = this.containerEl.createDiv("z5-linter-active-box");
    const activeLabel = activeBox.createDiv("z5-linter-active-label");
    activeLabel.textContent = "Active file";
    const activeContent = activeBox.createDiv("z5-linter-active-content");

    // header + lists are created by the single-file initializer
    initActiveFileDOM(activeContent);

    const vaultBox = this.containerEl.createDiv("z5-linter-vault-box");
    const vaultLabel = vaultBox.createDiv("z5-linter-active-label");
    vaultLabel.textContent = "Vault";
    const vaultContent = vaultBox.createDiv("z5-linter-vault-content");

    // initialize vault UI (load button etc.)
    initVaultUI(vaultContent, this.plugin);

    // populate with latest results if plugin has them
    const latest = (this.plugin as any).latestLintResults ?? [];
    updateActiveFileUI(latest, this);
  }

  onClose() { /* nothing special */ }

  // Expose small helpers used by controllers
  public updateHeaderCounts(results: any[]) {
    // find header count elements and update
    const err = this.containerEl.querySelector('.z5-linter-head-block.err .z5-linter-head-count') as HTMLElement | null;
    const warn = this.containerEl.querySelector('.z5-linter-head-block.warn .z5-linter-head-count') as HTMLElement | null;
    const info = this.containerEl.querySelector('.z5-linter-head-block.info .z5-linter-head-count') as HTMLElement | null;
    if (err) err.textContent = String(results.filter(r => r.severity === "error").length);
    if (warn) warn.textContent = String(results.filter(r => r.severity === "warning").length);
    if (info) info.textContent = String(results.filter(r => r.severity === "info").length);
  }

  public renderResults(results: any[]) {
    // delegate to the same DOM used by single-file controller
    const errSection = this.containerEl.querySelector('.z5-linter-section-error') as HTMLElement | null;
    const warnSection = this.containerEl.querySelector('.z5-linter-section-warning') as HTMLElement | null;
    const infoSection = this.containerEl.querySelector('.z5-linter-section-info') as HTMLElement | null;
    if (!errSection || !warnSection || !infoSection) return;
    // clear and render (simple, same as your existing renderResults)
    errSection.innerHTML = ""; warnSection.innerHTML = ""; infoSection.innerHTML = "";
    for (const r of results) {
      const li = document.createElement("li");
      li.className = `z5-linter-${r.severity}`;
      const msg = document.createElement("div"); msg.textContent = r.message; li.appendChild(msg);
      if (r.field) { const f = document.createElement("div"); f.className = "z5-linter-field"; f.textContent = `Field: ${r.field}`; li.appendChild(f); }
      if (r.rule) { const ru = document.createElement("div"); ru.className = "z5-linter-rule"; ru.textContent = `Rule: ${r.rule}`; li.appendChild(ru); }
      if (r.severity === "error") errSection.appendChild(li);
      else if (r.severity === "warning") warnSection.appendChild(li);
      else infoSection.appendChild(li);
    }
  }
}

/* Small helper to create the header + lists DOM used by the view and controllers */
export function initActiveFileDOM(container: HTMLElement) {
  const header = container.createDiv("z5-linter-header");
  const makeBlock = (type: "error"|"warning"|"info", iconName: string) => {
    const cls = type === "error" ? "err" : type === "warning" ? "warn" : "info";
    const block = header.createDiv("z5-linter-head-block " + cls);
    block.dataset.type = type;
    block.setAttr("role", "button");
    block.setAttr("tabindex", "0");
    const iconWrap = block.createSpan("z5-ls-icon");
    try { setIcon(iconWrap, iconName); } catch {}
    block.createSpan("z5-linter-head-count").textContent = "0";
    block.createSpan("z5-linter-head-arrow").textContent = "▶";
    return block;
  };
  makeBlock("error","octagon-x"); makeBlock("warning","triangle-alert"); makeBlock("info","info");
  container.createEl("ul", { cls: "z5-linter-results z5-linter-section-error" });
  container.createEl("ul", { cls: "z5-linter-results z5-linter-section-warning" });
  container.createEl("ul", { cls: "z5-linter-results z5-linter-section-info" });
}
