// src/sidebar_vault.ts
import { Notice, TFile, setIcon } from "obsidian";
import type z5Linter from "./main";
import { VaultLinter } from "./vault_linter";

/**
 * Vault sidebar UI (four-icon header + top-file list).
 *
 * - Top buttons: Run / Load latest / Open latest results
 * - Icon header: [list summary icon (toggles all entries)] [error] [warning] [info]
 * - Header counts loaded from saved JSON's fileSummaries when available
 * - Renders top N files sorted by highest severity -> total desc -> firstIndex asc
 * - Entries reuse single-file class names so existing CSS applies
 *
 * Enhancements in this version:
 * - Chips on each card show an icon + count (uses .z5-ls/.z5-ls-count classes so hover tinting works)
 * - Each chip has a tooltip (title) showing the top message for that severity for that file
 * - Top-message tooltips are built from the report's results (falls back to empty string)
 */

const TOP_FILES_COUNT = 10;

type FileSummary = {
  path: string;
  errors: number;
  warnings: number;
  info: number;
  total: number;
  highest: "error" | "warning" | "info";
  firstIndex: number;
};

export function initVaultUI(container: HTMLElement, plugin: z5Linter) {
  // Clear existing content but keep the container's original class names
  container.empty();

  // Ensure a single VaultLinter instance on plugin
  function ensureVaultLinter(): VaultLinter {
    let vl = (plugin as any).vaultLinter as VaultLinter | undefined;
    if (!vl) {
      vl = new VaultLinter(plugin);
      (plugin as any).vaultLinter = vl;
    }
    return vl;
  }

  // Top row: label + run / load / open latest buttons
  const topRow = container.createDiv("z5-vault-toprow");
  const label = topRow.createDiv("z5-linter-active-label");

  const btnGroup = topRow.createDiv("z5-vault-btns");
  const runBtn = btnGroup.createEl("button", { text: "Run vault lint" });
  const loadBtn = btnGroup.createEl("button", { text: "Load latest" });
  const openLatestBtn = btnGroup.createEl("button", { text: "Open latest results" });

  // Progress area (above HR)
  const progressWrap = container.createDiv("z5-vault-progress-wrap");
  progressWrap.style.marginTop = "6px";
  container.appendChild(progressWrap);

  // Horizontal rule
  container.createEl("hr");

  // Header (summary + error + warning + info)
  const header = container.createDiv("z5-linter-header z5-linter-vault-header");
  const blocks: Record<string, HTMLElement> = {};
  const sections: Record<string, HTMLElement> = {};

  /**
   * Create a header block.
   *
   * - For the summary/list block (clickable = true) we add role/tabindex and arrow.
   * - For severity blocks (clickable = false) we render only icon + count and leave them non-interactive.
   */
  const makeBlock = (
    key: string,
    typeClass: string,
    iconName: string,
    initialCount = "0",
    clickable = false,
    showArrow = true
  ) => {
    const block = header.createDiv("z5-linter-head-block " + typeClass);
    block.dataset.type = key;

    // Icon
    const iconWrap = block.createSpan("z5-ls-icon");
    try {
      setIcon(iconWrap, iconName);
    } catch {
      iconWrap.textContent = key === "summary" ? "▦" : (typeClass === "err" ? "!" : typeClass === "warn" ? "!" : "i");
    }

    // Count
    block.createSpan("z5-linter-head-count").textContent = initialCount;

    // Arrow: only show the arrow glyph for clickable blocks (summary/list)
    const arrow = block.createSpan("z5-linter-head-arrow");
    arrow.textContent = clickable && showArrow ? "▶" : "";

    // If clickable, expose as a button for accessibility; otherwise keep it static
    if (clickable) {
      block.setAttr("role", "button");
      block.setAttr("tabindex", "0");
    } else {
      // ensure non-interactive blocks do not receive focus or button semantics
      block.removeAttribute("role");
      block.removeAttribute("tabindex");
    }

    blocks[key] = block;
    return block;
  };

  // summary/list icon on the left — shows arrow and toggles the entries area
  const mainBlock = makeBlock("summary", "summary", "list", "0", true, true);

  // severity blocks — non-interactive display only
  makeBlock("error", "err", "octagon-x", "0", false, false);
  makeBlock("warning", "warn", "triangle-alert", "0", false, false);
  makeBlock("info", "info", "info", "0", false, false);

  // Boxes container (entries area) — toggled by mainBlock
  const boxesWrap = container.createDiv("z5-vault-boxes-wrap");
  // We'll render a single combined list inside boxesWrap (below)
  const combinedList = document.createElement("div");
  combinedList.className = "z5-vault-combined-file-list";
  combinedList.setAttribute("role", "list");
  boxesWrap.appendChild(combinedList);

  // Main block toggles the combined entries area
  let boxesVisible = true;
  mainBlock.classList.add("open");
  mainBlock.setAttr("aria-expanded", "true");
  const toggleBoxesVisibility = () => {
    boxesVisible = !boxesVisible;
    boxesWrap.style.display = boxesVisible ? "" : "none";
    mainBlock.classList.toggle("open", boxesVisible);
    mainBlock.setAttr("aria-expanded", String(boxesVisible));
    // Do not mutate arrow glyph; CSS rotates .z5-linter-head-arrow when .open is present.
  };
  mainBlock.addEventListener("click", toggleBoxesVisibility);
  mainBlock.addEventListener("keydown", (ev: KeyboardEvent) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      toggleBoxesVisibility();
    }
  });

  // Utility: resolve a lint entry's file path to a TFile in the vault
  function resolveEntryFile(entryPath: string): TFile | null {
    if (!entryPath) return null;
    let p = entryPath;
    if (p.startsWith("file://")) {
      try { p = decodeURI(p.replace(/^file:\/+/, "")); } catch { p = p.replace(/^file:\/+/, ""); }
    }
    let af = plugin.app.vault.getAbstractFileByPath(p);
    if (af instanceof TFile) return af;
    try {
      const dec = decodeURI(p);
      af = plugin.app.vault.getAbstractFileByPath(dec);
      if (af instanceof TFile) return af;
    } catch { /* ignore */ }
    const alt = p.endsWith(".md") ? p : `${p}.md`;
    af = plugin.app.vault.getAbstractFileByPath(alt);
    if (af instanceof TFile) return af;
    const base = p.split("/").pop() ?? p;
    const files = plugin.app.vault.getFiles();
    const match = files.find(f => f.path.endsWith(base) || f.name === base);
    if (match) return match;
    return null;
  }

  // Build file summaries from results (fallback if JSON lacks fileSummaries)
  function buildFileSummaries(results: any[]): FileSummary[] {
    const map = new Map<string, FileSummary>();
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const filePath = r.file ?? r.path ?? r.filename ?? "unknown";
      let s = map.get(filePath);
      if (!s) {
        s = { path: filePath, errors: 0, warnings: 0, info: 0, total: 0, highest: "info", firstIndex: i };
        map.set(filePath, s);
      }
      const sev = (r.severity || "info").toLowerCase();
      if (sev === "error") s.errors += 1;
      else if (sev === "warning") s.warnings += 1;
      else s.info += 1;
      s.total += 1;
      if (s.highest !== "error") {
        if (sev === "error") s.highest = "error";
        else if (sev === "warning" && s.highest === "info") s.highest = "warning";
      }
      if (i < s.firstIndex) s.firstIndex = i;
    }
    return Array.from(map.values());
  }

  // Comparator: highest severity first, then total desc, then firstIndex asc
  function fileComparator(a: FileSummary, b: FileSummary) {
    const rank = (h: FileSummary["highest"]) => (h === "error" ? 3 : h === "warning" ? 2 : 1);
    const ra = rank(a.highest), rb = rank(b.highest);
    if (ra !== rb) return rb - ra;
    if (a.total !== b.total) return b.total - a.total;
    return a.firstIndex - b.firstIndex;
  }

  // Top-message map: filePath -> { error?: string, warning?: string, info?: string }
  let topMessagesMap: Record<string, { error?: string; warning?: string; info?: string }> = {};

  // Build top message map from results: first-seen message per severity per file
  function buildTopMessagesMap(results: any[]) {
    const map: Record<string, { error?: string; warning?: string; info?: string }> = {};
    if (!Array.isArray(results)) return map;
    for (const r of results) {
      const filePath = r.file ?? r.path ?? r.filename ?? "unknown";
      const sev = (r.severity || "info").toLowerCase();
      const msg = (r.message || r.rule || "").toString();
      if (!map[filePath]) map[filePath] = {};
      if (sev === "error" && !map[filePath].error && msg) map[filePath].error = msg;
      else if (sev === "warning" && !map[filePath].warning && msg) map[filePath].warning = msg;
      else if (sev === "info" && !map[filePath].info && msg) map[filePath].info = msg;
      // stop early if all three present
      const m = map[filePath];
      if (m.error && m.warning && m.info) continue;
    }
    return map;
  }

  // Render combined top files list (top N) — filename link + chips + open button
  function renderCombinedTopFiles(summaries: FileSummary[]) {
    combinedList.innerHTML = "";

    // sort and take top N
    summaries.sort(fileComparator);
    const toShow = summaries.slice(0, TOP_FILES_COUNT);

    for (const s of toShow) {
      // Card container (role=listitem)
      const card = document.createElement("div");
      card.className = `z5-vault-file-card z5-linter-result ${s.highest === "error" ? "z5-linter-error" : s.highest === "warning" ? "z5-linter-warning" : "z5-linter-info"}`;
      card.setAttribute("role", "listitem");
      card.tabIndex = 0;

      // Set full path as tooltip on the whole card
      card.title = s.path || "";

      // Helper to open the file for this card
      const openFile = async () => {
        try {
          const tfile = resolveEntryFile(s.path);
          if (tfile instanceof TFile) {
            const leaf = plugin.app.workspace.getLeaf(false);
            await leaf.openFile(tfile);
          } else {
            new Notice("File not found in vault: " + s.path);
          }
        } catch (e) {
          console.error("Failed to open file", s.path, e);
          new Notice("Failed to open file: " + s.path);
        }
      };

      // Make the whole card clickable (including chips)
      card.addEventListener("click", () => openFile());
      // Keyboard activation (Enter / Space)
      card.addEventListener("keydown", (ev: KeyboardEvent) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          openFile();
        }
      });

      // Left column: use single-file class names so spacing matches exactly
      const left = document.createElement("div");
      left.className = "z5-linter-file-left";

      // Filename text (basename without .md). No tooltip here — card has the tooltip.
      const base = (s.path || "").split("/").pop() || s.path || "";
      const filename = base.replace(/\.md$/i, "");
      const fileNameSpan = document.createElement("span");
      fileNameSpan.className = "z5-linter-file-path";
      fileNameSpan.textContent = filename;
      // remove pointer cursor and title so it doesn't look like a link
      fileNameSpan.style.cursor = "inherit";
      fileNameSpan.removeAttribute("title");


      left.appendChild(fileNameSpan);

      // Right column: chips (top-right)
      const right = document.createElement("div");
      right.className = "z5-linter-file-right";

      // Create a helper to build a chip with icon + count and tooltip (top message)
      const makeSeverityChip = (sevKey: "error" | "warning" | "info", count: number) => {
        const wrap = document.createElement("div");
        wrap.className = `z5-ls ${sevKey === "error" ? "err" : sevKey === "warning" ? "warn" : "info"}`;

        // count
        const countSpan = document.createElement("span");
        countSpan.className = "z5-ls-count";
        countSpan.textContent = String(count);

        // icon
        const iconSpan = document.createElement("span");
        iconSpan.className = "z5-ls-icon";
        try {
          const iconName = sevKey === "error" ? "octagon-x" : sevKey === "warning" ? "triangle-alert" : "info";
          setIcon(iconSpan, iconName);
        } catch {
          iconSpan.textContent = sevKey === "error" ? "!" : sevKey === "warning" ? "!" : "i";
        }

        // Tooltip: top message for this file+severity (if available)
        const topMsg = topMessagesMap[s.path]?.[sevKey];
        if (topMsg) {
          const firstLine = String(topMsg).split(/\r?\n/)[0] ?? "";
          wrap.title = firstLine.length > 200 ? firstLine.slice(0, 197) + "…" : firstLine;
        } else {
          wrap.title = "";
        }

        // Ensure chip clicks bubble to the card (do not stopPropagation)
        wrap.style.cursor = "pointer";

        wrap.appendChild(countSpan);
        wrap.appendChild(iconSpan);
        return wrap;
      };

      const eChip = makeSeverityChip("error", s.errors);
      const wChip = makeSeverityChip("warning", s.warnings);
      const iChip = makeSeverityChip("info", s.info);

      const chips = document.createElement("div");
      chips.className = "z5-vault-file-chips";
      chips.appendChild(eChip);
      chips.appendChild(wChip);
      chips.appendChild(iChip);

      // Assemble right column (chips only; open button removed)
      right.appendChild(chips);

      // Assemble card
      card.appendChild(left);
      card.appendChild(right);

      combinedList.appendChild(card);
    }
  }



  // Read report content and produce FileSummary[] (prefer fileSummaries)
  function summariesFromReportContent(content: any): FileSummary[] {
    const summaries: FileSummary[] = [];
    if (content?.fileSummaries && typeof content.fileSummaries === "object") {
      for (const [path, v] of Object.entries(content.fileSummaries)) {
        const obj = v as any;
        const errors = Number(obj.errors || 0);
        const warnings = Number(obj.warnings || 0);
        const info = Number(obj.info || 0);
        const firstIndex = Number(obj.firstIndex ?? Number.MAX_SAFE_INTEGER);
        const highest = errors > 0 ? "error" : warnings > 0 ? "warning" : "info";
        summaries.push({ path, errors, warnings, info, total: errors + warnings + info, highest, firstIndex });
      }
    } else if (Array.isArray(content?.results)) {
      return buildFileSummaries(content.results);
    }
    return summaries;
  }

  // Load latest report and render header counts + combined list
  async function loadLatestAndRender() {
    const vl = ensureVaultLinter();
    const rep = typeof vl.getLatestReport === "function" ? await vl.getLatestReport() : null;
    if (!rep) {
      // clear header counts and list
      const mainCount = mainBlock.querySelector<HTMLElement>(".z5-linter-head-count");
      if (mainCount) mainCount.textContent = "0";
      const errCountEl = blocks.error.querySelector<HTMLElement>(".z5-linter-head-count");
      const warnCountEl = blocks.warning.querySelector<HTMLElement>(".z5-linter-head-count");
      const infoCountEl = blocks.info.querySelector<HTMLElement>(".z5-linter-head-count");
      if (errCountEl) errCountEl.textContent = "0";
      if (warnCountEl) warnCountEl.textContent = "0";
      if (infoCountEl) infoCountEl.textContent = "0";
      combinedList.innerHTML = "";
      topMessagesMap = {};
      new Notice("No reports found in " + (plugin.settings.reportsFolder || "reports/linter"));
      return;
    }

    const content = rep.content ?? {};
    // Build topMessagesMap from results (if present)
    const results = Array.isArray(content.results) ? content.results : [];
    topMessagesMap = buildTopMessagesMap(results);

    // header counts
    const summaries = summariesFromReportContent(content);
    // update header counts
    const totalFiles = summaries.length;
    const totalErrors = summaries.reduce((acc, s) => acc + s.errors, 0);
    const totalWarnings = summaries.reduce((acc, s) => acc + s.warnings, 0);
    const totalInfo = summaries.reduce((acc, s) => acc + s.info, 0);

    const mainCount = mainBlock.querySelector<HTMLElement>(".z5-linter-head-count");
    if (mainCount) mainCount.textContent = String(totalFiles);
    const errCountEl = blocks.error.querySelector<HTMLElement>(".z5-linter-head-count");
    const warnCountEl = blocks.warning.querySelector<HTMLElement>(".z5-linter-head-count");
    const infoCountEl = blocks.info.querySelector<HTMLElement>(".z5-linter-head-count");
    if (errCountEl) errCountEl.textContent = String(totalErrors);
    if (warnCountEl) warnCountEl.textContent = String(totalWarnings);
    if (infoCountEl) infoCountEl.textContent = String(totalInfo);

    // render combined top files
    renderCombinedTopFiles(summaries);
  }

  // Run vault lint and render header + combined list
  runBtn.addEventListener("click", async () => {
    const vl = ensureVaultLinter();
    const ac = new AbortController();
    runBtn.setAttribute("disabled", "true");

    progressWrap.innerHTML = "";
    const progressEl = progressWrap.createDiv("z5-vault-lint-progress");
    progressEl.textContent = "Starting…";
    const cancelBtn = progressWrap.createEl("button", { text: "Cancel" });
    cancelBtn.style.marginLeft = "8px";
    cancelBtn.addEventListener("click", () => ac.abort());

    try {
      await vl.runVaultLintAndSave({
        onProgress: ({ processed, total, currentFile }) => {
          progressEl.textContent = total
            ? `Processed ${processed}/${total}: ${currentFile ?? ""}`
            : `Processed ${processed}: ${currentFile ?? ""}`;
        },
        signal: ac.signal
      });

      // read saved JSON and render
      await loadLatestAndRender();
      new Notice("Vault lint complete");
    } catch (err) {
      if ((err as any)?.name === "AbortError") new Notice("Vault lint cancelled");
      else {
        console.error("Vault lint failed", err);
        new Notice("Vault lint failed (see console)");
      }
    } finally {
      runBtn.removeAttribute("disabled");
      progressWrap.innerHTML = "";
    }
  });

  // Load latest button
  loadBtn.addEventListener("click", async () => {
    await loadLatestAndRender();
  });

  // Open latest results button
  openLatestBtn.addEventListener("click", async () => {
    const vl = ensureVaultLinter();
    const rep = typeof vl.getLatestReport === "function" ? await vl.getLatestReport() : null;
    if (!rep) {
      new Notice("No reports found in " + (plugin.settings.reportsFolder || "reports/linter"));
      return;
    }
    const path = rep.path || "";
    const tryPaths = [path];
    if (path.endsWith(".json")) tryPaths.unshift(path.replace(/\.json$/i, ".md"));
    if (!path.endsWith(".md")) tryPaths.push(path + ".md");

    let opened = false;
    for (const p of tryPaths) {
      const af = plugin.app.vault.getAbstractFileByPath(p);
      if (af instanceof TFile) {
        const leaf = plugin.app.workspace.getLeaf(false);
        await leaf.openFile(af);
        opened = true;
        break;
      }
    }
    if (!opened) new Notice("Could not open latest report file: " + path);
  });

  // Append boxesWrap to container
  container.appendChild(boxesWrap);

  // Initial populate if a report exists
  (async () => {
    await loadLatestAndRender();
  })();
}
