import { App, Notice, Plugin } from "obsidian";
import { v4 as uuidv4 } from "uuid";




// Visual/layout constants
export const GROUP_MARGIN_PX = 10;        // margin around groups (pixels)
export const GROUP_CARD_Y_GAP = 0;       // default vertical gap between cards inside a group
export const FRONTMATTER_NODE_HEIGHT = 60;   // height of the frontmatter node (px)
export const AREA_NODE_HEIGHT = 60;         // height of each area card node (px)
export const EMBED_NODE_HEIGHT = 1200;        // minimum height of the embedded-template node (px)
export const MAJOR_VERTICAL_SPACING = 40;          // vertical spacing between stacked items (px)
export const CONTROL_NODE_HEIGHT = 80; // height of the control node (px)

// Horizontal spacing to place a new template group to the right of the highest-version group
export const TEMPLATE_GROUP_HORIZONTAL_OFFSET = 480;


// Callout style tokens used when rendering callout blocks inside text nodes.
// Valid values are freeform strings; common choices: "info", "note", "tip", "warning", "danger".
export const FRONTMATTER_CALLOUT_TYPE = "warning";
export const AREA_CALLOUT_TYPE = "info";

// Explicit width for area nodes (so group width is predictable)
export const AREA_NODE_WIDTH = 360;

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

  let groupLabel: string;
  if (templateName) {
    groupLabel = templateVersion ? `${templateName} v${templateVersion}` : String(templateName);
  } else {
    const base = templatePath.split("/").pop() || templatePath;
    const baseName = base.replace(/\.md$/i, "");
    const family = deriveFamilyFromBasename(baseName);
    groupLabel = templateVersion ? `${family} v${templateVersion}` : family;
  }

  // Use startX/startY directly as the origin, but subtract the group margin (snapped to grid)
  const snappedGroupMargin = Math.max(0, Math.round(GROUP_MARGIN_PX / CELL_SIZE) * CELL_SIZE);

  // Subtract the snapped margin once so the group (which expands by margin) aligns with the area nodes
  const originX = Math.max(0, Number(startX) - snappedGroupMargin);
  const originY = Math.max(0, Number(startY) - snappedGroupMargin);


  // 1) Frontmatter node (top)
  const fmNode = createFrontmatterNode(front, originX, originY, {
    templateFamily,
    templateVersion,
    id: undefined,
    styleAttributes: undefined,
  });

  // 2) Area nodes and group (area column starts below frontmatter)
  const areaBaseY = originY + FRONTMATTER_NODE_HEIGHT + GROUP_CARD_Y_GAP;
  const { groupNode: builtGroupNode, areaNodes } = buildAreaGroupNodes(
    areas,
    originX,
    areaBaseY,
    { labelLine: true, templateFamily, templateVersion }
  );

  const allNodesForGroup = [fmNode, ...areaNodes];

  const finalGroupNode = makeGroupForNodes(allNodesForGroup, {
    label: groupLabel,
    templateFamily,
    templateVersion,
  });

  const groupNode = finalGroupNode ? { ...finalGroupNode, label: groupLabel } : null;

  // 3) Append group and group members to canvasJson (group first so it encloses the nodes)
  if (groupNode) appendNodesToCanvasJson(canvasJson, groupNode);
  appendNodesToCanvasJson(canvasJson, allNodesForGroup);

  // 4) Control node (below group)
  const controlX = groupNode ? Number(groupNode.x) || originX : originX;
  const controlWidth = groupNode ? Number(groupNode.width) || AREA_NODE_WIDTH : AREA_NODE_WIDTH;
  const controlYBase = groupNode
    ? (Number(groupNode.y) || originY) + (Number(groupNode.height) || 0)
    : (areaBaseY + areaNodes.length * (AREA_NODE_HEIGHT + GROUP_CARD_Y_GAP));
  const controlY = controlYBase + MAJOR_VERTICAL_SPACING;

  const controlNode = createControlNode(controlX, controlY, controlWidth, CONTROL_NODE_HEIGHT, CELL_SIZE, {
    templateFamily,
    templateVersion,
  });

  // 5) Embed node (wiki embed) placed below control node
  const embedNode = await createEmbedNode(
    app,
    templatePath,
    groupNode,
    controlNode,
    originX,
    originY,
    AREA_NODE_WIDTH,
    MAJOR_VERTICAL_SPACING,
    CELL_SIZE,
    EMBED_NODE_HEIGHT,
    templateFamily,
    templateVersion
  );

  // 6) Append control and embed nodes
  appendNodesToCanvasJson(canvasJson, controlNode);
  appendNodesToCanvasJson(canvasJson, embedNode);

  // 7) Create edges (group -> control, control -> embed)
  const edgesToAdd: any[] = [];
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
    templateVersion?: string
  }
) {
  const areaNodes: any[] = [];
  const labelLine = opts?.labelLine ?? true;

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
      width: AREA_NODE_WIDTH,
      height: AREA_NODE_HEIGHT,
      type: "text",
      text: finalCallout,
      metadata: {
        areaId: a.id,
        areaLabel: a.label,
        source: "template",
      },
      z5LinterAttributes: makeZ5Attrs(
        opts?.templateFamily ?? null,
        opts?.templateVersion ?? null,
        { role: "area", areaId: a.id, areaLabel: a.label }),
      cellSize: CELL_SIZE,
    });
    areaNodes.push(node);
  }
  const group = makeGroupForNodes(areaNodes, {
    label: `Areas`,
    templateFamily: opts?.templateFamily,
    templateVersion: opts?.templateVersion,
  });
  return { groupNode: group, areaNodes };
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
    label?: string;
    templateFamily?: string;
    templateVersion?: string;}
) {
  if (!nodes || nodes.length === 0) return null;

  const label = opts?.label ?? "Group";

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

  // Build group node (Canvas expects label property rather than text)
  const groupNode: any = {
    id: uuidv4(),
    type: "group",
    x: groupRect.x,
    y: groupRect.y,
    width: groupRect.width,
    height: groupRect.height,
    label,
    styleAttributes: {},
    metadata: {
      z5LinterAttributes: makeZ5Attrs(opts?.templateFamily ?? null, opts?.templateVersion ?? null, { role: "group", label })
    },
  };


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

  // Prefer explicit z5LinterAttributes if provided; otherwise build minimal attrs from template info.
  const z5Attrs =
    opts?.z5LinterAttributes ??
    makeZ5Attrs(opts?.templateFamily ?? null, opts?.templateVersion ?? null, { role: "frontmatter" });

  return createCanvasNode({
    x: x,
    y: y,
    width: AREA_NODE_WIDTH,
    height: FRONTMATTER_NODE_HEIGHT,
    type: "text",
    text: text,
    metadata: { role: "frontmatter" },
    z5LinterAttributes: z5Attrs,
    styleAttributes: opts?.styleAttributes ?? {},
    cellSize: CELL_SIZE,
    id: opts?.id,
  });
}








