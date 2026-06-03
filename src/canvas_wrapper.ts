import { App, Notice, Plugin } from "obsidian";
import { v4 as uuidv4 } from "uuid";
import { ensureInvokerRegistered } from "./invoker";




// Visual/layout constants
export const GROUP_MARGIN_PX = 20;        // margin around groups (pixels)
export const GROUP_CARD_Y_GAP = 0;       // default vertical gap between cards inside a group
export const FRONTMATTER_NODE_HEIGHT = 60;   // height of the frontmatter node (px)
export const AREA_NODE_HEIGHT = 60;         // height of each area card node (px)
export const EMBED_NODE_HEIGHT = 1200;        // minimum height of the embedded-template node (px)
export const MAJOR_VERTICAL_SPACING = 40;          // vertical spacing between stacked items (px)
export const CONTROL_NODE_HEIGHT = 80; // height of the control node (px)
export const HEADING_NODE_HEIGHT = 100; // height of the control node (px)

// Horizontal spacing to place a new template group to the right of the highest-version group
export const TEMPLATE_GROUP_HORIZONTAL_OFFSET = 480;


export const DEFAULT_NODE_STYLE: Record<string, any> = {
  textAlign: "center",
};



// Callout style tokens used when rendering callout blocks inside text nodes.
// Valid values are freeform strings; common choices: "info", "note", "tip", "warning", "danger".
export const FRONTMATTER_CALLOUT_TYPE = "warning";
export const AREA_CALLOUT_TYPE = "info";

// Explicit width for area nodes (so group width is predictable)
export const TEMPLATE_STACK_WIDTH = 360;

// Grid / cell size (single canonical value used everywhere)
export const CELL_SIZE = 20;



// Register a command that runs a simple template -> canvas test.
// It parses a template file (frontmatter + areas), builds a vertical group of area cards,
// merges them into an existing canvas (or creates a new canvas file), and writes the canvas JSON.
//
// Usage: call registerCanvasTemplateTestCommand(app, this) from your plugin onload.
// Register command (unchanged behavior; command writes the file)
export function registerCanvasCommands(app: App, plugin: Plugin) {
  plugin.addCommand({
    id: "z5-canvas-template-test",
    name: "z5Linter: Canvas template test (parse template -> write canvas)",
    callback: async () => {
      const templatesFolder = "testMigrationData/templates";
      const outCanvasPath = "testMigrationData/migration.canvas";
      const familyToQueue = "project"; // the family to queue up (could be made configurable)

      try {
        // 1) Load existing canvas JSON if present
        const vault = app.vault;
        let canvasJson: any = { nodes: [], edges: [], metadata: {} };
        if (await vault.adapter.exists(outCanvasPath)) {
          const raw = await vault.adapter.read(outCanvasPath);
          try {
            const parsedJson = JSON.parse(raw);
            canvasJson = parsedJson && typeof parsedJson === "object" ? parsedJson : canvasJson;
          } catch (e) {
            console.warn("[z5Linter] Existing canvas JSON invalid, overwriting with new canvas.");
            canvasJson = { nodes: [], edges: [], metadata: {} };
          }
        }

        // 2) Find all templates in folder that match the family (sorted by version ascending)
        const templates = await findTemplatesInFolderByFamily(app, templatesFolder, familyToQueue);
        if (!templates.length) {
          new Notice(`No templates found for family '${familyToQueue}' in ${templatesFolder}`);
          return;
        }

        // 3) For each template (in order), decide placement and add if missing
        let anyAdded = false;
        for (const t of templates) {
          const templatePath = t.path;
          const templateFamily = t.templateFamily;
          const templateVersion = t.templateVersion;

          // Decide placement relative to existing canvas
          const placement = computePlacementForTemplate(canvasJson, templateFamily, templateVersion, 80, 80);

          if (!placement.shouldAdd) {
            console.log(`[z5Linter] Skipping ${templateFamily} v${templateVersion} — already present.`);
            continue;
          }

          console.log(`[z5Linter] Adding ${templateFamily} v${templateVersion} at position (${placement.startX}, ${placement.startY})`)
          // Build nodes/edges for this template at computed origin
          const newCanvas = await makeCanvasNodesForTemplate(app, templatePath, placement.startX, placement.startY);

          // Merge into the in-memory canvas (handles id collisions)
          mergeCanvasJson(canvasJson, newCanvas);

          anyAdded = true;

          // After merging, the canvasJson now contains the newly added group; subsequent templates
          // will compute placement to the right of the highest-version group (so they chain to the right).
        }

        if (!anyAdded) {
          new Notice(`No templates added — canvas already contains the queued versions for '${familyToQueue}'.`);
          return;
        }

        // 4) Write merged canvas JSON to disk (overwrite)
        await writeCanvasJsonToFile(app, outCanvasPath, canvasJson, true);

        new Notice(`Queued templates for '${familyToQueue}' added to canvas: ${outCanvasPath}`);
        console.log("[z5Linter] Queued templates added to canvas:", {
          templatesCount: templates.length,
          outCanvasPath,
        });
      } catch (err) {
        console.error("[z5Linter] Canvas template queue failed:", err);
        new Notice("Canvas template queue failed — see console for details.");
      }
    },
  });


  plugin.addCommand({
    id: "z5-canvas-reflow-project-v2",
    name: "z5Linter: Reflow template block (project v2.0.0)",
    callback: async () => {
      const outCanvasPath = "testMigrationData/migration.canvas";

      try {
        const vault = app.vault;

        // 1) Load existing canvas JSON
        let canvasJson: any = { nodes: [], edges: [], metadata: {} };
        if (await vault.adapter.exists(outCanvasPath)) {
          const raw = await vault.adapter.read(outCanvasPath);
          try {
            canvasJson = JSON.parse(raw);
          } catch (e) {
            new Notice("Canvas JSON invalid — cannot reflow.");
            console.error("[z5Linter] Invalid canvas JSON:", e);
            return;
          }
        } else {
          new Notice("Canvas file not found — cannot reflow.");
          return;
        }

        // 2) Run the reflow
        await reflowTemplateBlock(app, canvasJson, "project", "2.0.0");

        // 3) Write updated canvas back to disk
        await writeCanvasJsonToFile(app, outCanvasPath, canvasJson, true);

        new Notice("Reflowed template block: project v2.0.0");
        console.log("[z5Linter] Reflowed project v2.0.0");

      } catch (err) {
        console.error("[z5Linter] Reflow failed:", err);
        new Notice("Reflow failed — see console for details.");
      }
    },
  });

  plugin.addCommand({
    id: "z5-canvas-mark-invalid-nodes",
    name: "z5Linter: Mark canvas nodes with missing template metadata (red)",
    callback: async () => {
      const outCanvasPath = "testMigrationData/migration.canvas";
      try {
        const vault = app.vault;

        if (!(await vault.adapter.exists(outCanvasPath))) {
          new Notice("Canvas file not found: " + outCanvasPath);
          return;
        }

        const raw = await vault.adapter.read(outCanvasPath);
        let canvasJson: any;
        try {
          canvasJson = JSON.parse(raw);
        } catch (e) {
          new Notice("Canvas JSON invalid — cannot scan.");
          console.error("[z5Linter] Invalid canvas JSON:", e);
          return;
        }

        const changed = scanAndMarkInvalidTemplateNodes(canvasJson);

        if (changed > 0) {
          await writeCanvasJsonToFile(app, outCanvasPath, canvasJson, true);
          new Notice(`Marked ${changed} node(s) with missing template metadata (red).`);
          console.log("[z5Linter] Marked invalid nodes:", { changed, outCanvasPath });
        } else {
          new Notice("No nodes with missing template metadata found.");
        }
      } catch (err) {
        console.error("[z5Linter] Mark-invalid-nodes command failed:", err);
        new Notice("Mark-invalid-nodes failed — see console for details.");
      }
    },
  });


  plugin.addCommand({
    id: "z5-canvas-repair-project-v2",
    name: "z5Linter: Repair migration block (project v2.0.0)",
    callback: async () => {
      const outCanvasPath = "testMigrationData/migration.canvas";
      try {
        const vault = app.vault;

        if (!(await vault.adapter.exists(outCanvasPath))) {
          new Notice("Canvas file not found: " + outCanvasPath);
          return;
        }

        const raw = await vault.adapter.read(outCanvasPath);
        let canvasJson: any;
        try {
          canvasJson = JSON.parse(raw);
        } catch (e) {
          new Notice("Canvas JSON invalid — cannot repair.");
          console.error("[z5Linter] Invalid canvas JSON:", e);
          return;
        }

        const { removed, added, edgesAdded } = await repairMigrationBlock(app, canvasJson, "project", "2.0.0");

        // Always write the canvas back to disk
        try {
          await writeCanvasJsonToFile(app, outCanvasPath, canvasJson, true);
        } catch (writeErr) {
          console.error("[z5Linter] Failed to write canvas after repair:", writeErr);
          new Notice("Repair completed but failed to write canvas — see console.");
          return;
        }

        if (removed > 0 || added > 0 || edgesAdded > 0) {
          new Notice(`Repair complete: removed ${removed}, added ${added}, edges ${edgesAdded} for project v2.0.0.`);
        } else {
          new Notice("Repair complete: no structural changes required for project v2.0.0. Canvas file was still written.");
        }

        console.log("[z5Linter] Repair result:", { removed, added, edgesAdded, outCanvasPath });
      } catch (err) {
        console.error("[z5Linter] Repair failed:", err);
        new Notice("Repair failed — see console for details.");
      }
    },
  });



  // actions that can be triggered from inside the canvas:

  // Ensure invoker exists
  ensureInvokerRegistered();

  // Register the repair action so toolbar buttons can call it
  window.z5Linter.register("repairMigrationBlock", async (args: { family?: string; version?: string; migrationCanvasPath?: string }) => {
    console.info("[z5Linter.action] repairMigrationBlock called with", args);
    if (!args || !args.family || !args.version) throw new Error("repairMigrationBlock requires family and version");

    const family = String(args.family);
    const version = String(args.version);
    const outCanvasPath = String(args.migrationCanvasPath || "testMigrationData/migration.canvas");

    const vault = app.vault;
    if (!(await vault.adapter.exists(outCanvasPath))) {
      throw new Error(`Canvas file not found: ${outCanvasPath}`);
    }

    const raw = await vault.adapter.read(outCanvasPath);
    let canvasJson: any;
    try {
      canvasJson = JSON.parse(raw);
    } catch (e) {
      throw new Error("Canvas JSON invalid");
    }

    // Run repair (returns { removed, added, edgesAdded })
    const result = await repairMigrationBlock(app, canvasJson, family, version);

    // Always write the canvas back to disk, even if nothing structural changed.
    try {
      await writeCanvasJsonToFile(app, outCanvasPath, canvasJson, true);
      console.info("[z5Linter.action] repairMigrationBlock wrote canvas to", outCanvasPath);
    } catch (writeErr) {
      console.error("[z5Linter.action] Failed to write canvas after repair:", writeErr);
      // Still return the result but surface the write error to callers
      return { ok: false, writeError: String(writeErr), ...result, outCanvasPath };
    }

    const changed = !!(result.removed || result.added || result.edgesAdded);
    console.info("[z5Linter.action] repairMigrationBlock result", { result, changed });

    return { ok: true, changed, ...result, outCanvasPath };
  });


}






