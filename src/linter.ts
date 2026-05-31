import { App, TFile, MarkdownView, Notice } from "obsidian";
import jsyaml from "js-yaml";
import type z5Linter from "./main"; // adjust import to your main plugin class path
import type { z5LinterSettings } from "./settings";

/**
 * Minimal linting engine for z5-linter.
 * - Loads schema YAML from the configured file+heading
 * - Parses fenced YAML block
 * - Validates active file frontmatter against a small subset of rules:
 *   - required fields
 *   - enum membership
 *   - regex match for date_format and tag_namespace_regex
 *
 * This is intentionally small and easy to extend.
 */

export type LintSeverity = "error" | "warning" | "info";

export interface LintResult {
  /** short id for the rule */
  rule: string;
  /** human readable message */
  message: string;
  /** severity */
  severity: LintSeverity;
  /** optional field name the issue refers to */
  field?: string;
  /** optional location hint (line number) */
  line?: number;
  /** optional file path for vault-wide reports */
  file?: string;
}


type SchemaYaml = {
  meta?: Record<string, any>;
  global?: {
    date_format?: string;
    tag_namespace_regex?: string;
    enforce_tag_namespace?: boolean;
    fields?: Record<string, any>;
  };
  conditional_fields?: Record<string, any>;
};

/** Small helper: parse frontmatter from a markdown file (YAML between --- markers). */
function extractFrontmatter(md: string): string | null {
  const m = md.match(/^---\s*[\r\n]+([\s\S]*?)\r?\n---\s*[\r\n]*/);
  if (m && m[1]) return m[1].trim();
  return null;
}

/** Parse YAML text to object using js-yaml, returns null on parse error. */
function safeLoadYaml<T = any>(yamlText: string): T | null {
  try {
    return jsyaml.load(yamlText) as T;
  } catch (e) {
    console.error("z5Linter: YAML parse error", e);
    return null;
  }
}

/** Basic check helpers */
function isEnumValid(value: any, options: any[]): boolean {
  if (value === undefined || value === null) return false;
  return options.includes(value);
}

function matchesRegex(value: string, pattern: string): boolean {
  try {
    const re = new RegExp(pattern);
    return re.test(value);
  } catch (e) {
    // invalid regex in schema -> treat as not matching
    return false;
  }
}

/** Main engine class */
export class Z5LinterEngine {
  plugin: z5Linter;
  app: App;
  settings: z5LinterSettings;

  /** Last valid markdown file we used for linting (sticky) */
  private lastActiveFile: TFile | null = null;

  /** Public: set the active file explicitly (e.g., when user opens a file) */
  public setActiveFile(file: TFile | null) {
    this.lastActiveFile = file;
  }

  /** Public: get the sticky active file (returns last valid file if current active is invalid) */
  public getStickyActiveFile(): TFile | null {
    return this.lastActiveFile;
  }


  private lastSchema: SchemaYaml | null = null;
  private lastSchemaRaw: string | null = null;
  private results: LintResult[] = [];
  private debounceTimer: number | null = null;

