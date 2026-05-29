import { App, PluginSettingTab, Setting, TFile, FuzzySuggestModal, Notice, DropdownComponent } from "obsidian";
import z5Linter from "./main";

export interface z5LinterSettings {
  schema_doc: string;
  schema_heading: string;
  show_status_bar: boolean;
  reportsFolder: string;
}

export const DEFAULT_SETTINGS: z5LinterSettings = {
  schema_doc: '',
  schema_heading: '',
  show_status_bar: false,
  reportsFolder: '',
};

import { App, PluginSettingTab, Setting, TFile, FuzzySuggestModal, Notice, DropdownComponent } from "obsidian";
import z5Linter from "./main";

export class z5LinterSettingsTab extends PluginSettingTab {
  plugin: z5Linter;
  private headingDropdown?: DropdownComponent;

  constructor(app: App, plugin: z5Linter) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h3", { text: "z5 Linter settings" });

    // Schema file: text input + "Pick file" button that opens a fuzzy file picker
    new Setting(containerEl)
      .setName("Schema file")
      .setDesc("Path to the markdown file that contains your schema (or pick one).")
      .addText(text => {
        text.setPlaceholder("path/to/schema.md")
          .setValue(this.plugin.settings.schema_doc || "")
          .onChange(async (value) => {
            this.plugin.settings.schema_doc = value.trim();
            await this.plugin.saveSettings();
            await this.populateHeadingsForFile(this.plugin.settings.schema_doc, this.plugin.settings.schema_heading);
          });
      })
      .addButton(btn => {
        btn.setButtonText("Pick file")
          .setCta()
          .onClick(() => {
            const picker = new MarkdownFilePicker(this.app, async (file) => {
              this.plugin.settings.schema_doc = file.path;
              await this.plugin.saveSettings();
              await this.populateHeadingsForFile(file.path, this.plugin.settings.schema_heading);
              this.display();
              new Notice(`Selected ${file.path}`);
            });
            picker.open();
          });
      });

    // Schema heading: dropdown populated from selected file
    new Setting(containerEl)
      .setName("Schema heading")
      .setDesc("Choose the heading inside the selected file that contains the schema.")
      .addDropdown((dropdown) => {
        this.headingDropdown = dropdown;
        this.safeClearDropdown(this.headingDropdown);
        this.headingDropdown.addOption("", "(choose a file first)");
        this.headingDropdown.setValue(this.plugin.settings.schema_heading || "");
        this.headingDropdown.onChange(async (value) => {
          this.plugin.settings.schema_heading = value;
          await this.plugin.saveSettings();
        });
      });

    // Quick actions
    new Setting(containerEl)
      .setName("Actions")
      .setDesc("Helpers for loading/clearing the current selection")
      .addButton(btn => btn
        .setButtonText("Reload headings")
        .setCta()
        .onClick(async () => {
          const fp = this.plugin.settings.schema_doc;
          if (fp) {
            await this.populateHeadingsForFile(fp, this.plugin.settings.schema_heading);
            new Notice("Headings reloaded");
          } else {
            new Notice("No schema file selected");
          }
        }))
      .addButton(btn => btn
        .setButtonText("Clear")
        .onClick(async () => {
          this.plugin.settings.schema_doc = '';
          this.plugin.settings.schema_heading = '';
          await this.plugin.saveSettings();
          this.display();
          new Notice("Schema selection cleared");
        }));

    // Show status bar toggle
    new Setting(containerEl)
      .setName("Show status bar entry")
      .setDesc("Show a small z5 Linter item in Obsidian's status bar. Toggle on to enable.")
      .addToggle(toggle => {
        toggle.setValue(this.plugin.settings.show_status_bar ?? false);
        toggle.onChange(async (value) => {
          this.plugin.settings.show_status_bar = value;
          await this.plugin.saveSettings();
          if (value) {
            this.plugin.createStatusBar();
          } else {
            this.plugin.removeStatusBar();
          }
        });
      });