/**
 * Build canvas nodes and edges for a template and return the in-memory canvas JSON.
 *
 * - app: Obsidian App (required)
 * - templatePath: path to the markdown template to parse
 * - startX/startY: top-left origin for the generated UI (offset applied to all nodes)
 *
 * Returns: { nodes: any[], edges: any[], metadata: any } (does not write to disk)
 */
export async function makeCanvasNodesForTemplate(
  app: App,
  templatePath = "testMigrationData/templates/template_project_v1.md",
  startX = 80,
  startY = 80
) {
  const canvasJson: any = { nodes: [], edges: [], metadata: {} };
  const vault = app.vault;

  if (!(await vault.adapter.exists(templatePath))) {
    throw new Error(`Template file not found: ${templatePath}`);
  }

  const parsed = await parseTemplateFile(app, templatePath);
  const areas = parsed.areas || [];
  const front = parsed.frontmatter || {};

  if (!areas.length) {
    return canvasJson;
  }

  const templateName = front["template"] || front["template_name"];
  const templateVersion = front["template_version"] || front["version"] || null;

  let templateFamily: string;
  if (templateName) {
    templateFamily = String(templateName);
  } else {
    const base = templatePath.split("/").pop() || templatePath;
    const baseName = base.replace(/\.md$/i, "");
    templateFamily = deriveFamilyFromBasename(baseName);
  }

  const headerX = Number(startX) || 0;
  const headerY = Number(startY) || 0;
  //const headerWidth = TEMPLATE_STACK_WIDTH;
  //const headerHeight = HEADING_NODE_HEIGHT;

  // 0) Header node (use helper)
  const headerNode = createHeaderNode(headerX, headerY, TEMPLATE_STACK_WIDTH, HEADING_NODE_HEIGHT, {
    templateFamily,
    templateVersion,
  });

  // 1) Area column geometry
  // frontmatter top = headerY + HEADING_NODE_HEIGHT + MAJOR_VERTICAL_SPACING + GROUP_MARGIN_PX
  const areaColumnX = headerX + GROUP_MARGIN_PX;
  const fmTopY = headerY + HEADING_NODE_HEIGHT + MAJOR_VERTICAL_SPACING + GROUP_MARGIN_PX;
  const areaNodeWidth = Math.max(CELL_SIZE, TEMPLATE_STACK_WIDTH - 2 * GROUP_MARGIN_PX);

  // 2) Frontmatter node (use helper and explicit width so it matches area width)
  const fmNode = createFrontmatterNode(front, areaColumnX, fmTopY, areaNodeWidth, FRONTMATTER_NODE_HEIGHT, {
    templateFamily,
    templateVersion,
    id: undefined,
    styleAttributes: undefined,
  });

  // 3) Area nodes (use buildAreaGroupNodes with areaWidth)
  const built = buildAreaGroupNodes(
    areas,
    areaColumnX,
    fmTopY + FRONTMATTER_NODE_HEIGHT + GROUP_CARD_Y_GAP,
    { labelLine: true, templateFamily, templateVersion, areaWidth: areaNodeWidth }
  );
  const areaNodes = built.areaNodes || [];

  // 4) Compute final group from frontmatter + area nodes (no placeholder)
  const allNodesForGroup = [fmNode, ...areaNodes];
  const finalGroupNode = makeGroupForNodes(allNodesForGroup, {
    templateFamily,
    templateVersion,
  });
  const groupNode = finalGroupNode ? { ...finalGroupNode } : null;

  // 5) Append header first (so it is not enclosed), then group, then frontmatter and area nodes
  appendNodesToCanvasJson(canvasJson, headerNode);
  if (groupNode) appendNodesToCanvasJson(canvasJson, groupNode);
  appendNodesToCanvasJson(canvasJson, [fmNode, ...areaNodes]);

  // 6) Control node (below group) — use canonical TEMPLATE_STACK_WIDTH
  const controlX = groupNode ? Number(groupNode.x) || headerX : headerX;
  const controlWidth = TEMPLATE_STACK_WIDTH;
  const controlYBase = groupNode
    ? (Number(groupNode.y) || headerY) + (Number(groupNode.height) || 0)
    : (fmTopY + FRONTMATTER_NODE_HEIGHT + areaNodes.length * (AREA_NODE_HEIGHT + GROUP_CARD_Y_GAP));
  const controlY = controlYBase + MAJOR_VERTICAL_SPACING;

  const controlNode = createControlNode(controlX, controlY, controlWidth, {
    templateFamily,
    templateVersion,
  });

  // 7) Embed node (wiki embed) placed below control node — use canonical TEMPLATE_STACK_WIDTH
  // createEmbedNode signature in your file: (app, templatePath, groupNode, anchorNode, baseX, baseY, templateFamily?, templateVersion?)
  const embedNode = await createEmbedNode(
    app,
    templatePath,
    groupNode,
    controlNode,
    headerX,
    headerY,
    templateFamily,
    templateVersion
  );

  // 8) Append control and embed nodes
  appendNodesToCanvasJson(canvasJson, controlNode);
  appendNodesToCanvasJson(canvasJson, embedNode);

  // 9) Create edges: header.bottom -> group.top, group.bottom -> control.top, control.bottom -> embed.top
  const edgesToAdd: any[] = [];
  if (headerNode && groupNode) {
    edgesToAdd.push(
      createEdge(headerNode, "bottom", groupNode, "top", {
        arrow: "bi",
        arrowStyle: "blunt",
        pathfinding: "direct",
      })
    );
  }
  if (groupNode && controlNode) {
    edgesToAdd.push(
      createEdge(groupNode, "bottom", controlNode, "top", {
        arrow: "bi",
        arrowStyle: "blunt",
        pathfinding: "direct",
      })
    );
  }
  if (controlNode && embedNode) {
    edgesToAdd.push(
      createEdge(controlNode, "bottom", embedNode, "top", {
        arrow: "bi",
        arrowStyle: "blunt",
        pathfinding: "direct",
      })
    );
  }
  if (edgesToAdd.length) appendEdgesToCanvasJson(canvasJson, edgesToAdd);

  return canvasJson;
}


















/** Parse YAML frontmatter (returns object of string values) */
export function parseFrontmatterSimple(mdText: string): Record<string, string> {
  const fmMatch = mdText.match(/^---\s*[\r\n]+([\s\S]*?)\r?\n---\s*/);
  if (!fmMatch) return {};
  const fmText = fmMatch[1];
  const out: Record<string, string> = {};
  for (const line of fmText.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.+?)\s*$/);
    if (m) out[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

/**
 * Parse area tags and return array of areas with content.
 * Area syntax:
 *   <!-- area: area_id -->
 *   ... content ...
 *   <!-- /area -->
 * Optional label:
 *   <!-- area: area_id label="Human label" -->
 *
 * Returns:
 * {
 *   id: string,
 *   label?: string,
 *   startLine: number,   // 0-based index of first content line
 *   endLine?: number,    // exclusive; undefined => EOF
 *   content: string      // raw markdown inside the area
 * }
 */
export function parseAreasWithContent(mdText: string) {
  const lines = mdText.split(/\r?\n/);
  const areas: { id: string; label?: string; startLine: number; endLine?: number; content?: string }[] = [];
  const openStack: { id: string; label?: string; startLine: number }[] = [];

  const openRe = /^\s*<!--\s*area\s*:\s*([A-Za-z0-9_\-]+)(?:\s+label\s*=\s*"(.*?)")?\s*-->\s*$/i;
  const closeRe = /^\s*<!--\s*\/area\s*-->\s*$/i;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const mo = line.match(openRe);
    if (mo) {
      openStack.push({ id: mo[1], label: mo[2], startLine: i + 1 });
      continue;
    }
    if (closeRe.test(line)) {
      const last = openStack.pop();
      if (last) {
        areas.push({ id: last.id, label: last.label, startLine: last.startLine, endLine: i });
      }
    }
  }

  // any still-open areas run to EOF
  while (openStack.length) {
    const last = openStack.pop()!;
    areas.push({ id: last.id, label: last.label, startLine: last.startLine, endLine: undefined });
  }

  // attach content for each area
  for (const a of areas) {
    const start = a.startLine;
    const end = typeof a.endLine === "number" ? a.endLine : lines.length;
    a.content = lines.slice(start, end).join("\n").replace(/^\n+|\n+$/g, "");
  }

  return areas;
}