  constructor(plugin: z5Linter) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.settings = plugin.settings;
  }

  /**
   * Lint a single markdown file and return results.
   * Accepts a TFile or a path string.
   */
  public async lintFile(fileOrPath: TFile | string): Promise<LintResult[]> {
    // Resolve file
    let file: TFile | null = null;
    if (typeof fileOrPath === "string") {
      const af = this.app.vault.getAbstractFileByPath(fileOrPath);
      if (!af || !(af instanceof TFile)) return [];
      file = af;
    } else {
      file = fileOrPath;
    }

    if (!file) return [];

    // Load schema
    const schema = await this.loadSchemaFromSettings();
    if (!schema) {
      return [{
        rule: "no-schema",
        message: "Schema YAML could not be loaded or parsed from settings.",
        severity: "warning",
        file: file.path
      }];
    }

    // Read file
    let content: string;
    try {
      content = await this.app.vault.read(file);
    } catch {
      return [{
        rule: "read-failed",
        message: `Failed to read file ${file.path}.`,
        severity: "error",
        file: file.path
      }];
    }

    // Extract frontmatter
    const fmText = extractFrontmatter(content);
    if (!fmText) {
      return [{
        rule: "no-frontmatter",
        message: "No YAML frontmatter found.",
        severity: "error",
        file: file.path
      }];
    }

    const frontmatter = safeLoadYaml<Record<string, any>>(fmText);
    if (frontmatter === null) {
      return [{
        rule: "frontmatter-parse-error",
        message: "Failed to parse frontmatter YAML.",
        severity: "error",
        file: file.path
      }];
    }

    // Validate
    return this.validateFrontmatter(frontmatter, schema)
      .map(r => ({ ...r, file: file.path }));
  }


  /** Public: run lint for the currently active file and update internal results */
  public async runLintForActiveFile(): Promise<LintResult[]> {
    const file = this.getActiveMarkdownFile();
    if (!file) {
      return [{
        rule: "no-active-file",
        message: "No active markdown file to lint.",
        severity: "info"
      }];
    }

    const results = await this.lintFile(file);
    this.results = results;
    return results;
  }


  /** Render the latest results into a container element (clears container) */
  renderLintResults(container: HTMLElement) {
    container.empty();
    container.createEl("h4", { text: "z5 Linter — Results" });

    if (!this.results || this.results.length === 0) {
      container.createEl("div", { text: "No issues found." });
      return;
    }

    const ul = container.createEl("ul", { cls: "z5-linter-results" });
    for (const r of this.results) {
      const li = ul.createEl("li", { cls: `z5-linter-${r.severity}` });
      const title = `${r.severity.toUpperCase()}: ${r.message}`;
      li.createEl("div", { text: title });
      if (r.field) li.createEl("div", { text: `Field: ${r.field}`, cls: "z5-linter-field" });
      if (r.rule) li.createEl("div", { text: `Rule: ${r.rule}`, cls: "z5-linter-rule" });
    }
  }

  /** Debounced public hook for external events (file save, modify) */
  onVaultChange(delay = 200) {
    // If lastActiveFile was deleted, clear it so we don't keep a stale reference.
    const last = this.lastActiveFile;
    if (last) {
      const af = this.app.vault.getAbstractFileByPath(last.path);
      if (!af || !(af instanceof TFile)) {
        this.lastActiveFile = null;
      }
    }

    if (this.debounceTimer) window.clearTimeout(this.debounceTimer);
    this.debounceTimer = window.setTimeout(async () => {
      this.debounceTimer = null;
      await this.runLintForActiveFile();
      // optionally notify or refresh UI via plugin (plugin should call render)
    }, delay);
  }

  /** Called when active leaf changes */
  async onActiveLeafChange() {
    // Wait 2 frames so Obsidian can finish switching views
    await new Promise(r => setTimeout(r, 30));
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);

    if (view?.file instanceof TFile) {
      this.lastActiveFile = view.file;
      await this.runLintForActiveFile();
      return;
    }

    if (this.lastActiveFile) {
      await this.runLintForActiveFile();
    }
  }


  /**
   * Run lint across the vault with progress callback and cancellation support.
   * opts.onProgress({ processed, total, currentFile })
   * opts.signal is an AbortSignal to cancel the run.
   */
  public async runLintForVaultWithProgress(opts: { onProgress?: (p: { processed: number; total?: number; currentFile?: string }) => void; signal?: AbortSignal } = {}): Promise<LintResult[]> {
    const { onProgress, signal } = opts;
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    const files = this.app.vault.getMarkdownFiles();
    const total = files.length;
    const aggregated: LintResult[] = [];
    let processed = 0;

    for (const f of files) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      try {
        const fileResults = await this.runLintForFile(f);
        if (Array.isArray(fileResults) && fileResults.length) aggregated.push(...fileResults);
      } catch (e) {
        // If a single file fails, record an error result but continue
        aggregated.push({
          rule: "file-lint-failed",
          message: `Lint failed for ${f.path}: ${String(e)}`,
          severity: "error",
          file: f.path
        });
      }
      processed++;
      try { onProgress?.({ processed, total, currentFile: f.path }); } catch (e) { /* ignore progress errors */ }
    }

    return aggregated;
  }



  /** Load schema YAML from the configured file + heading in plugin settings */
  private async loadSchemaFromSettings(): Promise<SchemaYaml | null> {
    const fp = this.settings.schema_doc;
    const heading = this.settings.schema_heading;

    if (!fp) return null;

    const af = this.app.vault.getAbstractFileByPath(fp);
    if (!af || !(af instanceof TFile)) return null;

    let content: string;
    try {
      content = await this.app.vault.read(af);
    } catch (e) {
      console.error("z5Linter: failed to read schema file", e);
      return null;
    }

    // extract section under heading if provided (reuse same logic as main)
    const section = heading ? extractSectionUnderHeading(content, heading) : content;
    if (!section) return null;

    // extract fenced YAML block
    const yamlText = extractFencedYaml(section);
    if (!yamlText) return null;

    // avoid reparsing if identical
    if (this.lastSchemaRaw === yamlText && this.lastSchema) return this.lastSchema;

    const parsed = safeLoadYaml<SchemaYaml>(yamlText);
    if (!parsed) return null;

    this.lastSchemaRaw = yamlText;
    this.lastSchema = parsed;
    return parsed;
  }

  /** Validate frontmatter against a subset of schema rules */
  private validateFrontmatter(front: Record<string, any>, schema: SchemaYaml): LintResult[] {
    const out: LintResult[] = [];

    // 1) required fields from schema.global.fields
    const fields = schema.global?.fields ?? {};
    for (const [fname, fdef] of Object.entries(fields)) {
      const required = (fdef && (fdef as any).required) === true;
      if (required && !(fname in front)) {
        const sev = this.resolveSeverity(fdef, "error"); // default missing required = error
        out.push({
          rule: "required-field",
          message: `Missing required field "${fname}".`,
          severity: sev,
          field: fname
        });
      }
    }

    // 2) enum checks
    for (const [fname, fdef] of Object.entries(fields)) {
      const def = fdef as any;
      if (def && def.field_type === "enum" && (fname in front)) {
        const options = def.enum_options ?? def.enum ?? [];
        if (!isEnumValid(front[fname], options)) {
          const sev = this.resolveSeverity(def, "error"); // enums default to error
          out.push({
            rule: "enum-invalid",
            message: `Field "${fname}" has invalid value "${String(front[fname])}". Expected one of: ${options.join(", ")}`,
            severity: sev,
            field: fname
          });
        }
      }
    }

    // 3) global regex checks (date_format, tag_namespace_regex)
    // Date validation: accept any value that is a valid Date
    const datePattern = schema.global?.date_format;
    const dateReadable = schema.global?.date_format_readable ?? "a valid date";

    if (front.created !== undefined) {
      if (!isValidDateValue(front.created)) {
        const dateDef = (schema.global && schema.global) || {};
        const sev = this.resolveSeverity(dateDef, "warning");
        out.push({
          rule: "date-invalid",
          message: `Field "created" must be ${dateReadable}.`,
          severity: sev,
          field: "created"
        });
      }
    }

    if (front.edited !== undefined) {
      if (!isValidDateValue(front.edited)) {
        const dateDef = (schema.global && schema.global) || {};
        const sev = this.resolveSeverity(dateDef, "warning");
        out.push({
          rule: "date-invalid",
          message: `Field "edited" must be ${dateReadable}.`,
          severity: sev,
          field: "edited"
        });
      }
    }

    if (schema.global?.tag_namespace_regex && front.tags) {
      // if tags is array or string, check each tag
      const tags = Array.isArray(front.tags) ? front.tags : String(front.tags).split(/\s+/);
      for (const t of tags) {
        if (!matchesRegex(String(t), schema.global.tag_namespace_regex)) {
          const sev = this.resolveSeverity(schema.global, "warning");
          out.push({
            rule: "tag-namespace",
            message: `Tag "${t}" does not match tag_namespace_regex ${schema.global.tag_namespace_regex}.`,
            severity: sev,
            field: "tags"
          });
        }
      }
    }

    // 4) conditional fields (simple support)
    if (schema.conditional_fields) {
      for (const [cname, cdef] of Object.entries(schema.conditional_fields)) {
        const def = cdef as any;
        const conditions = def.conditions ?? [];
        for (const cond of conditions) {
          const reqs = cond.requirements ?? [];
          let reqsMet = true;
          for (const r of reqs) {
            const f = r.field;
            const eq = r.equals;
            if (!(f in front) || front[f] !== eq) {
              reqsMet = false;
              break;
            }
          }

          if (reqsMet) {
            // if condition requires the field
            if (cond.required && !(cname in front)) {
              const sev = this.resolveSeverity(cond, "error");
              out.push({
                rule: "conditional-required",
                message: `Field "${cname}" is required when ${JSON.stringify(reqs)}.`,
                severity: sev,
                field: cname
              });
            }

            // enum check for conditional
            if (cond.enum && (cname in front)) {
              if (!isEnumValid(front[cname], cond.enum)) {
                const sev = this.resolveSeverity(cond, "error");
                out.push({
                  rule: "conditional-enum",
                  message: `Field "${cname}" has invalid value "${String(front[cname])}" for condition ${JSON.stringify(reqs)}.`,
                  severity: sev,
                  field: cname
                });
              }
            }

            // message from schema can be surfaced as info (or use cond.severity)
            if (cond.message) {
              const msgSev = this.resolveSeverity(cond, "info");
              out.push({
                rule: "conditional-message",
                message: String(cond.message),
                severity: msgSev,
                field: cname
              });
            }
          }
        }
      }
    }

    // If no issues, return empty array
    return out;
  }

  /** Helper: return the active markdown file if valid; otherwise return the sticky lastActiveFile */
  private getActiveMarkdownFile(): TFile | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);

    if (view?.file instanceof TFile) {
      this.lastActiveFile = view.file;
      return view.file;
    }

    return this.lastActiveFile;
  }



  /** Normalize severity value from schema definition; default fallback if missing/invalid */
  private resolveSeverity(def: any, fallback: "error" | "warning" | "info" = "warning"): "error" | "warning" | "info" {
    if (!def) return fallback;
    const s = (def.severity || def.severity_level || "").toString().toLowerCase();
    if (s === "error" || s === "warning" || s === "info") return s;
    return fallback;
  }
}

