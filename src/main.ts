import { App, Notice, Plugin, WorkspaceLeaf, TFile } from "obsidian";
import { DEFAULT_SETTINGS, z5LinterSettings, z5LinterSettingsTab } from "./settings";
import { Z5LinterEngine, LintResult } from "./linter";
import { LinterSidebarView } from "./sidebar";
import { refreshActiveFileFromEngine } from "./sidebar_single_file";
import { initVaultUI } from "./sidebar_vault";
//import { createStatusBar as createStatusBarUI, updateStatusBarCounts as updateStatusBarUI, removeStatusBar as removeStatusBarUI } from "./status_bar";
import { createStatusBar, updateStatusBarCounts, removeStatusBar } from "./status_bar";
import { VaultLinter } from "./vault_linter";
// test for canvas creation and migration
import { registerCanvasCommands } from "./canvas_wrapper";
// registerRunTestMigrationCommandUpdated.ts

import { v4 as uuidv4 } from "uuid";


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


    registerCanvasCommands(this.app, this);
    registerRunTestMigrationCommand(this.app, this)


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














/* -------------------- Small regex helpers -------------------- */

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Extract the content under a heading (exact match). Returns trimmed content or null. */
function extractHeadingContent(noteText: string, heading: string): string | null {
  const esc = escapeRegExp(heading);
  const re = new RegExp(`(^|\\n)(#{1,6})\\s+${esc}\\s*\\n([\\s\\S]*?)(?=\\n#{1,6}\\s|$)`, "i");
  const m = noteText.match(re);
  if (!m) return null;
  return m[3].replace(/^\n+|\n+$/g, "");
}

/** Replace the content under a heading in targetText (preserve heading line). If heading missing, append heading+content. */
function replaceHeadingContent(targetText: string, heading: string, newContent: string): string {
  const esc = escapeRegExp(heading);
  const re = new RegExp(`(^|\\n)(#{1,6})\\s+${esc}\\s*\\n([\\s\\S]*?)(?=\\n#{1,6}\\s|$)`, "i");
  if (re.test(targetText)) {
    return targetText.replace(re, (full, prefix, hashes) => `${prefix}${hashes} ${heading}\n${newContent}`);
  } else {
    const sep = targetText.endsWith("\n") ? "" : "\n";
    return `${targetText}${sep}\n## ${heading}\n${newContent}`;
  }
}

/** Remove a heading and its content entirely from the note. */
function removeHeading(noteText: string, heading: string): string {
  const esc = escapeRegExp(heading);
  const re = new RegExp(`(^|\\n)#{1,6}\\s+${esc}\\s*\\n[\\s\\S]*?(?=\\n#{1,6}\\s|$)`, "i");
  const cleaned = noteText.replace(re, "\n");
  return cleaned.replace(/\n{3,}/g, "\n\n").trimStart();
}

/** Return an ordered list of headings present in the note (heading text only). */
function listHeadings(noteText: string): string[] {
  const lines = noteText.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    const m = line.match(/^#{1,6}\s+(.*)/);
    if (m) out.push(m[1].trim());
  }
  return out;
}

/* -------------------- Migration logic helpers -------------------- */

/**
 * Determine rogue headings in a doc:
 * - headings present in docHeadings but NOT present in templateV1Headings.
 */
function findRogueHeadings(docHeadings: string[], templateV1Headings: string[]) {
  const setV1 = new Set(templateV1Headings.map(h => h.toLowerCase()));
  return docHeadings.filter(h => !setV1.has(h.toLowerCase()));
}

/**
 * Build quick lookup of which v2 headings are targeted by explicit mappings.
 * mappings: array of { fromFile, fromHeading, toFile, toHeading }
 */
function buildTargetedV2Set(mappings: { fromFile: string; fromHeading: string; toFile: string; toHeading: string }[]) {
  const set = new Set<string>();
  for (const m of mappings) {
    set.add(m.toHeading.toLowerCase());
  }
  return set;
}

/* -------------------- Updated test migration command -------------------- */