/**
 * High-level parse of a template file (reads frontmatter, areas).
 * - app: Obsidian App
 * - mdPath: path to markdown file
 *
 * Returns:
 * {
 *   frontmatter: Record<string,string>,
 *   areas: Array<{id,label,startLine,endLine,content}>
 * }
 */
export async function parseTemplateFile(app: App, mdPath: string) {
  const vault = app.vault;
  if (!(await vault.adapter.exists(mdPath))) throw new Error(`Markdown file not found: ${mdPath}`);
  const md = await vault.adapter.read(mdPath);
  const frontmatter = parseFrontmatterSimple(md);
  const areas = parseAreasWithContent(md);
  return { frontmatter, areas };
}










/**
 * Build a vertical column of area cards and a group node that encloses them.
 *
 * Parameters:
 *  - areas: array from parseAreasWithContent (id,label,content)
 *  - baseX, baseY: top-left of the column
 *  - cardWidth, cardHeight, yGap: layout
 *  - cellSize: grid snap size
 *  - opts: { labelLine?: boolean } // include "area: id (label)" first line
 *
 * Returns:
 *  { groupNode: any | null, areaNodes: any[] }
 */
export function buildAreaGroupNodes(
  areas,
  baseX = 80,
  baseY = 80,
  opts?: {
    labelLine?: boolean;
    templateFamily?: string;
    templateVersion?: string;
    areaWidth?: number;
  }
) {
  const areaNodes: any[] = [];
  const labelLine = opts?.labelLine ?? true;
  const areaWidth = typeof opts?.areaWidth === "number" ? Math.max(CELL_SIZE, opts!.areaWidth) : TEMPLATE_STACK_WIDTH;

  for (let i = 0; i < areas.length; i++) {
    const a = areas[i];
    const x = baseX;
    const y = baseY + i * (AREA_NODE_HEIGHT + GROUP_CARD_Y_GAP);

    const areaHeader = `AREA: ${a.id}${a.label ? ` (${a.label})` : ""}`;
    const content = (a.content || "").trim();
    const contentLines = content.length ? content.split(/\r?\n/) : [];

    const calloutHeader = `> [!${AREA_CALLOUT_TYPE}]- ${areaHeader}`;
    const calloutLines = [calloutHeader, ...contentLines.map((ln) => `> ${ln}`)];
    const finalCallout = labelLine ? calloutLines.join("\n") : contentLines.map((ln) => `> ${ln}`).join("\n");

    const node = createCanvasNode({
      x,
      y,
      width: areaWidth,
      height: AREA_NODE_HEIGHT,
      type: "text",
      text: finalCallout,
      metadata: {
        role: "area",
        areaId: a.id,
        areaLabel: a.label,
        source: "template",
      },
      z5LinterAttributes: makeZ5Attrs(
        opts?.templateFamily ?? null,
        opts?.templateVersion ?? null,
        { role: "area", areaId: a.id, areaLabel: a.label }
      ),
      styleAttributes: mergeStyleAttrs(DEFAULT_NODE_STYLE, undefined),
      cellSize: CELL_SIZE,
    });
    areaNodes.push(node);
  }

  return { areaNodes };
}




/**
 * Create a single canvas node object (snapped to grid).
 *
 * - Returns a node object ready to push into a canvas JSON `nodes` array.
 * - Does not write to disk.
 */
export function createCanvasNode(opts: {
  x: number;
  y: number;
  width: number;
  height: number;
  type?: string;
  text?: string;
  label?: string;
  metadata?: Record<string, any>;
  styleAttributes?: Record<string, any>;
  z5LinterAttributes?: Record<string, any>;
  cellSize?: number;
  id?: string;
}) {
  const {
    x, y, width, height,
    type = "text",
    text = "",
    label,
    metadata = {},
    styleAttributes = {},
    z5LinterAttributes = {},
    cellSize = CELL_SIZE,
    id,
  } = opts;

  const rect = { x: Number(x) || 0, y: Number(y) || 0, width: Number(width) || CELL_SIZE, height: Number(height) || CELL_SIZE };
  const snapped = snapRect(rect);
  const nodeId = id || uuidv4();

  const finalMetadata = Object.assign({}, metadata);
  finalMetadata.z5LinterAttributes = Object.assign({}, finalMetadata.z5LinterAttributes || {}, z5LinterAttributes);

  const node: any = {
    id: nodeId,
    type,
    text,
    styleAttributes: styleAttributes || {},
    x: snapped.x,
    y: snapped.y,
    width: snapped.width,
    height: snapped.height,
    metadata: finalMetadata,
  };

  // Optional label property (used by Canvas for group nodes)
  if (typeof label !== "undefined") node.label = label;

  return node;
}



/**
 * Append a node (or nodes) to an in-memory canvas JSON object.
 *
 * - canvasJson must be an object with `nodes` and `edges` arrays (if missing they will be created).
 * - This helper mutates canvasJson and returns the appended node id(s).
 */
export function appendNodesToCanvasJson(canvasJson: any, nodes: any | any[]) {
  if (!canvasJson || typeof canvasJson !== "object") throw new Error("canvasJson must be an object");
  if (!Array.isArray(canvasJson.nodes)) canvasJson.nodes = [];
  const toAdd = Array.isArray(nodes) ? nodes : [nodes];
  for (const n of toAdd) canvasJson.nodes.push(n);
  return toAdd.map(n => n.id);
}





/**
 * Write an in-memory canvas JSON object to disk at outCanvasPath.
 *
 * - app: Obsidian App instance
 * - outCanvasPath: path to write (e.g., "testMigrationData/migration.canvas")
 * - canvasJson: object with `nodes`, `edges`, `metadata`
 * - overwrite: if false and file exists, throws
 */
export async function writeCanvasJsonToFile(app: App, outCanvasPath: string, canvasJson: any, overwrite = false) {
  if (!canvasJson || typeof canvasJson !== "object") throw new Error("canvasJson must be an object");
  const vault = app.vault;
  const content = JSON.stringify(canvasJson, null, 2);
  const exists = await vault.adapter.exists(outCanvasPath);

  // ensure parent folder exists
  const parts = outCanvasPath.split("/");
  if (parts.length > 1) {
    const folder = parts.slice(0, -1).join("/");
    const list = await vault.adapter.list(folder).catch(() => null);
    if (!list) {
      await vault.create(`${folder}/.keep`, "z5Linter folder");
    }
  }

  if (exists) {
    if (!overwrite) throw new Error(`Canvas file already exists at ${outCanvasPath}`);
    const file = await vault.getAbstractFileByPath(outCanvasPath);
    await vault.modify(file as any, content);
  } else {
    await vault.create(outCanvasPath, content);
  }
}



/** Snap a number to nearest multiple of cell (round) */
export function snapToGrid(value: number) {
  return Math.round(value / CELL_SIZE) * CELL_SIZE;
}

/** Snap rectangle so x,y are snapped and width/height are multiples of cell */
export function snapRect(rect: { x: number; y: number; width: number; height: number }) {
  const snappedX = snapToGrid(rect.x);
  const snappedY = snapToGrid(rect.y);
  const snappedW = Math.max(CELL_SIZE, Math.round(rect.width / CELL_SIZE) * CELL_SIZE);
  const snappedH = Math.max(CELL_SIZE, Math.round(rect.height / CELL_SIZE) * CELL_SIZE);
  return { x: snappedX, y: snappedY, width: snappedW, height: snappedH };
}




/**
 * Create a group node that encloses the provided nodes.
 * - nodes: array of canvas nodes (must have x,y,width,height)
 * - opts.marginPx: margin in pixels to expand the group bounds (defaults to GROUP_MARGIN_PX)
 * - opts.label: group label string (defaults to "Group")
 * - opts.cellSize: grid cell size (defaults to 20)
 *
 * Returns a Canvas-compatible group node or null if nodes empty.
 */
export function makeGroupForNodes(
  nodes: any[],
  opts?: {
    //label?: string; // intentionally not used for groups
    templateFamily?: string;
    templateVersion?: string;
  }
) {
  if (!nodes || nodes.length === 0) return null;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    const nx = Number(n.x) || 0;
    const ny = Number(n.y) || 0;
    const w = Number(n.width) || 0;
    const h = Number(n.height) || 0;
    minX = Math.min(minX, nx);
    minY = Math.min(minY, ny);
    maxX = Math.max(maxX, nx + w);
    maxY = Math.max(maxY, ny + h);
  }

  // Expand by margin (snap margin to grid)
  const margin = Math.max(0, Math.round(GROUP_MARGIN_PX / CELL_SIZE) * CELL_SIZE);
  minX -= margin;
  minY -= margin;
  maxX += margin;
  maxY += margin;

  // Snap group rect to grid
  const groupRect = snapRect({ x: minX, y: minY, width: maxX - minX, height: maxY - minY });

  // Build group node via createCanvasNode so id/snapping/metadata flow through the single factory
  const z5 = makeZ5Attrs(opts?.templateFamily ?? null, opts?.templateVersion ?? null, { role: "group" });

  const groupNode = createCanvasNode({
    x: groupRect.x,
    y: groupRect.y,
    width: groupRect.width,
    height: groupRect.height,
    type: "group",
    text: "", // groups don't render `text`
    metadata: {}, // createCanvasNode will attach z5LinterAttributes below
    z5LinterAttributes: z5,
    styleAttributes: {},
    cellSize: CELL_SIZE,
    // intentionally do NOT pass label here; groups should not receive a label property
  });

  return groupNode;
}