/**
 * Create an embed node containing the full raw template text.
 *
 * - app: Obsidian App (used to read the template file)
 * - templatePath: path to the markdown template to embed
 * - groupNode: the group node that the embed should align with (may be null)
 * - baseX/baseY/cardWidth/yGap/cellSize: layout params used as fallbacks
 * - minHeight: minimum height for the embed node (default 400)
 *
 * Returns a Canvas node object (does not write to disk).
 */
/**
 * Create an embed node that contains a wiki-style embed to the template file.
 *
 * - app: Obsidian App (used only to validate file existence optionally)
 * - templatePath: path to the markdown template to embed (used verbatim inside ![[...]])
 * - groupNode: the group node that the embed should align with (may be null)
 * - baseX/baseY/fallbackWidth/yGap/cellSize: layout params used as fallbacks
 * - minHeight: minimum height for the embed node (default EMBED_NODE_HEIGHT)
 *
 * Returns a Canvas node object (does not write to disk).
 */
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
    ? (Number(anchorNode.width) || (groupNode ? Number(groupNode.width) || AREA_NODE_WIDTH : AREA_NODE_WIDTH))
    : (groupNode ? Number(groupNode.width) || AREA_NODE_WIDTH : AREA_NODE_WIDTH);

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
    metadata: { role: "embedded-template", sourceFile: templatePath },
    z5LinterAttributes: makeZ5Attrs(templateFamily ?? null, templateVersion ?? null, { role: "embedded-template", sourceFile: templatePath }),
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
  opts?: { id?: string; styleAttributes?: Record<string, any>; templateFamily?: string; templateVersion?: string; z5LinterAttributes?: Record<string, any> }
) {
  return createCanvasNode({
    x,
    y,
    width,
    height: CONTROL_NODE_HEIGHT,
    type: "text",
    text: "", // blank for now
    metadata: { role: "control" },
    styleAttributes: opts?.styleAttributes ?? {},
    z5LinterAttributes: opts?.z5LinterAttributes ?? makeZ5Attrs(opts?.templateFamily ?? null, opts?.templateVersion ?? null, { role: "control" }),
    cellSize: CELL_SIZE,
    id: opts?.id,
  });
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
 * Find the group node with the highest templateVersion for a given family.
 * - canvasJson: object with nodes array
 * - family: template family to search
 *
 * Returns the node and its version string, or null if none found.
 */
export function findHighestVersionGroupNode(canvasJson: any, family: string) {
  if (!canvasJson || !Array.isArray(canvasJson.nodes)) return null;

  let bestNode: any = null;
  let bestVersion: string | null = null;

  for (const node of canvasJson.nodes) {
    if (!node || node.type !== "group") continue; // <-- only groups
    const z = getZ5Attrs(node);
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

  // Find highest-version group node (groups only)
  const best = findHighestVersionGroupNode(canvasJson, templateFamily);

  // Snapped group margin (same logic as makeGroupForNodes)
  const snappedGroupMargin = Math.max(0, Math.round(GROUP_MARGIN_PX / CELL_SIZE) * CELL_SIZE);

  if (!best) {
    // No existing family found — place at defaults (subtract margin so group encloses correctly)
    return {
      shouldAdd: true,
      startX: Math.max(0, Number(defaultStartX) - snappedGroupMargin),
      startY: Math.max(0, Number(defaultStartY) - snappedGroupMargin),
    };
  }

  // Place to the right of the highest-version group node (align vertically with the group)
  const node = best.node;
  const nodeX = Number(node.x) || 0;
  const nodeY = Number(node.y) || 0;
  const nodeW = Number(node.width) || 0;

  const newStartX = nodeX + nodeW + TEMPLATE_GROUP_HORIZONTAL_OFFSET - snappedGroupMargin;
  const newStartY = Math.max(0, nodeY - snappedGroupMargin);

  return { shouldAdd: true, startX: newStartX, startY: newStartY, anchorNode: node };
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