export function registerRunTestMigrationCommand(app: App, plugin: Plugin) {
  plugin.addCommand({
    id: "z5-run-test-migration-updated",
    name: "z5Linter: Run test migration (updated rules, debug)",
    callback: async () => {
      try {
        const vault = app.vault;

        const canvasPath = "testMigrationData/migration.canvas";
        const migratedFolder = "testMigrationData/migrated notes";
        const templateV1Path = "testMigrationData/templates/template_project_v1.md";
        const templateV2Path = "testMigrationData/templates/template_project_v2.md";

        // Ensure migrated folder exists
        try {
          const list = await vault.adapter.list(migratedFolder).catch(() => null);
          if (!list) await vault.create(`${migratedFolder}/.keep`, "migrated notes folder");
        } catch (e) {
          console.warn("[z5Linter] ensure migrated folder failed:", e);
        }

        console.log("[z5Linter] Loading canvas:", canvasPath);
        const rawCanvas = await vault.adapter.read(canvasPath);
        const canvasJson = JSON.parse(rawCanvas);

        // Build node map
        const nodeById = new Map<string, any>();
        for (const n of canvasJson.nodes || []) if (n && n.id) nodeById.set(n.id, n);
        console.log("[z5Linter] Nodes loaded:", nodeById.size);

        // Build mappings array (fromFile/fromHeading -> toFile/toHeading)
        const mappings: { fromFile: string; fromHeading: string; toFile: string; toHeading: string }[] = [];
        for (const e of canvasJson.edges || []) {
          if (!e || !e.fromNode || !e.toNode) continue;
          const fromNode = nodeById.get(e.fromNode);
          const toNode = nodeById.get(e.toNode);
          if (!fromNode || !toNode) {
            console.log("[z5Linter] Ignoring edge (missing node):", e.id);
            continue;
          }
          const fromFile = String(fromNode.metadata?.sourceFile || "").trim();
          const fromHeading = String(fromNode.metadata?.originalHeading || "").trim();
          const toFile = String(toNode.metadata?.sourceFile || "").trim();
          const toHeading = String(toNode.metadata?.originalHeading || "").trim();
          if (fromFile && fromHeading && toFile && toHeading) {
            mappings.push({ fromFile, fromHeading, toFile, toHeading });
            console.log("[z5Linter] Mapping discovered:", { fromFile, fromHeading, toFile, toHeading });
          } else {
            console.log("[z5Linter] Edge ignored (missing metadata):", e.id);
          }
        }

        if (!mappings.length) {
          new Notice("No mappings found in canvas; nothing to do.");
          return;
        }

        // Load templates and list their headings
        let templateV1Text = "";
        let templateV2Text = "";
        try { templateV1Text = await vault.adapter.read(templateV1Path); } catch (e) { console.warn("[z5Linter] v1 template missing:", e); }
        try { templateV2Text = await vault.adapter.read(templateV2Path); } catch (e) { console.warn("[z5Linter] v2 template missing:", e); }

        const templateV1Headings = templateV1Text ? listHeadings(templateV1Text) : [];
        const templateV2Headings = templateV2Text ? listHeadings(templateV2Text) : [];
        console.log("[z5Linter] templateV1Headings:", templateV1Headings);
        console.log("[z5Linter] templateV2Headings:", templateV2Headings);

        // Extract template_version from v2 template frontmatter (if present)
        let targetTemplateVersion: string | null = null;
        if (templateV2Text) {
          const fmMatch = templateV2Text.match(/^---\s*[\r\n]+([\s\S]*?)\r?\n---\s*/);
          if (fmMatch) {
            const fmText = fmMatch[1];
            const m = fmText.match(/template_version\s*:\s*["']?([^"\n']+)["']?/i);
            if (m) targetTemplateVersion = m[1].trim();
          }
          console.log("[z5Linter] targetTemplateVersion:", targetTemplateVersion);
        }

        // Test notes to migrate
        const testNotes = [
          "testMigrationData/notes/project-alpha.md",
          "testMigrationData/notes/project-beta.md",
        ];

        // Build set of v2 headings that are explicitly targeted by mappings
        const targetedV2Set = buildTargetedV2Set(mappings);

        // For each test note: build migratedText from templateV2Text (or original if missing),
        // apply explicit mappings, then handle rogue headings according to rules.
        for (const notePath of testNotes) {
          console.log("[z5Linter] Processing note:", notePath);
          if (!(await vault.adapter.exists(notePath))) {
            console.warn("[z5Linter] Note missing:", notePath);
            continue;
          }
          const originalText = await vault.adapter.read(notePath);
          console.log("[z5Linter] Original length:", originalText.length);

          // Start migratedText from templateV2Text if available, otherwise start from original
          let migratedText = templateV2Text ? templateV2Text : originalText;
          console.log("[z5Linter] Starting migratedText length:", migratedText.length);

          // Determine relevant explicit mappings for this migration (v1->v2)
          const relevant = mappings.filter(m => m.fromFile.endsWith("template_project_v1.md") && m.toFile.endsWith("template_project_v2.md"));
          console.log("[z5Linter] Relevant explicit mappings count:", relevant.length);

          // 1) Apply explicit mappings (replace v2 heading with source content)
          const appliedTargets = new Set<string>(); // track which v2 headings we replaced
          for (const m of relevant) {
            console.log("[z5Linter] Applying explicit mapping:", m.fromHeading, "->", m.toHeading);
            const srcContent = extractHeadingContent(originalText, m.fromHeading);
            console.log(`[z5Linter] Extracted "${m.fromHeading}" length:`, srcContent ? srcContent.length : null);
            if (srcContent === null) {
              console.log(`[z5Linter] Source heading "${m.fromHeading}" not found in ${notePath}; skipping replacement for ${m.toHeading}`);
              continue;
            }
            migratedText = replaceHeadingContent(migratedText, m.toHeading, srcContent);
            appliedTargets.add(m.toHeading.toLowerCase());
            console.log(`[z5Linter] After replace "${m.toHeading}" migrated length:`, migratedText.length);
          }

          // 2) Handle rogue headings: headings present in doc but not in templateV1
          const docHeadings = listHeadings(originalText);
          const rogueHeadings = findRogueHeadings(docHeadings, templateV1Headings);
          console.log("[z5Linter] Rogue headings found in doc:", rogueHeadings);

          // We'll collect impossible migrations to append at bottom if needed
          const impossibleBlocks: { heading: string; content: string }[] = [];

          for (const rogue of rogueHeadings) {
            const content = extractHeadingContent(originalText, rogue);
            if (content === null) {
              console.log(`[z5Linter] Rogue heading "${rogue}" had no content; skipping.`);
              continue;
            }

            const existsInV2 = templateV2Headings.some(h => h.toLowerCase() === rogue.toLowerCase());
            const v2HeadingCanonical = templateV2Headings.find(h => h.toLowerCase() === rogue.toLowerCase()) || rogue;

            if (!existsInV2) {
              // Not in v2: append at end (forwarding work)
              console.log(`[z5Linter] Rogue heading "${rogue}" not in v2; appending at end.`);
              migratedText = replaceHeadingContent(migratedText, rogue, content);
              continue;
            }

            // If v2 heading exists and is NOT targeted by any explicit mapping, treat as implicit mapping: overwrite v2 heading
            const v2Lower = v2HeadingCanonical.toLowerCase();
            const isTargeted = targetedV2Set.has(v2Lower) || appliedTargets.has(v2Lower);

            if (!isTargeted) {
              console.log(`[z5Linter] Rogue heading "${rogue}" exists in v2 and is not targeted; implicit overwrite of "${v2HeadingCanonical}".`);
              migratedText = replaceHeadingContent(migratedText, v2HeadingCanonical, content);
              appliedTargets.add(v2Lower);
              continue;
            }

            // If v2 heading is already targeted by some other mapping, we cannot safely merge.
            // Create an "Impossible migration" block at the bottom with a subheading for the rogue heading.
            console.log(`[z5Linter] Rogue heading "${rogue}" conflicts with an existing mapping to "${v2HeadingCanonical}". Adding to Impossible migration block.`);
            impossibleBlocks.push({ heading: rogue, content });
          }

          // 3) Append impossible migration block if any
          if (impossibleBlocks.length > 0) {
            const lines: string[] = [];
            lines.push("## Impossible migrations");
            for (const b of impossibleBlocks) {
              lines.push(`### ${b.heading}`);
              lines.push(b.content);
            }
            const blockText = lines.join("\n\n");
            // append to migratedText
            migratedText = migratedText.endsWith("\n") ? `${migratedText}\n\n${blockText}` : `${migratedText}\n\n${blockText}`;
            console.log("[z5Linter] Appended Impossible migrations block.");
          }

          // 4) Update frontmatter template_version to v2 if available
          if (targetTemplateVersion) {
            migratedText = (function updateFrontmatterField(noteText: string, key: string, value: string) {
              const fmMatch = noteText.match(/^---\s*[\r\n]+([\s\S]*?)\r?\n---\s*/);
              if (!fmMatch) {
                return `---\n${key}: "${value}"\n---\n\n${noteText}`;
              }
              const fmText = fmMatch[1];
              const fmStart = fmMatch.index || 0;
              const fmEnd = fmStart + fmMatch[0].length;
              const lines = fmText.split(/\r?\n/);
              let found = false;
              for (let i = 0; i < lines.length; i++) {
                const m = lines[i].match(new RegExp(`^\\s*${key}\\s*:\\s*(.*)$`, "i"));
                if (m) {
                  lines[i] = `${key}: "${value}"`;
                  found = true;
                  break;
                }
              }
              if (!found) lines.push(`${key}: "${value}"`);
              const newFm = `---\n${lines.join("\n")}\n---\n`;
              return newFm + noteText.slice(fmEnd);
            })(migratedText, "template_version", targetTemplateVersion);
            console.log("[z5Linter] Updated template_version to", targetTemplateVersion);
          }

          // Final preview log (trim)
          console.log(`[z5Linter] Final migrated preview for ${notePath}:\n`, migratedText.slice(0, 3000));

          // Write migrated file
          const parts = notePath.split("/");
          const filename = parts[parts.length - 1];
          const outPath = `${migratedFolder}/${filename}`;
          const outExists = await vault.adapter.exists(outPath);
          let finalOutPath = outPath;
          if (outExists) {
            const ts = Date.now();
            finalOutPath = `${migratedFolder}/${filename.replace(/\.md$/i, "")}.migrated.${ts}.md`;
          }
          const fileObj = await vault.getAbstractFileByPath(finalOutPath);
          if (fileObj) {
            await vault.modify(fileObj as any, migratedText);
          } else {
            await vault.create(finalOutPath, migratedText);
          }
          new Notice(`Migrated copy written: ${finalOutPath}`);
          console.log("[z5Linter] Wrote migrated copy:", finalOutPath);
        }

        new Notice("Test migration (updated rules) complete.");
      } catch (err) {
        console.error("Test migration failed:", err);
        new Notice("Test migration failed — see console for details.");
      }
    },
  });
}