/**
 * Create a frontmatter node as a callout containing a simple markdown table.
 *
 * - frontmatter: Record<string,string>
 * - x,y,width,height: geometry (snapped)
 * - cellSize: grid cell size (default 20)
 *
 * The callout format:
 * > [!info]- frontmatter
 * > | key | value |
 * > | --- | ----- |
 * > | k1  | v1    |
 * > | k2  | v2    |
 *
 * Returns a Canvas node object (does not write to disk).
 */
export function createFrontmatterNode(
  frontmatter: Record<string, string> | undefined,
  x: number,
  y: number,
  width = TEMPLATE_STACK_WIDTH,
  height = FRONTMATTER_NODE_HEIGHT,
  opts?: {
    id?: string;
    styleAttributes?: Record<string, any>;
    templateFamily?: string | null;
    templateVersion?: string | null;
    z5LinterAttributes?: Record<string, any>;
  }
) {
  const fm = frontmatter || {};
  const keys = Object.keys(fm);
  const tableLines: string[] = [];
  if (keys.length) {
    tableLines.push(`| key | value |`);
    tableLines.push(`| --- | ----- |`);
    for (const k of keys) {
      const v = String(fm[k] ?? "");
      const esc = (s: string) => s.replace(/\|/g, "\\|");
      tableLines.push(`| ${esc(k)} | ${esc(v)} |`);
    }
  } else {
    tableLines.push(`(no frontmatter)`);
  }

  const calloutHeader = `> [!${FRONTMATTER_CALLOUT_TYPE}]- frontmatter`;
  const calloutLines = [calloutHeader, ...tableLines.map((ln) => `> ${ln}`)];
  const text = calloutLines.join("\n");

  const z5Attrs =
    opts?.z5LinterAttributes ??
    makeZ5Attrs(opts?.templateFamily ?? null, opts?.templateVersion ?? null, { role: "frontmatter" });

  return createCanvasNode({
    x,
    y,
    width,
    height,
    type: "text",
    text,
    metadata: { role: "frontmatter" },
    z5LinterAttributes: z5Attrs,
    styleAttributes: mergeStyleAttrs(DEFAULT_NODE_STYLE, opts?.styleAttributes),
    cellSize: CELL_SIZE,
    id: opts?.id,
  });
}









/**
 * Create an embed node that contains a wiki-style embed to the template file.
 *
 * - anchorNode: optional node to place the embed below (if provided, embedY = anchor.y + anchor.height + yGap)
 * - groupNode: used only as a fallback for x/width when anchorNode is not provided
 */
export async function createEmbedNode(
  app: App,
  templatePath: string,
  groupNode: any | null,
  anchorNode: any | null,
  baseX: number,
  baseY: number,
  templateFamily?: string | null,
  templateVersion?: string | null
){
  const vault = app.vault;

  // Optional: warn if file missing but still create embed node
  if (!(await vault.adapter.exists(templatePath))) {
    console.warn(`[z5Linter] createEmbedNode: template not found: ${templatePath}`);
  }

  const wikiEmbed = `![[${templatePath}|clean]]`;

  // Determine x/width: prefer anchorNode.x/width if present, otherwise groupNode, otherwise fallbacks
  const embedX = anchorNode
    ? (Number(anchorNode.x) || (groupNode ? Number(groupNode.x) || baseX : baseX))
    : (groupNode ? Number(groupNode.x) || baseX : baseX);

  const embedWidth = anchorNode
    ? (Number(anchorNode.width) || (groupNode ? Number(groupNode.width) || TEMPLATE_STACK_WIDTH : TEMPLATE_STACK_WIDTH))
    : (groupNode ? Number(groupNode.width) || TEMPLATE_STACK_WIDTH : TEMPLATE_STACK_WIDTH);

  // Determine Y: if anchorNode provided, place below anchor; else if groupNode provided, place below group; else use baseY
  const embedYBase = anchorNode
    ? (Number(anchorNode.y) || baseY) + (Number(anchorNode.height) || 0)
    : (groupNode ? (Number(groupNode.y) || baseY) + (Number(groupNode.height) || 0) : baseY);

  const embedY = embedYBase + MAJOR_VERTICAL_SPACING;

  // Height: at least minHeight, or twice the group height if group exists and that is larger
  const candidateHeight = groupNode ? (Number(groupNode.height) || 0) * 2 : 0;
  const embedHeight = Math.max(EMBED_NODE_HEIGHT, candidateHeight || EMBED_NODE_HEIGHT);

  const embedNode = createCanvasNode({
    x: embedX,
    y: embedY,
    width: embedWidth,
    height: embedHeight,
    type: "text",
    text: wikiEmbed,
    styleAttributes: mergeStyleAttrs(DEFAULT_NODE_STYLE, {"textAlign":"null"}), // write a default for future maintenance.
    metadata: { role: "embedded-template", sourceFile: templatePath },
    z5LinterAttributes: makeZ5Attrs(templateFamily ?? null, templateVersion ?? null, { sourceFile: templatePath }),
    cellSize: CELL_SIZE,
  });


  return embedNode;
}





/**
 * Create a control node (blank text node).
 *
 * - x,y,width,height: geometry (snapped by createCanvasNode)
 * - cellSize: grid cell size
 * - opts.id / opts.styleAttributes optional
 *
 * Returns a Canvas node object (does not write to disk).
 */
export function createControlNode(
  x: number,
  y: number,
  width: number,
  opts?: {
    id?: string;
    styleAttributes?: Record<string, any>;
    templateFamily?: string | null;
    templateVersion?: string | null;
    z5LinterAttributes?: Record<string, any>;
  }
) {
  const family = opts?.templateFamily ?? null;
  const version = opts?.templateVersion ?? null;

  const toolbarCodeblock = makeToolbarCodeblock(family, version);

  return createCanvasNode({
    x,
    y,
    width,
    height: CONTROL_NODE_HEIGHT,
    type: "text",
    text: toolbarCodeblock,
    metadata: { role: "control" },
    styleAttributes: mergeStyleAttrs(DEFAULT_NODE_STYLE, opts?.styleAttributes),
    z5LinterAttributes:
      opts?.z5LinterAttributes ??
      makeZ5Attrs(family, version, { role: "control" }),
    cellSize: CELL_SIZE,
    id: opts?.id,
  });
}


// creates the migration block toolbar codeblock
function makeToolbarCodeblock(family: string | null, version: string | null): string {
  return [
    "```z5LinterToolbar",
    "type: template_migration_block_toolbar",
    `template_family: ${family ?? ""}`,
    `template_version: ${version ?? ""}`,
    "```"
  ].join("\n");
}






// EDGE HANDLING




/**
 * Create a Canvas edge object between two nodes.
 *
 * Parameters:
 *  - fromNode: node object or node id (string)
 *  - fromSide: "top" | "bottom" | "left" | "right"
 *  - toNode: node object or node id (string)
 *  - toSide: "top" | "bottom" | "left" | "right"
 *  - options: {
 *      color?: number | string,            // 0-6 preset or hex string like "#2aa2a0"
 *      arrow?: "none" | "uni" | "bi",      // "none" => no arrow, "uni" => default single-direction, "bi" => bidirectional
 *      arrowStyle?: string | null,         // advanced arrow style: "triangle-outline", "thin-triangle", etc.
 *      pathStyle?: "null" | "dotted" | "short-dashed" | "long-dashed" | null,
 *      pathfinding?: "direct" | "square" | "a-star" | null,
 *      label?: string,
 *      toFloating?: boolean,               // default false
 *      fromFloating?: boolean              // default false
 *    }
 *
 * Returns an edge object ready to push into canvasJson.edges.
 */
export function createEdge(
  fromNode: any | string,
  fromSide: "top" | "bottom" | "left" | "right",
  toNode: any | string,
  toSide: "top" | "bottom" | "left" | "right",
  options?: {
    color?: number | string;
    arrow?: "none" | "uni" | "bi";
    arrowStyle?: string | null;
    pathStyle?: "null" | "dotted" | "short-dashed" | "long-dashed" | null;
    pathfinding?: "direct" | "square" | "a-star" | null;
    label?: string;
    toFloating?: boolean;
    fromFloating?: boolean;
  }
) {
  const opts = options || {};
  const fromId = typeof fromNode === "string" ? fromNode : (fromNode && fromNode.id);
  const toId = typeof toNode === "string" ? toNode : (toNode && toNode.id);

  if (!fromId || !toId) throw new Error("createEdge: fromNode and toNode must have ids or be id strings.");

  // Base edge object
  const edge: any = {
    id: uuidv4(),
    styleAttributes: {},
    toFloating: !!opts.toFloating,
    fromFloating: !!opts.fromFloating,
    fromNode: fromId,
    fromSide,
    toNode: toId,
    toSide,
  };

  // Arrow direction handling
  // - "none" => no arrow at to-end (toEnd: "none")
  // - "uni"  => default Canvas behavior (no explicit toEnd/fromEnd fields)
  // - "bi"   => set fromEnd to "arrow" (bidirectional)
  if (opts.arrow === "none") {
    edge.toEnd = "none";
  } else if (opts.arrow === "bi") {
    // bidirectional: set fromEnd to "arrow"
    edge.fromEnd = "arrow";
  } // "uni" => leave unspecified for default single-direction arrow

  // Color: numeric presets 0-6 or hex string
  if (typeof opts.color !== "undefined" && opts.color !== null) {
    edge.color = opts.color;
  }

  // Label
  if (typeof opts.label === "string" && opts.label.length) {
    edge.label = opts.label;
  }

  // styleAttributes: path, arrow style, pathfindingMethod
  const sa: any = {};
  if (typeof opts.pathStyle !== "undefined" && opts.pathStyle !== null) {
    // Canvas uses "path":"null" for solid; keep the literal value if provided
    sa.path = opts.pathStyle;
  }
  if (typeof opts.arrowStyle !== "undefined") {
    // explicit arrow style (advanced Canvas)
    // if null/undefined, we leave it out (Canvas default)
    if (opts.arrowStyle !== null) sa.arrow = opts.arrowStyle;
  }
  if (typeof opts.pathfinding !== "undefined" && opts.pathfinding !== null) {
    sa.pathfindingMethod = opts.pathfinding;
  }

  // Only attach styleAttributes if any were set
  if (Object.keys(sa).length) edge.styleAttributes = sa;

  return edge;
}