    // Reports folder setting with robust live validity indicator
    new Setting(containerEl)
      .setName("Reports folder")
      .setDesc("Folder where vault lint reports are saved (relative to vault root). Example: reports/linter")
      .addText(text => {
        text.setPlaceholder("reports/linter")
          .setValue(this.plugin.settings.reportsFolder || "reports/linter")
          .onChange(async (v) => {
            this.plugin.settings.reportsFolder = v.trim();
            await this.plugin.saveSettings();
            // validate on change (debounced inside)
            validateAndUpdateIcon(this.plugin.settings.reportsFolder);
          });

        

        // Access the raw input element
        const inputEl = (text as any).inputEl as HTMLInputElement;

        // Create an inline icon container to the right of the input
        const iconWrap = document.createElement("span");
        iconWrap.className = "z5-reports-validate-icon";
        iconWrap.style.display = "inline-flex";
        iconWrap.style.alignItems = "center";
        iconWrap.style.marginLeft = "8px";
        iconWrap.style.verticalAlign = "middle";
        inputEl.parentElement?.appendChild(iconWrap);

        // Helper to set icon and color
        const setValidationIcon = (valid: boolean) => {
          iconWrap.innerHTML = "";
          try {
            // prefer lucide via setIcon
            // @ts-ignore setIcon exists in Obsidian
            setIcon(iconWrap, valid ? "check" : "x");
          } catch (e) {
            iconWrap.textContent = valid ? "✔" : "✖";
          }
          iconWrap.classList.toggle("z5-reports-valid", valid);
          iconWrap.classList.toggle("z5-reports-invalid", !valid);
          iconWrap.title = valid ? "Folder exists" : "Folder not found";
        };

        // Reliable async validator
        const validatePath = async (rawPath: string): Promise<boolean> => {
          const path = (rawPath || "").trim().replace(/^\/+|\/+$/g, "");
          if (!path) return false;
          const af = this.app.vault.getAbstractFileByPath(path);
          if (!af) return false;
          // If it's a TFile, it's a file not a folder -> invalid
          if (af instanceof TFile) return false;
          // Otherwise treat as folder (TFolder)
          return true;
        };

        // Debounced validator to avoid excessive sync work while typing
        let timer: number | null = null;
        const validateAndUpdateIcon = (path: string) => {
          if (timer) window.clearTimeout(timer);
          timer = window.setTimeout(async () => {
            const ok = await validatePath(path);
            setValidationIcon(ok);
            timer = null;
          }, 150);
        };

        // Validate initially
        validateAndUpdateIcon(this.plugin.settings.reportsFolder || "");

        // Validate on input (live) and on blur (catch paste without change event)
        inputEl.addEventListener("input", () => validateAndUpdateIcon(inputEl.value));
        inputEl.addEventListener("blur", () => validateAndUpdateIcon(inputEl.value));
      });



    // Populate headings for the current saved file on open
    if (this.plugin.settings.schema_doc) {
      this.populateHeadingsForFile(this.plugin.settings.schema_doc, this.plugin.settings.schema_heading);
    }
  }

  private safeClearDropdown(dropdown: DropdownComponent) {
    try {
      if (typeof (dropdown as any).clearOptions === "function") {
        (dropdown as any).clearOptions();
        return;
      }
      const sel = (dropdown as any).selectEl ?? (dropdown as any).select;
      if (sel && sel instanceof HTMLSelectElement) {
        sel.innerHTML = "";
        return;
      }
      const root = (dropdown as any).containerEl ?? (dropdown as any).el;
      if (root && root.querySelector) {
        const select = root.querySelector("select");
        if (select) select.innerHTML = "";
      }
    } catch (e) {
      console.warn("z5Linter: safeClearDropdown fallback triggered", e);
    }
  }

  private async populateHeadingsForFile(filePath: string, preferredHeading?: string) {
    if (!this.headingDropdown) return;

    this.safeClearDropdown(this.headingDropdown);

    if (!filePath) {
      this.headingDropdown.addOption("", "(choose a file first)");
      this.headingDropdown.setValue("");
      return;
    }

    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!file || !(file instanceof TFile)) {
      this.headingDropdown.addOption("", "(file not found)");
      this.headingDropdown.setValue("");
      return;
    }

    this.headingDropdown.addOption("", "(loading...)");
    this.headingDropdown.setValue("");

    try {
      const content = await this.app.vault.read(file);
      const headings = this.extractHeadings(content);

      this.safeClearDropdown(this.headingDropdown);

      if (headings.length === 0) {
        this.headingDropdown.addOption("", "(no headings found)");
        this.headingDropdown.setValue("");
      } else {
        this.headingDropdown.addOption("", "(choose a heading)");
        for (const h of headings) {
          this.headingDropdown.addOption(h, h);
        }

        if (preferredHeading && headings.includes(preferredHeading)) {
          this.headingDropdown.setValue(preferredHeading);
        } else {
          const saved = this.plugin.settings.schema_heading;
          if (saved && headings.includes(saved)) {
            this.headingDropdown.setValue(saved);
          } else {
            this.headingDropdown.setValue("");
          }
        }
      }
    } catch (e) {
      console.error("z5Linter: failed to read file for headings", e);
      this.safeClearDropdown(this.headingDropdown);
      this.headingDropdown.addOption("", "(error reading file)");
      this.headingDropdown.setValue("");
    }
  }

  private extractHeadings(content: string): string[] {
    const headings: string[] = [];
    const atx = content.matchAll(/^#{1,6}\s+(.*)$/gm);
    for (const m of atx) {
      if (m[1]) headings.push(m[1].trim());
    }
    return headings;
  }
}

/** Simple fuzzy file picker modal that returns a markdown file */
class MarkdownFilePicker extends FuzzySuggestModal<TFile> {
  private onChoose: (file: TFile) => void;

  constructor(app: App, onChoose: (file: TFile) => void) {
    super(app);
    this.onChoose = onChoose;
    this.setPlaceholder("Type to filter markdown files...");
  }

  getItems(): TFile[] {
    return this.app.vault.getMarkdownFiles();
  }

  getItemText(item: TFile): string {
    return item.path;
  }

  onChooseItem(item: TFile) {
    this.onChoose(item);
  }
}

