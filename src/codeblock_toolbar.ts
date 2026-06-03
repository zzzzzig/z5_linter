// codeblock_toolbar.ts
import { Plugin, MarkdownPostProcessorContext } from "obsidian";

/**
 * Public API:
 * - call registerCodeblockToolbar(this) from your plugin onload()
 * - window.z5Linter.register(name, fn) to register actions
 * - window.z5Linter.invoke(name, args) to call actions (used by toolbar buttons)
 *
 * The codeblock syntax:
 * ```z5LinterToolbar
 * type: template_migration_block_toolbar
 * template_family: NPC
 * template_version: 1.0.0
 * ```
 */

type ToolbarAction = {
  label: string;
  name: string;
  args?: any;
  secondary?: boolean;
};

type RenderOpts = { debug?: boolean };

declare global {
  interface Window {
    z5Linter?: any;
  }
}

export function registerCodeblockToolbar(plugin: Plugin) {
  ensureInvokerRegistered();

  type MountedEntry = { container: HTMLElement; observer?: MutationObserver; parentObserver?: MutationObserver };
  const mounted = new Map<string, MountedEntry>();

  // Register the markdown codeblock processor
  plugin.registerMarkdownCodeBlockProcessor("z5LinterToolbar", async (source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
    try {
      const opts = parseSimpleYamlLike(source);
      if (!opts || String(opts.type || "").trim() !== "template_migration_block_toolbar") {
        el.createEl("div", { text: "z5LinterToolbar: unsupported block type" });
        return;
      }

      // create container and ensure id
      const containerId = "z5-toolbar-" + Math.random().toString(36).slice(2, 9);
      const container = document.createElement("div");
      container.id = containerId;
      container.classList.add("z5-toolbar-container");
      el.appendChild(container);

      // derive actions for this toolbar
      const family = String(opts.template_family || opts.templateFamily || "").trim();
      const version = String(opts.template_version || opts.templateVersion || "").trim();

      const actions: ToolbarAction[] = [
        // Repair button (first)
        {
          label: "Repair",
          name: "repairMigrationBlock",
          args: { family, version, migrationCanvasPath: "testMigrationData/migration.canvas" }
        },

        // existing actions
        { label: "Preview", name: "previewTemplatePlacement", args: { family, version } },
        { label: "Merge", name: "mergeTemplateToCanvas", args: { templatePath: deriveTemplatePathFor(family, version) } },
        { label: "Open", name: "openTemplateEditor", args: { templatePath: deriveTemplatePathFor(family, version) }, secondary: true },
      ];


      // Prefer plugin-side renderer via window invoker; fallback to local renderer
      if (window.z5Linter && typeof window.z5Linter.invoke === "function") {
        try {
          // Pass the actual container element reference so the invoker can render directly
          await window.z5Linter.invoke("renderToolbar", { container, actions, debug: false });
        } catch (err) {
          // fallback if plugin-side renderer not available or fails
          renderToolbarInto(container, actions, { debug: false });
        }
      } else {
        renderToolbarInto(container, actions, { debug: false });
      }

      // After initial render, observe the DOM so we can re-render if Obsidian replaces the node
      const observer = new MutationObserver(() => {
        // If container was removed and then reinserted, ensure toolbar present
        if (document.body.contains(container)) {
          if (!container.querySelector(".z5-toolbar")) {
            try { renderToolbarInto(container, actions, { debug: false }); } catch (e) { console.error("Failed to re-render toolbar:", e); }
          }
        }
      });

      // Observe the document body for subtree changes so we can detect reattachment
      observer.observe(document.body, { childList: true, subtree: true });

      // Also watch the container's parent for removal (optional)
      let parentObserver: MutationObserver | undefined = undefined;
      const parent = el.parentElement;
      if (parent) {
        parentObserver = new MutationObserver(() => {
          // If container was removed from DOM, try to re-render when it reappears
          if (!document.body.contains(container)) {
            setTimeout(() => {
              // If a replacement container exists, render into it; otherwise render into original if reattached
              const replacement = document.getElementById(container.id);
              const target = replacement ?? (document.body.contains(container) ? container : null);
              if (target) {
                try { renderToolbarInto(target as HTMLElement, actions, { debug: false }); } catch (e) { console.error("Failed to re-render toolbar:", e); }
              }
            }, 50);
          }
        });
        parentObserver.observe(parent, { childList: true });
      }

      // store container + observers for cleanup
      mounted.set(containerId, { container, observer, parentObserver });
    } catch (err) {
      console.error("z5LinterToolbar processor error:", err);
      el.createEl("div", { text: "z5LinterToolbar: failed to render toolbar" });
    }
  });


  // cleanup on unload
  plugin.register(() => {
    for (const [id, el] of mounted) {
      try {
        // if we stored observers, disconnect them
        if (id.endsWith(":observer") || id.endsWith(":parentObserver")) {
          try { (el as MutationObserver).disconnect(); } catch {}
        } else {
          try { (el as HTMLElement).remove(); } catch {}
        }
      } catch {}
    }
    mounted.clear();
  });
}

/* -------------------------
   Window invoker & registry
   ------------------------- */