/** Append one or more edges to an in-memory canvasJson object */
export function appendEdgesToCanvasJson(canvasJson: any, edges: any | any[]) {
  if (!canvasJson || typeof canvasJson !== "object") throw new Error("canvasJson must be an object");
  if (!Array.isArray(canvasJson.edges)) canvasJson.edges = [];
  const toAdd = Array.isArray(edges) ? edges : [edges];
  for (const e of toAdd) canvasJson.edges.push(e);
  return toAdd.map(e => e.id);
}




export function makeZ5Attrs(templateFamily?: string | null, templateVersion?: string | null, extras?: Record<string, any>) {
  const base: Record<string, any> = {};
  if (typeof templateFamily !== "undefined" && templateFamily !== null) base.templateFamily = String(templateFamily);
  if (typeof templateVersion !== "undefined" && templateVersion !== null) base.templateVersion = String(templateVersion);
  return Object.assign(base, extras || {});
}

export function deriveFamilyFromBasename(name: string) {
  console.warn("warning, triggering deriveFamilyFromBasename() means the template doesn't have the family name in its frontmatter.")
  return name.replace(/[-_]?v\d+(\.\d+)?$/i, "").replace(/[-_]?version[-_]?\d+(\.\d+)?$/i, "");
}











/** Minimal shape returned when a matching node is found */
export type TemplateMatch = {
  node: any;
  templateFamily: string;
  templateVersion: string | null;
};

/** Result for highest-version lookup */
export type HighestVersionResult = {
  node: any;
  version: string;
} | null;

/** Safely read z5LinterAttributes from a node */
export function getZ5Attrs(node: any): Record<string, any> | null {
  if (!node || typeof node !== "object") return null;
  const md = node.metadata;
  if (!md || typeof md !== "object") return null;
  const z = md.z5LinterAttributes;
  return z && typeof z === "object" ? z : null;
}

/** Parse a version string into numeric parts for comparison.
 *  Accepts "1.2.3", "v1.2", "1.2.3-alpha" and returns numeric array [1,2,3].
 *  Non-numeric suffixes are ignored. Missing parts are treated as 0.
 */
export function parseVersionToParts(v?: string | null, maxParts = 4): number[] {
  if (!v) return Array(maxParts).fill(0);
  // strip leading "v" and any pre-release/build metadata
  const cleaned = String(v).trim().replace(/^v/i, "").split(/[-+]/)[0];
  const parts = cleaned.split(/[._]/).map(p => p.replace(/[^\d]/g, ""));
  const nums: number[] = [];
  for (let i = 0; i < maxParts; i++) {
    const p = parts[i];
    nums.push(p && p.length ? Math.max(0, parseInt(p, 10) || 0) : 0);
  }
  return nums;
}

/** Compare two version strings.
 *  Returns 1 if a > b, -1 if a < b, 0 if equal.
 */