/* -------------------------
   Reuse small helpers from main.ts (copied here for independence)
   ------------------------- */

/** Extract ATX heading section (same logic as main.ts) */
function extractSectionUnderHeading(md: string, headingText: string): string | null {
  const lines = md.split(/\r?\n/);
  let startIndex = -1;
  let startLevel = 0;
  const headingRegex = /^(#{1,6})\s+(.*)$/;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(headingRegex);
    if (m) {
      const level = m[1].length;
      const text = m[2].trim();
      if (text === headingText) {
        startIndex = i + 1;
        startLevel = level;
        break;
      }
    }
  }
  if (startIndex === -1) return null;
  const outLines: string[] = [];
  for (let i = startIndex; i < lines.length; i++) {
    const m = lines[i].match(headingRegex);
    if (m) {
      const level = m[1].length;
      if (level <= startLevel) break;
    }
    outLines.push(lines[i]);
  }
  return outLines.join("\n").trim();
}


/** Extract fenced YAML block (```yaml ... ```) */
function extractFencedYaml(section: string): string | null {
  const fencedRegex = /```(?:yaml|yml)\s*([\s\S]*?)```/i;
  const m = section.match(fencedRegex);
  if (m && m[1]) return m[1].trim();
  return null;
}


// Helper: return true if value is a valid Date or a string that parses to a valid Date
function isValidDateValue(value: any): boolean {
  if (value instanceof Date) {
    return !isNaN(value.getTime());
  }
  if (typeof value === "string") {
    const d = new Date(value);
    return !isNaN(d.getTime());
  }
  // numbers (timestamps) are also acceptable if you want
  if (typeof value === "number") {
    const d = new Date(value);
    return !isNaN(d.getTime());
  }
  return false;
}