function ensureInvokerRegistered() {
  if (!window.z5Linter) {
    window.z5Linter = {
      _actions: {} as Record<string, (args?: any) => Promise<any> | any>,
      register(actionName: string, fn: (args?: any) => Promise<any> | any) {
        this._actions[actionName] = fn;
      },
      async invoke(actionName: string, args?: any) {
        const fn = this._actions[actionName];
        if (!fn) throw new Error(`z5Linter: unknown action ${actionName}`);
        // Basic safety: disallow functions in args
        if (args && typeof args === "object") {
          for (const k of Object.keys(args)) {
            if (typeof (args as any)[k] === "function") throw new Error("z5Linter: invalid arg type");
          }
        }
        return await fn(args);
      }
    };
  }
}

/* -------------------------
   Renderer (plugin-side)
   ------------------------- */

/**
 * Render toolbar into an existing container element.
 * Removes stray Dataview dash placeholders before mounting.
 */
export function renderToolbarInto(container: HTMLElement, actions: ToolbarAction[], opts?: RenderOpts) {
  // Ensure container is valid
  if (!container) return;

  // Clear any previous toolbar content so re-rendering is idempotent
  container.innerHTML = "";

  // remove leading whitespace text nodes (no longer necessary after innerHTML clear,
  // but keep for safety if callers append before calling)
  while (container.firstChild && container.firstChild.nodeType === Node.TEXT_NODE && container.firstChild.textContent?.trim() === "") {
    container.removeChild(container.firstChild);
  }

  // remove a leading span that is just a dash or bullet
  const first = container.firstElementChild;
  if (first && first.tagName.toLowerCase() === "span") {
    const txt = (first.textContent || "").trim();
    if (txt === "-" || txt === "•") container.removeChild(first);
  }

  const toolbar = document.createElement("div");
  toolbar.classList.add("z5-toolbar");
  if (opts?.debug) toolbar.classList.add("z5-toolbar--debug");

  for (const a of actions) {
    const btn = document.createElement("button");
    btn.textContent = a.label;
    if (a.secondary) btn.classList.add("z5-btn-secondary");
    btn.setAttribute("aria-label", a.label);

    btn.onclick = async () => {
      btn.disabled = true;
      const startLabel = btn.textContent;
      try {
        if (window.z5Linter && typeof window.z5Linter.invoke === "function") {
          console.info(`[z5Linter] invoking action ${a.name}`, a.args);
          const res = await window.z5Linter.invoke(a.name, a.args || {});
          console.info(`[z5Linter] action ${a.name} result:`, res);

          // Prefer explicit changed flag returned by action
          if (res && (res.changed === true || (res.removed || 0) > 0 || (res.added || 0) > 0 || (res.edgesAdded || 0) > 0)) {
            try { new (window as any).Notice?.(`${startLabel} done`); } catch {}
          }
        } else {
          console.log("z5Linter toolbar action (no invoker):", a);
          try { new (window as any).Notice?.(`${startLabel} done (no invoker)`); } catch {}
        }
      } catch (err) {
        console.error("Toolbar action failed:", err);
        try { new (window as any).Notice?.(`${startLabel} failed: ${String(err)}`); } catch {}
      } finally {
        btn.disabled = false;
      }
    };


    toolbar.appendChild(btn);
  }

  container.appendChild(toolbar);
}


/* -------------------------
   Utilities
   ------------------------- */

/** Very small YAML-like parser for simple key: value blocks (no dependency) */
function parseSimpleYamlLike(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of src.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Za-z0-9_\-]+)\s*:\s*(.+)$/);
    if (m) {
      const key = m[1].trim();
      let val = m[2].trim();
      val = val.replace(/^["']|["']$/g, "");
      out[key] = val;
    }
  }
  return out;
}

/** Example path derivation — replace with your real logic */
function deriveTemplatePathFor(family: string, version?: string) {
  if (!family) return "";
  const v = version ? `_v${version}` : "";
  return `testMigrationData/templates/${family.toLowerCase()}${v}.md`;
}

/* -------------------------
   Example action registrations (stubs)
   ------------------------- */

/**
 * Call this from your plugin onload after registerCodeblockToolbar to register default actions.
 * Replace implementations with your real handlers.
 */
export function registerDefaultToolbarActions() {
  ensureInvokerRegistered();

  window.z5Linter.register("previewTemplatePlacement", async (args: any) => {
    // validate args
    if (!args || !args.family) throw new Error("missing family");
    // call into your plugin logic (stubbed)
    console.log("previewTemplatePlacement", args);
    return { ok: true, message: `Preview for ${args.family} ${args.version || ""}` };
  });

  window.z5Linter.register("mergeTemplateToCanvas", async (args: any) => {
    if (!args || !args.templatePath) throw new Error("missing templatePath");
    // call your merge logic here
    console.log("mergeTemplateToCanvas", args);
    return { ok: true, message: `Merged ${args.templatePath}` };
  });

  window.z5Linter.register("openTemplateEditor", async (args: any) => {
    if (!args || !args.templatePath) throw new Error("missing templatePath");
    // open editor logic
    console.log("openTemplateEditor", args);
    return { ok: true, message: `Opened ${args.templatePath}` };
  });

  // optional: register a renderer action so dataview or other callers can ask plugin to render
  window.z5Linter.register("renderToolbar", async (args: { container?: HTMLElement; containerId?: string; actions: ToolbarAction[]; debug?: boolean }) => {
    if (!args) throw new Error("renderToolbar requires args");
    // Prefer direct element reference
    const container = (args as any).container ?? (typeof (args as any).containerId === "string" ? document.getElementById((args as any).containerId) : null);
    if (!container) throw new Error(`renderToolbar: container not found`);
    renderToolbarInto(container, args.actions || [], { debug: !!args.debug });
    return { ok: true };
  });
}