export function compareVersionStrings(a?: string | null, b?: string | null): number {
  const A = parseVersionToParts(a);
  const B = parseVersionToParts(b);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const na = A[i] || 0;
    const nb = B[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

/**
 * Check whether a canvas already contains any node with the given template family/version.
 * - canvasJson: object with nodes array
 * - family: template family string to match (exact)
 * - version: optional version string to match (if omitted, only family is checked)
 *
 * Returns: { found: boolean, matches: TemplateMatch[] }
 */
export function findTemplateMatchesInCanvas(
  canvasJson: any,
  family: string,
  version?: string | null
): { found: boolean; matches: TemplateMatch[] } {
  const matches: TemplateMatch[] = [];
  if (!canvasJson || !Array.isArray(canvasJson.nodes)) return { found: false, matches };

  for (const node of canvasJson.nodes) {
    const z = getZ5Attrs(node);
    if (!z) continue;
    if (String(z.templateFamily) !== String(family)) continue;
    const nodeVersion = z.templateVersion ?? null;
    if (typeof version === "undefined" || version === null) {
      matches.push({ node, templateFamily: family, templateVersion: nodeVersion });
    } else {
      if (nodeVersion !== null && String(nodeVersion) === String(version)) {
        matches.push({ node, templateFamily: family, templateVersion: nodeVersion });
      }
    }
  }

  return { found: matches.length > 0, matches };
}

/**
 * Find the header node with the highest templateVersion for a given family.
 * - Looks for nodes that carry z5LinterAttributes.templateFamily and templateVersion
 *   and that are header nodes (metadata.role === "header" OR z5LinterAttributes.role === "header").
 *
 * Returns: { node, version } | null
 */
export function findHighestVersionHeaderNode(canvasJson: any, family: string) {
  if (!canvasJson || !Array.isArray(canvasJson.nodes)) return null;

  let bestNode: any = null;
  let bestVersion: string | null = null;

  for (const node of canvasJson.nodes) {
    if (!node) continue;

    const mdRole = node.metadata && node.metadata.role;
    const z = getZ5Attrs(node);
    const zRole = z && z.role;
    const isHeader = (String(mdRole || "").toLowerCase() === "header") || (String(zRole || "").toLowerCase() === "header");
    if (!isHeader) continue;

    if (!z) continue;
    if (String(z.templateFamily) !== String(family)) continue;

    const nodeVersion = z.templateVersion ?? null;

    if (bestNode === null) {
      bestNode = node;
      bestVersion = nodeVersion;
      continue;
    }

    if (bestVersion === null && nodeVersion !== null) {
      bestNode = node;
      bestVersion = nodeVersion;
      continue;
    }
    if (nodeVersion === null) continue;

    const cmp = compareVersionStrings(nodeVersion, bestVersion);
    if (cmp > 0) {
      bestNode = node;
      bestVersion = nodeVersion;
    }
  }

  return bestNode ? { node: bestNode, version: bestVersion ?? "" } : null;
}







/**
 * Decide whether to add a template UI to an existing canvas and compute placement.
 *
 * - canvasJson: existing canvas JSON (may be empty/new)
 * - templateFamily: family string (e.g., "project")
 * - templateVersion: version string (e.g., "1.0.0")
 * - defaultStartX/defaultStartY: fallback origin if no existing group found
 *
 * Returns:
 * {
 *   shouldAdd: boolean,           // false if exact family+version already present
 *   startX: number,               // computed origin X for new UI (if shouldAdd true)
 *   startY: number,               // computed origin Y for new UI (if shouldAdd true)
 *   anchorNode?: any              // the highest-version group node found (if any)
 * }
 */
export function computePlacementForTemplate(
  canvasJson: any,
  templateFamily: string,
  templateVersion: string | null,
  defaultStartX = 80,
  defaultStartY = 80
) {
  // If exact family+version exists, don't add
  const exact = findTemplateMatchesInCanvas(canvasJson, templateFamily, templateVersion);
  if (exact.found) {
    return { shouldAdd: false, startX: defaultStartX, startY: defaultStartY };
  }

  // Prefer header node for placement (highest version header)
  const bestHeader = findHighestVersionHeaderNode(canvasJson, templateFamily);

  console.log("[z5Linter] computePlacementForTemplate (header-only):", {
    templateFamily,
    templateVersion,
    exactFound: exact.found,
    bestHeader: bestHeader ? { id: bestHeader.node.id, x: bestHeader.node.x, y: bestHeader.node.y, width: bestHeader.node.width } : null,
  });

  if (!bestHeader) {
    // No header found — place at provided defaults (treat defaults as header origin)
    return {
      shouldAdd: true,
      startX: Number(defaultStartX),
      startY: Number(defaultStartY),
    };
  }

  // Base placement on header coordinates only
  const h = bestHeader.node;
  const headerX = Number(h.x) || 0;
  const headerY = Number(h.y) || 0;
  const headerW = Number(h.width) || TEMPLATE_STACK_WIDTH;

  // Place new header to the right of previous header
  const newStartX = headerX + headerW + TEMPLATE_GROUP_HORIZONTAL_OFFSET;
  const newStartY = headerY;

  console.log("[z5Linter] computePlacementForTemplate -> using header anchor", { newStartX, newStartY });
  return { shouldAdd: true, startX: newStartX, startY: newStartY, anchorNode: h };
}





/**
 * Merge nodes/edges from newCanvas into baseCanvas in-place.
 * - baseCanvas: existing canvas JSON (mutated)
 * - newCanvas: canvas JSON returned by makeCanvasNodesForTemplate
 *
 * Returns the merged canvasJson (same object as baseCanvas).
 */
export function mergeCanvasJson(baseCanvas: any, newCanvas: any) {
  if (!baseCanvas || typeof baseCanvas !== "object") baseCanvas = { nodes: [], edges: [], metadata: {} };
  if (!Array.isArray(baseCanvas.nodes)) baseCanvas.nodes = [];
  if (!Array.isArray(baseCanvas.edges)) baseCanvas.edges = [];

  const existingNodeIds = new Set(baseCanvas.nodes.map((n: any) => n.id));
  const existingEdgeIds = new Set(baseCanvas.edges.map((e: any) => e.id));

  // Map of oldId -> newId for nodes we had to rename
  const idRemap: Record<string, string> = {};

  // Append nodes, remapping ids when necessary
  if (newCanvas && Array.isArray(newCanvas.nodes)) {
    for (const n of newCanvas.nodes) {
      if (!n || !n.id) n.id = uuidv4();
      if (!existingNodeIds.has(n.id)) {
        baseCanvas.nodes.push(n);
        existingNodeIds.add(n.id);
      } else {
        // collision: generate a new id and remember mapping
        const newId = uuidv4();
        idRemap[n.id] = newId;
        const copy = { ...n, id: newId };
        baseCanvas.nodes.push(copy);
        existingNodeIds.add(newId);
      }
    }
  }

  // Append edges, remapping fromNode/toNode if their node ids were remapped
  if (newCanvas && Array.isArray(newCanvas.edges)) {
    for (const e of newCanvas.edges) {
      if (!e || !e.id) e.id = uuidv4();

      // clone so we don't mutate original
      const edgeCopy: any = { ...e };

      // remap endpoints if needed
      if (edgeCopy.fromNode && idRemap[edgeCopy.fromNode]) edgeCopy.fromNode = idRemap[edgeCopy.fromNode];
      if (edgeCopy.toNode && idRemap[edgeCopy.toNode]) edgeCopy.toNode = idRemap[edgeCopy.toNode];

      if (!existingEdgeIds.has(edgeCopy.id)) {
        baseCanvas.edges.push(edgeCopy);
        existingEdgeIds.add(edgeCopy.id);
      } else {
        const newEdge = { ...edgeCopy, id: uuidv4() };
        baseCanvas.edges.push(newEdge);
        existingEdgeIds.add(newEdge.id);
      }
    }
  }

  // Merge metadata shallowly
  baseCanvas.metadata = Object.assign({}, baseCanvas.metadata || {}, newCanvas.metadata || {});

  return baseCanvas;
}





/**
 * Scan a folder (vault path) for markdown files whose frontmatter `template` (or template_name)
 * matches the requested family. Returns an array of objects:
 *   { path, frontmatter, templateFamily, templateVersion }
 *
 * - app: Obsidian App
 * - folderPath: vault-relative folder path (e.g., "testMigrationData/templates")
 * - family: template family to match (string)
 */
// TODO: recursive, or search multiple paths
export async function findTemplatesInFolderByFamily(
  app: App,
  folderPath: string,
  family: string
): Promise<{ path: string; frontmatter: Record<string,string>; templateFamily: string; templateVersion: string | null }[]> {
  const vault = app.vault;
  const out: { path: string; frontmatter: Record<string,string>; templateFamily: string; templateVersion: string | null }[] = [];

  // Try to list the folder; if it fails, return empty
  const listing = await vault.adapter.list(folderPath).catch(() => null);
  if (!listing || !Array.isArray(listing.files)) return out;

  // Iterate files in folder (non-recursive). Accept .md files only.
  for (const f of listing.files) {
    if (!f || typeof f !== "string") continue;
    if (!f.toLowerCase().endsWith(".md")) continue;
    const fullPath = `${folderPath.replace(/\/$/, "")}/${f.split("/").pop()}`;

    // Read file and parse frontmatter
    try {
      if (!(await vault.adapter.exists(fullPath))) continue;
      const raw = await vault.adapter.read(fullPath);
      const fm = parseFrontmatterSimple(raw);
      const tm = fm["template"] || fm["template_name"];
      if (!tm) continue;
      if (String(tm) !== String(family)) continue;

      const tv = fm["template_version"] || fm["version"] || null;
      out.push({ path: fullPath, frontmatter: fm, templateFamily: String(tm), templateVersion: tv });
    } catch (e) {
      // ignore unreadable files
      continue;
    }
  }

  // Sort by version ascending (older -> newer) using compareVersionStrings
  out.sort((a, b) => {
    const cmp = compareVersionStrings(a.templateVersion, b.templateVersion);
    return cmp;
  });

  return out;
}




/**
 * Create a simple header node placed above a group.
 *
 * - title: string to render (e.g., "## project V1.0.0")
 * - x,y,width,height: geometry (snapped by createCanvasNode)
 * - templateFamily/templateVersion: provenance metadata
 */
export function createHeaderNode(
  x: number,
  y: number,
  width = TEMPLATE_STACK_WIDTH,
  height = HEADING_NODE_HEIGHT,
  opts?: { id?: string; styleAttributes?: Record<string, any>; templateFamily?: string | null; templateVersion?: string | null }
) {
  const z5 = makeZ5Attrs(opts?.templateFamily ?? null, opts?.templateVersion ?? null, { role: "header" });


  const family = opts?.templateFamily ?? null;
  const version = opts?.templateVersion ?? null;

  const headerTitle = `## ${family} V${version}`;
  const toolbarCodeblock = makeToolbarCodeblock(family, version);

  const nodeText = `${headerTitle}\n\n${toolbarCodeblock}\n`;

  return createCanvasNode({
    x,
    y,
    width,
    height,
    type: "text",
    text: nodeText,
    metadata: { role: "header" },
    z5LinterAttributes: z5,
    styleAttributes: mergeStyleAttrs(DEFAULT_NODE_STYLE, opts?.styleAttributes),
    cellSize: CELL_SIZE,
    id: opts?.id,
  });
}



function mergeStyleAttrs(
  base: Record<string, any> | undefined,
  override: Record<string, any> | undefined
): Record<string, any> {
  return {
    ...(base ?? {}),
    ...(override ?? {}),
  };
}

















// TEMPLATE NODE REPAIR AND REFLOW


/**
 * Repair a single template migration block (family + version) inside an in-memory canvas JSON.
 *
 * Steps:
 *  1) Remove nodes that belong to the family/version but are invalid (missing role, family, or version).
 *  2) Build canonical nodes from the template file and add any nodes that are missing (header, frontmatter, area nodes, group, control, embed).
 *  3) Call reflowTemplateBlock to snap everything into canonical positions.
 *
 * Returns an object with counts: { removed, added }.
 */
/**
 * Repair a single template migration block (family + version) inside an in-memory canvas JSON.
 *
 * Steps:
 *  1) Remove nodes that belong to the family/version but are invalid (missing role, family, or version).
 *  2) Build canonical nodes from the template file and add any nodes that are missing (header, frontmatter, area nodes, group, control, embed).
 *  3) Reflow the block so geometry is correct.
 *  4) Ensure canonical in-block edges exist (header -> group -> control -> embed) and add any missing edges.
 *
 * Returns an object with counts: { removed, added, edgesAdded }.
 */
export async function repairMigrationBlock(
  app: App,
  canvasJson: any,
  templateFamily: string,
  templateVersion: string
): Promise<{ removed: number; added: number; edgesAdded: number }> {
  if (!canvasJson || !Array.isArray(canvasJson.nodes)) {
    throw new Error("Invalid canvas JSON");
  }

  // --- small helpers (local, robust) ---
  const readZ5 = (n: any) => n?.metadata?.z5LinterAttributes ?? {};
  const readMd = (n: any) => n?.metadata ?? {};
  const normStr = (v: any) => (v === null || typeof v === "undefined" ? "" : String(v).trim().toLowerCase());

  function readNodeAttrs(n: any) {
    const z5 = readZ5(n);
    const md = readMd(n);
    return {
      family: normStr(z5.templateFamily ?? md.templateFamily ?? ""),
      version: normStr(z5.templateVersion ?? md.templateVersion ?? ""),
      role: normStr(z5.role ?? md.role ?? n.type ?? ""),
      areaId: normStr(z5.areaId ?? md.areaId ?? ""),
    };
  }

  // --- 1) Remove clearly invalid nodes that claim to belong to this family/version but lack role/family/version ---
  let removed = 0;
  const kept: any[] = [];
  for (const n of canvasJson.nodes) {
    const z5 = readZ5(n);
    const md = readMd(n);

    const familyRaw = z5.templateFamily ?? md.templateFamily ?? null;
    const versionRaw = z5.templateVersion ?? md.templateVersion ?? null;
    const roleRaw = z5.role ?? md.role ?? n.type ?? null;

    // If node does not belong to this family/version, keep it
    if (normStr(familyRaw) !== normStr(templateFamily) || normStr(versionRaw) !== normStr(templateVersion)) {
      kept.push(n);
      continue;
    }

    // Node belongs to this family/version — validate presence of role/family/version
    const hasFamily = typeof familyRaw === "string" && familyRaw.trim().length > 0;
    const hasVersion = typeof versionRaw === "string" && String(versionRaw).trim().length > 0;
    const hasRole = typeof roleRaw === "string" && roleRaw.trim().length > 0;

    // If any required piece missing, drop the node (clear it)
    if (!hasFamily || !hasVersion || !hasRole) {
      removed++;
      continue;
    }

    // Otherwise keep
    kept.push(n);
  }

  // Replace nodes array with kept nodes
  canvasJson.nodes = kept;

  // --- 2) Collect existing nodes for this template (normalized) ---
  const targetFamilyNorm = normStr(templateFamily);
  const targetVersionNorm = normStr(templateVersion);

  // Defensive: ensure metadata objects exist so later code can mirror attributes
  for (const n of canvasJson.nodes) {
    n.metadata = n.metadata || {};
    n.metadata.z5LinterAttributes = Object.assign({}, n.metadata.z5LinterAttributes || {});
  }

  const existingNodesForTemplate = canvasJson.nodes.filter((n: any) => {
    const attrs = readNodeAttrs(n);
    return attrs.family === targetFamilyNorm && attrs.version === targetVersionNorm;
  });

  console.debug(`[z5Linter] existingNodesForTemplate count=${existingNodesForTemplate.length} for ${templateFamily} v${templateVersion}`);

  // --- 3) Determine anchor and build fresh canonical nodes ---
  // Prefer existing header position as anchor if present; repair will force reposition later.
  const headerNode = existingNodesForTemplate.find(n => {
    const a = readNodeAttrs(n);
    return a.role === "header";
  });
  const anchorX = headerNode ? Number(headerNode.x) || 80 : 80;
  const anchorY = headerNode ? Number(headerNode.y) || 80 : 80;

  const templatePath = await findTemplatePathForFamilyVersion(app, templateFamily, templateVersion);
  if (!templatePath) {
    throw new Error(`Template file not found for ${templateFamily} v${templateVersion}`);
  }

  const freshCanvas = await makeCanvasNodesForTemplate(app, templatePath, anchorX, anchorY);
  const freshNodes: any[] = freshCanvas.nodes || [];

  // --- 4) Build normalized key maps for existing nodes ---
  const existingByKey = new Map<string, any>();
  for (const n of existingNodesForTemplate) {
    const attrs = readNodeAttrs(n);
    let key = attrs.role || (n.type || "").toLowerCase();
    if (attrs.role === "area") key += `:${attrs.areaId}`;
    existingByKey.set(key, n);
  }

  // --- 5) Add any missing canonical nodes (and mirror metadata for existing ones) ---
  let added = 0;
  for (const f of freshNodes) {
    const z5f = f?.metadata?.z5LinterAttributes ?? {};
    const mdf = f?.metadata ?? {};
    const roleRaw = z5f.role ?? mdf.role ?? f.type ?? "";
    const areaIdRaw = z5f.areaId ?? mdf.areaId ?? "";
    const role = normStr(roleRaw);
    const areaId = normStr(areaIdRaw);
    let key = role || (f.type || "").toLowerCase();
    if (role === "area") key += `:${areaId}`;

    if (!existingByKey.has(key)) {
      // Add the fresh node into the canvas (preserve id from fresh node)
      const nodeToAdd = { ...f };
      nodeToAdd.metadata = Object.assign({}, nodeToAdd.metadata || {});
      nodeToAdd.metadata.z5LinterAttributes = Object.assign({}, nodeToAdd.metadata.z5LinterAttributes || {});
      // Mirror role into metadata.role for consistency
      if (!nodeToAdd.metadata.role && nodeToAdd.metadata.z5LinterAttributes?.role) {
        nodeToAdd.metadata.role = nodeToAdd.metadata.z5LinterAttributes.role;
      }
      canvasJson.nodes.push(nodeToAdd);
      existingByKey.set(key, nodeToAdd); // so subsequent fresh nodes see it
      added++;
    } else {
      // Ensure metadata is mirrored into existing node (defensive)
      const existing = existingByKey.get(key);
      existing.metadata = existing.metadata || {};
      existing.metadata.z5LinterAttributes = Object.assign({}, existing.metadata.z5LinterAttributes || {}, f.metadata?.z5LinterAttributes || {});
      if (!existing.metadata.role && existing.metadata.z5LinterAttributes?.role) {
        existing.metadata.role = existing.metadata.z5LinterAttributes.role;
      }
    }
  }

  // --- 6) Force reflow so geometry is canonical (repair should restore positions) ---
  // Use forceReposition true so header + children are placed according to canonical template.
  await reflowTemplateBlock(app, canvasJson, templateFamily, templateVersion);

  // --- 7) Ensure canonical in-block edges exist and get count ---
  const edgesAdded = ensureTemplateEdges(canvasJson, templateFamily, templateVersion);

  // --- 8) Return counts (structural results only) ---
  return { removed, added, edgesAdded };
}





// fixes positioning for a specific template family and version
export async function reflowTemplateBlock(
  app: App,
  canvasJson: any,
  templateFamily: string,
  templateVersion: string
) {
  if (!canvasJson || !Array.isArray(canvasJson.nodes)) {
    throw new Error("Invalid canvas JSON");
  }

  const readZ5 = (n: any) => n?.metadata?.z5LinterAttributes ?? {};
  const readMd = (n: any) => n?.metadata ?? {};
  const normStr = (v: any) => (v === null || typeof v === "undefined" ? "" : String(v).trim().toLowerCase());

  // 1) Collect all nodes belonging to this template version (robust lookup)
  const nodes = canvasJson.nodes.filter(n => {
    const z5 = readZ5(n);
    const md = readMd(n);
    const family = normStr(z5.templateFamily ?? md.templateFamily ?? "");
    const version = normStr(z5.templateVersion ?? md.templateVersion ?? "");
    return family === normStr(templateFamily) && version === normStr(templateVersion);
  });

  if (!nodes.length) {
    console.warn(`[z5Linter] reflowTemplateBlock: no nodes found for ${templateFamily} v${templateVersion}`);
    return;
  }

  // 2) Build fresh canonical layout at origin so we have stable canonical positions
  const templatePath = await findTemplatePathForFamilyVersion(app, templateFamily, templateVersion);
  if (!templatePath) {
    throw new Error(`Template file not found for ${templateFamily} v${templateVersion}`);
  }

  const freshAtOrigin = await makeCanvasNodesForTemplate(app, templatePath, 0, 0);
  const freshNodes = (freshAtOrigin.nodes || []).map((n: any) => ({ ...n }));

  // 3) Find fresh canonical header (source anchor)
  const freshHeader = freshNodes.find((n: any) => {
    const z5 = n?.metadata?.z5LinterAttributes ?? {};
    const md = n?.metadata ?? {};
    const role = (z5.role ?? md.role ?? n.type) ?? "";
    return role === "header";
  });

  if (!freshHeader) {
    console.warn(`[z5Linter] reflowTemplateBlock: fresh header not found for ${templateFamily} v${templateVersion}`);
    return;
  }

  const freshAnchorX = Number(freshHeader.x) || 0;
  const freshAnchorY = Number(freshHeader.y) || 0;

  // 4) Determine target anchor: prefer existing header position if present, otherwise use canonical header
  const existingHeader = nodes.find(n => {
    const z5 = readZ5(n);
    const md = readMd(n);
    const role = (z5.role ?? md.role ?? n.type) ?? "";
    return role === "header";
  });

  const targetAnchorX = existingHeader ? Number(existingHeader.x) || 0 : Number(freshHeader.x) || 0;
  const targetAnchorY = existingHeader ? Number(existingHeader.y) || 0 : Number(freshHeader.y) || 0;

  // Compute translation from fresh origin to target anchor
  const offsetX = targetAnchorX - freshAnchorX;
  const offsetY = targetAnchorY - freshAnchorY;

  // 5) Build freshByKey map (role + optional areaId) and translate positions into target space
  const freshByKey = new Map<string, any>();
  for (const fn of freshNodes) {
    const z5 = fn?.metadata?.z5LinterAttributes ?? {};
    const md = fn?.metadata ?? {};
    const role = (z5.role ?? md.role ?? fn.type ?? "") ?? "";
    const areaId = (z5.areaId ?? md.areaId ?? "") ?? "";
    let key = role || (fn.type || "").toLowerCase();
    if (role === "area") key += `:${areaId}`;

    const translated = { ...fn };
    translated.x = (Number(fn.x) || 0) + offsetX;
    translated.y = (Number(fn.y) || 0) + offsetY;
    freshByKey.set(key, translated);
  }

  // 6) Apply fresh geometry to existing nodes (unconditionally overwrite when mapping exists)
  for (const oldNode of nodes) {
    // Defensive metadata shape
    oldNode.metadata = oldNode.metadata || {};
    oldNode.metadata.z5LinterAttributes = Object.assign({}, oldNode.metadata.z5LinterAttributes || {});

    const z5 = oldNode.metadata.z5LinterAttributes;
    const md = oldNode.metadata;
    const role = (z5.role ?? md.role ?? oldNode.type ?? "") ?? "";
    const areaId = (z5.areaId ?? md.areaId ?? "") ?? "";
    let key = role || (oldNode.type || "").toLowerCase();
    if (role === "area") key += `:${areaId}`;

    const freshNode = freshByKey.get(key);
    if (!freshNode) {
      // no canonical mapping for this node; skip
      continue;
    }

    // Overwrite geometry to canonical values
    oldNode.x = Number(freshNode.x);
    oldNode.y = Number(freshNode.y);
    oldNode.width = Number(freshNode.width) || oldNode.width;
    oldNode.height = Number(freshNode.height) || oldNode.height;

    // Merge style attributes: canonical defaults then preserve any user overrides
    oldNode.styleAttributes = mergeStyleAttrs(DEFAULT_NODE_STYLE, oldNode.styleAttributes);

    // Mirror canonical z5 attrs into existing node metadata for consistency
    oldNode.metadata.z5LinterAttributes = Object.assign({}, oldNode.metadata.z5LinterAttributes || {}, freshNode.metadata?.z5LinterAttributes || {});
    if (!oldNode.metadata.role && oldNode.metadata.z5LinterAttributes?.role) {
      oldNode.metadata.role = oldNode.metadata.z5LinterAttributes.role;
    }
  }

  // 7) Recompute group geometry (if group exists)
  const group = nodes.find(n => n.type === "group" || (readZ5(n).role === "group") || (readMd(n).role === "group"));
  if (group) {
    const children = nodes.filter(n => {
      const role = (readZ5(n).role ?? readMd(n).role ?? n.type) ?? "";
      return role === "frontmatter" || role === "area";
    });

    if (children.length) {
      const newGroup = makeGroupForNodes(children, { templateFamily, templateVersion });
      if (newGroup) {
        group.x = newGroup.x;
        group.y = newGroup.y;
        group.width = newGroup.width;
        group.height = newGroup.height;
      }
    } else {
      console.debug(`[z5Linter] reflowTemplateBlock: no children to rebuild group for ${templateFamily} v${templateVersion}`);
    }
  }

  console.log(`[z5Linter] Reflowed ${templateFamily} v${templateVersion}`);
}



async function findTemplatePathForFamilyVersion(app: App, family: string, version: string) {
  const folder = "testMigrationData/templates";
  const list = await findTemplatesInFolderByFamily(app, folder, family);
  const match = list.find(t => t.templateVersion === version);
  return match?.path ?? null;
}




/** Normalize an edge object into canonical fields we care about */
function normalizeEdgeObj(edge: any) {
  if (!edge || typeof edge !== "object") return null;
  const fId = edge.fromNode ?? edge.fromId ?? edge.from ?? edge.fromNodeId ?? edge.source ?? edge.start ?? null;
  const tId = edge.toNode ?? edge.toId ?? edge.to ?? edge.toNodeId ?? edge.target ?? edge.end ?? null;
  const fSide = edge.fromSide ?? edge.startSide ?? edge.sourceSide ?? edge.startAnchor ?? edge.startHandle ?? null;
  const tSide = edge.toSide ?? edge.endSide ?? edge.targetSide ?? edge.endAnchor ?? edge.endHandle ?? null;
  return { fId: fId ? String(fId) : null, tId: tId ? String(tId) : null, fSide: fSide ? String(fSide) : null, tSide: tSide ? String(tSide) : null };
}

/** Remove duplicate edges from canvasJson.edges (keeps first occurrence) */
function dedupeCanvasEdges(canvasJson: any) {
  if (!canvasJson || !Array.isArray(canvasJson.edges)) return 0;
  const seen = new Set<string>();
  const out: any[] = [];
  let removed = 0;
  for (const e of canvasJson.edges) {
    const ex = normalizeEdgeObj(e);
    if (!ex || !ex.fId || !ex.tId) {
      // keep malformed edges as-is
      out.push(e);
      continue;
    }
    // canonical key: id-only (we prefer id-only dedupe)
    const key = `${ex.fId}->${ex.tId}${(ex.fSide || ex.tSide) ? `|${ex.fSide}->${ex.tSide}` : ""}`;
    if (seen.has(key)) {
      removed++;
      continue;
    }
    seen.add(key);
    out.push(e);
  }
  canvasJson.edges = out;
  return removed;
}

function edgeExistsByNodeIds(canvasJson: any, fromId: string, toId: string) {
  if (!canvasJson || !Array.isArray(canvasJson.edges)) return false;
  for (const e of canvasJson.edges) {
    const ex = normalizeEdgeObj(e);
    if (!ex || !ex.fId || !ex.tId) continue;
    if (String(ex.fId) === String(fromId) && String(ex.tId) === String(toId)) return true;
  }
  return false;
}


export function ensureTemplateEdges(
  canvasJson: any,
  templateFamily: string,
  templateVersion: string
): number {
  if (!canvasJson || !Array.isArray(canvasJson.nodes)) throw new Error("Invalid canvas JSON");

  const readZ5 = (n: any) => n?.metadata?.z5LinterAttributes ?? {};
  const readMd = (n: any) => n?.metadata ?? {};

  // collect nodes for this template
  const nodesForTemplate = (canvasJson.nodes || []).filter((n: any) => {
    const z5 = readZ5(n);
    const md = readMd(n);
    const family = (z5.templateFamily ?? md.templateFamily) ?? null;
    const version = (z5.templateVersion ?? md.templateVersion) ?? null;
    return family === templateFamily && version === templateVersion;
  });

  if (!nodesForTemplate.length) return 0;

  // find canonical nodes (try z5 role first, then metadata.role, then type)
  const findByRole = (role: string, areaId?: string) => {
    return nodesForTemplate.find((n: any) => {
      const z5 = readZ5(n);
      const md = readMd(n);
      const r = (z5.role ?? md.role ?? n.type) ?? "";
      if (role !== "area") return r === role;
      if (r !== "area") return false;
      if (typeof areaId === "undefined") return true;
      const aId = (z5.areaId ?? md.areaId ?? "");
      return String(aId) === String(areaId);
    });
  };

  const header = findByRole("header");
  const group = nodesForTemplate.find((n: any) => n.type === "group" || (readZ5(n).role === "group") || (readMd(n).role === "group"));
  const control = findByRole("control");
  const embed = findByRole("embedded-template") || findByRole("embedded") || nodesForTemplate.find((n: any) => (readMd(n).role === "embedded-template"));

  const desiredEdges: Array<{ from: any; fromSide: string; to: any; toSide: string; opts?: any }> = [];
  if (header && group) desiredEdges.push({ from: header, fromSide: "bottom", to: group, toSide: "top", opts: { arrow: "none", arrowStyle: "blunt", pathfinding: "direct" } });
  if (group && control) desiredEdges.push({ from: group, fromSide: "bottom", to: control, toSide: "top", opts: { arrow: "bi", arrowStyle: "blunt", pathfinding: "direct" } });
  if (control && embed) desiredEdges.push({ from: control, fromSide: "bottom", to: embed, toSide: "top", opts: { arrow: "bi", arrowStyle: "blunt", pathfinding: "direct" } });

  if (!Array.isArray(canvasJson.edges)) canvasJson.edges = [];

  // Clean up any pre-existing exact duplicates first (helps with historical duplicates)
  const removedBefore = dedupeCanvasEdges(canvasJson);
  if (removedBefore > 0) {
    console.debug(`[z5Linter] ensureTemplateEdges removed ${removedBefore} pre-existing duplicate edges`);
  }

  const edgesAdded: any[] = [];

  for (const d of desiredEdges) {
    const fromId = String(d.from.id);
    const toId = String(d.to.id);

    // Simple, robust existence check: if any edge already connects these two node ids, skip.
    if (edgeExistsByNodeIds(canvasJson, fromId, toId)) {
      continue;
    }

    // Not present — create a new edge via your helper
    try {
      const newEdge = createEdge(d.from, d.fromSide, d.to, d.toSide, d.opts || {});

      // Normalize the new edge to include canonical id fields used in your canvas
      const normalized: any = Object.assign({}, newEdge);
      normalized.fromId = normalized.fromId ?? normalized.from ?? normalized.fromNode ?? normalized.fromNodeId ?? normalized.source ?? normalized.start ?? fromId;
      normalized.toId = normalized.toId ?? normalized.to ?? normalized.toNode ?? normalized.toNodeId ?? normalized.target ?? normalized.end ?? toId;
      // ensure the canvas-style fields are present too
      normalized.fromNode = normalized.fromNode ?? normalized.fromId;
      normalized.toNode = normalized.toNode ?? normalized.toId;

      normalized.fromSide = normalized.fromSide ?? normalized.startSide ?? normalized.sourceSide ?? normalized.startAnchor ?? normalized.startHandle ?? d.fromSide;
      normalized.toSide = normalized.toSide ?? normalized.endSide ?? normalized.targetSide ?? normalized.endAnchor ?? normalized.endHandle ?? d.toSide;

      normalized.fromId = String(normalized.fromId);
      normalized.toId = String(normalized.toId);

      edgesAdded.push(normalized);

      // Also update canvasJson.edges immediately so subsequent desiredEdges see it
      canvasJson.edges.push(normalized);
    } catch (err) {
      console.warn("[z5Linter] Failed to create edge for", { fromId, toId, err });
    }
  }

  // Final dedupe pass (keeps first occurrence)
  const removedAfter = dedupeCanvasEdges(canvasJson);
  if (removedAfter > 0) {
    console.debug(`[z5Linter] ensureTemplateEdges removed ${removedAfter} duplicate edges during final dedupe`);
  }

  return edgesAdded.length;
}









// canvas validation


/**
 * Scan canvasJson and mark nodes with missing templateFamily or templateVersion.
 * - A node is considered valid if either:
 *   - node.metadata.z5LinterAttributes.templateFamily and .templateVersion are present (non-empty), OR
 *   - node.metadata.templateFamily and node.metadata.templateVersion are present (non-empty)
 * - Invalid nodes get node.color = "1"
 *
 * Returns the number of nodes marked (changed).
 */
export function scanAndMarkInvalidTemplateNodes(canvasJson: any): number {
  if (!canvasJson || !Array.isArray(canvasJson.nodes)) {
    throw new Error("Invalid canvas JSON");
  }

  let changed = 0;

  for (const node of canvasJson.nodes) {
    // Skip nodes that are not objects
    if (!node || typeof node !== "object") continue;

    const z5 = node?.metadata?.z5LinterAttributes;
    const md = node?.metadata;

    const family = (z5 && z5.templateFamily) || md?.templateFamily;
    const version = (z5 && z5.templateVersion) || md?.templateVersion;

    const hasFamily = typeof family === "string" && family.trim().length > 0;
    const hasVersion = typeof version === "string" && version.trim().length > 0;

    const isValid = hasFamily && hasVersion;

    // If invalid, mark red by setting color = "1"
    if (!isValid) {
      if (node.color !== "1") {
        node.color = "1";
        changed++;
      }
    } else {
      // If previously marked and now valid, optionally clear the color.
      // Comment out the next block if you prefer to leave existing color alone.
      if (node.color === "1") {
        delete node.color;
        changed++;
      }
    }
  }

  return changed;
}




// returns the path for the migration canvas from the provided migration family name
function getCanvasPathForMigration(migrationName: string): string {
  // implement mapping logic or lookup table
  return `testMigrationData/${migrationName}.canvas`;
}


// Normalize a value to a canonical string for comparisons
function normStr(v: any): string {
  if (v === null || typeof v === "undefined") return "";
  return String(v).trim().toLowerCase();
}

// Read family/version/role/areaId from a node robustly and normalize them
function readNodeAttrs(n: any) {
  const z5 = n?.metadata?.z5LinterAttributes ?? {};
  const md = n?.metadata ?? {};
  const familyRaw = z5.templateFamily ?? md.templateFamily ?? "";
  const versionRaw = z5.templateVersion ?? md.templateVersion ?? "";
  const roleRaw = z5.role ?? md.role ?? n.type ?? "";
  const areaIdRaw = z5.areaId ?? md.areaId ?? "";
  return {
    family: normStr(familyRaw),
    version: normStr(versionRaw),
    role: normStr(roleRaw),
    areaId: normStr(areaIdRaw),
  };
}
