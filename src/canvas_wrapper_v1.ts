// canvas_wrapper.ts
import { App, Notice, Plugin } from "obsidian";
import { v4 as uuidv4 } from "uuid";

/**
 * Canvas utilities and creators for z5Linter migration prototyping.
 *
 * Exports:
 *  - createCanvas
 *  - addMarkdownToCanvas
 *  - createCanvasFromMarkdown
 *  - snapToGrid
 *  - snapRect
 *  - makeGroupForNodes
 *
 * Usage:
 *  - registerCanvasCommand(this.app, this) from plugin onload to create a test canvas.
 */


/** Option: vertical gap between label node and card node (pixels) */
const LABEL_GAP = -20;


/* -------------------- Command registration -------------------- */

export function registerCanvasCommand(app: App, plugin: Plugin) {
  plugin.addCommand({
    id: "z5-create-test-canvas-template-v1",
    name: "z5Linter: Create test canvas (template v1)",
    callback: async () => {
      try {
        const folder = "testMigrationData";
        const filename = "project-template-v1.canvas";
        const path = `${folder}/${filename}`;
        const template = "testMigrationData/templates/template_project_v1.md";

        await createCanvasFromMarkdown(app, template, path);
        new Notice(`Created test canvas: ${path}`);
      } catch (e) {
        console.error("Failed to create canvas", e);
        new Notice("Failed to create test canvas (see console)");
      }
    },
  });
}

/* -------------------- Grid helpers (exported) -------------------- */

/** Snap a number to nearest multiple of cell (round) */
export function snapToGrid(value: number, cell = 20) {
  return Math.round(value / cell) * cell;
}

/** Snap rectangle so x,y are snapped and width/height are multiples of cell */
export function snapRect(rect: { x: number; y: number; width: number; height: number }, cell = 20) {
  const snappedX = snapToGrid(rect.x, cell);
  const snappedY = snapToGrid(rect.y, cell);
  const snappedW = Math.max(cell, Math.round(rect.width / cell) * cell);
  const snappedH = Math.max(cell, Math.round(rect.height / cell) * cell);
  return { x: snappedX, y: snappedY, width: snappedW, height: snappedH };
}

/**
 * Create a group node that encloses the provided nodes.
 * Returns a Canvas-compatible group node or null if nodes empty.
 */
export function makeGroupForNodes(nodes: any[], marginPx = 16, label = "Group", cellSize = 20) {
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
  const margin = Math.max(cellSize, Math.round(marginPx / cellSize) * cellSize);
  minX -= margin;
  minY -= margin;
  maxX += margin;
  maxY += margin;

  // Snap group rect to grid
  const groupRect = snapRect({ x: minX, y: minY, width: maxX - minX, height: maxY - minY }, cellSize);

  const group = {
    id: uuidv4(),
    type: "group",
    x: groupRect.x,
    y: groupRect.y,
    width: groupRect.width,
    height: groupRect.height,
    label,
    styleAttributes: {},
  };
  return group;
}

/* -------------------- Core canvas writer -------------------- */

/**
 * Create a canvas file from provided nodes/edges/metadata.
 * - nodes: array of canvas nodes (already snapped)
 * - edges: array of edges (can be empty)
 * - metadata: object for metadata (title, version, etc.)
 * - overwrite: if true, will modify existing file; otherwise fails if exists
 */
export async function writeCanvas(
  app: App,
  outCanvasPath: string,
  nodes: any[],
  edges: any[] = [],
  metadata: any = { version: "1.0-1.0", frontmatter: {} },
  overwrite = false
) {
  const vault = app.vault;
  const outExists = await vault.adapter.exists(outCanvasPath);

  const canvasJson: any = {
    nodes,
    edges,
    metadata,
  };

  const content = JSON.stringify(canvasJson, null, 2);

  if (outExists) {
    if (!overwrite) {
      throw new Error(`Canvas file already exists at ${outCanvasPath}. Delete it or call with overwrite=true.`);
    }
    // modify existing file
    await vault.modify(await vault.getAbstractFileByPath(outCanvasPath) as any, content);
  } else {
    // ensure parent folder exists (best-effort)
    const parts = outCanvasPath.split("/");
    if (parts.length > 1) {
      const folder = parts.slice(0, -1).join("/");
      try {
        const list = await vault.adapter.list(folder).catch(() => null);
        if (!list) {
          await vault.create(`${folder}/.keep`, "z5Linter test data folder");
        }
      } catch (e) {
        // ignore
      }
    }
    await vault.create(outCanvasPath, content);
  }
}

/* -------------------- Markdown -> Canvas append logic -------------------- */

/**
 * Parse a markdown file for "## " headings and append a column of snapped nodes
 * into the canvas at outCanvasPath.
 *
 * Options:
 *  - offsetX number (default 0) horizontal offset to place the column (useful for side-by-side)
 *  - cellSize number (default 20)
 *  - cardWidth number (default 320)
 *  - cardHeight number (default 100)
 *  - yStart number (default 80)
 *  - yGap number (default 20)
 *  - groupLabel string (default "Template Group")
 *  - overwrite boolean (if true, will overwrite existing canvas when writing merged result)
 *  - createIfMissing boolean (default false) — if true, create a minimal canvas when target is missing
 *
 * Behavior:
 *  - If createIfMissing is false and the target canvas is missing, the function throws.
 *  - If createIfMissing is true and the target canvas is missing, a minimal canvas is created,
 *    then the markdown column is appended and the merged canvas is written.
 *  - This function never creates intra-column edges.
 */
/* -------------------- Refactored addMarkdownToCanvas using helpers -------------------- */

export async function addMarkdownToCanvas(
  app: App,
  mdPath: string,
  outCanvasPath: string,
  opts?: {
    offsetX?: number;
    cellSize?: number;
    cardWidth?: number;
    cardHeight?: number;
    yStart?: number;
    yGap?: number;
    groupLabel?: string;
    version?: string;
    overwrite?: boolean;
    createIfMissing?: boolean;
    offsetIncrement?: number; // used as margin when spacing to the rightmost
    minOffsetX?: number;      // ensure new group is at least this X
  }
) {
  const vault = app.vault;
  const {
    offsetX = 0,
    cellSize = 20,
    cardWidth = 320,
    cardHeight = 100,
    yStart = 80,
    yGap = 20,
    groupLabel: explicitGroupLabel,
    version: explicitVersion,
    overwrite = false,
    createIfMissing = false,
    offsetIncrement = cardWidth + 120, // used as margin to the rightmost
    minOffsetX = 0,
  } = opts || {};

  // read markdown and frontmatter
  const mdExists = await vault.adapter.exists(mdPath);
  if (!mdExists) throw new Error(`Markdown file not found: ${mdPath}`);
  const md = await vault.adapter.read(mdPath);

  // compute family/version/baseName (reuse your computeFamilyAndVersion if present)
  const { familyKey, version, baseName } = computeFamilyAndVersion(md, mdPath, explicitVersion);

  // parse all headings (any level) and areas
  const parsedHeadings = parseAllHeadings(md);
  if (!parsedHeadings.length) throw new Error("No headings found in markdown (any level).");

  // parse named areas (optional area tags)
  const parsedAreas = parseAreas(md); // may be empty array
  if (parsedAreas && parsedAreas.length) {
    console.log(`[z5Linter] Parsed ${parsedAreas.length} area(s) from ${mdPath}:`, parsedAreas.map(a => a.id));
  }

  // computed group label (restore this)
  const computedGroupLabel = explicitGroupLabel ? explicitGroupLabel : (version ? `${familyKey} v${version}` : familyKey);


  // ensure canvas exists or create if requested
  const canvasExists = await vault.adapter.exists(outCanvasPath);
  if (!canvasExists) {
    if (!createIfMissing) throw new Error(`Target canvas does not exist: ${outCanvasPath}. Create it first or call with createIfMissing:true.`);
    const initialNodes: any[] = [];
    const initialEdges: any[] = [];
    const metadata = { version: "1.0-1.0", frontmatter: { title: `Canvas: ${outCanvasPath}` } };
    await writeCanvas(app, outCanvasPath, initialNodes, initialEdges, metadata, true);
  }

  // read existing canvas
  const raw = await vault.adapter.read(outCanvasPath);
  let existingJson: any;
  try {
    existingJson = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Existing canvas JSON at ${outCanvasPath} is invalid JSON`);
  }
  if (!existingJson || typeof existingJson !== "object" || !Array.isArray(existingJson.nodes)) {
    throw new Error(`Existing canvas at ${outCanvasPath} is not a valid canvas JSON structure`);
  }

  // find same-family groups and duplicate guard (reuse helper)
  const sameFamilyGroups = findSameFamilyGroups(existingJson, familyKey);
  const duplicateGroup = sameFamilyGroups.find((g: any) => String(g.label) === computedGroupLabel);
  if (duplicateGroup) {
    console.log(`[z5Linter] Group "${computedGroupLabel}" already exists in ${outCanvasPath}; skipping append.`);
    return;
  }

  // Determine finalOffsetX:
  // - If there are prior same-family groups, place to the right of the overall rightmost content (not just count-based).
  // - Otherwise, use provided offsetX (but still ensure it's at least minOffsetX).
  const rightmostX = findRightmostX(existingJson, 0);
  const finalOffsetX = (sameFamilyGroups.length > 0)
    ? computeOffsetRightOfRightmost(rightmostX, offsetIncrement, Math.max(offsetX, minOffsetX))
    : Math.max(offsetX, minOffsetX);

  // build nodes at finalOffsetX (pass parsedAreas so nodes get areaId metadata)
  const newNodes = buildNodesFromParsedHeadings(
    parsedHeadings,
    mdPath,
    baseName,
    finalOffsetX,
    yStart,
    cardWidth,
    cardHeight,
    yGap,
    cellSize,
    24,
    { embedUseSlug: false, calloutLabel: "Embed" },
    parsedAreas
  );
}




/* -------------------- Convenience wrapper -------------------- */

/**
 * Convenience: create a canvas from a markdown file (single column at offsetX=0).
 */
export async function createCanvasFromMarkdown(app: App, mdPath: string, outCanvasPath: string, opts?: any) {
  //await addMarkdownToCanvas(app, mdPath, outCanvasPath, { offsetX: 80, createIfMissing: true, overwrite: true });
  await addMarkdownToCanvas(app, mdPath, "testMigrationData/migration.canvas", { offsetX: 80, createIfMissing: true, overwrite: true, version: "1" });
  await addMarkdownToCanvas(app, "testMigrationData/templates/template_project_v2.md", "testMigrationData/migration.canvas", { offsetX: 80, createIfMissing: false, overwrite: true, version: "2" });

}


/**
 * Create a Canvas-compatible mapping edge between two nodes.
 * Edges created by this helper represent data flow from `fromNode` -> `toNode`.
 *
 * - fromSide/toSide chosen so left-column -> right-column looks correct visually.
 * - `opts` is intentionally minimal: color and dashed style only.
 * - The function returns a plain object suitable for inclusion in canvasJson.edges.
 */
export function createMappingEdge(
  fromNodeId: string,
  toNodeId: string,
  opts?: {
    color?: string;
    dashed?: boolean;
  }
) {
  const id = uuidv4();
  const color = opts?.color ?? "#2b8cff";
  const styleAttributes: any = { color };
  if (opts?.dashed) styleAttributes.dash = [4, 4];

  return {
    id,
    styleAttributes,
    toFloating: false,
    fromNode: fromNodeId,
    fromSide: "right",
    toNode: toNodeId,
    toSide: "left",
  };
}

/** Parse simple YAML frontmatter from a markdown string */
export function parseFrontmatter(text: string): Record<string, string> {
  const fmMatch = text.match(/^---\s*[\r\n]+([\s\S]*?)\r?\n---\s*[\r\n]*/);
  if (!fmMatch) return {};
  const fmText = fmMatch[1];
  const out: Record<string, string> = {};
  for (const line of fmText.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.+?)\s*$/);
    if (m) {
      out[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  }
  return out;
}

/** Derive a family key from a basename by stripping common version suffixes */
export function deriveFamilyFromBasename(name: string) {
  return name.replace(/[-_]?v\d+(\.\d+)?$/i, "").replace(/[-_]?version[-_]?\d+(\.\d+)?$/i, "");
}

/** Compute familyKey and version from frontmatter and basename */
export function computeFamilyAndVersion(mdText: string, mdPath: string, explicitVersion?: string) {
  const front = parseFrontmatter(mdText);
  const fmFamily = front["template"] || front["template_name"] || null;
  const fmVersion = front["template_version"] || front["version"] || null;

  function fileBaseName(path: string) {
    const parts = path.split("/");
    const last = parts[parts.length - 1] || path;
    return last.replace(/\.md$/i, "");
  }
  const baseName = fileBaseName(mdPath);
  const familyKey = fmFamily ? String(fmFamily) : deriveFamilyFromBasename(baseName);
  const version = explicitVersion || fmVersion || undefined;
  return { familyKey, version, baseName };
}

/** Find groups in canvas JSON that belong to the same family (case-insensitive prefix match) */
export function findSameFamilyGroups(existingJson: any, familyKey: string) {
  const existingGroups = (existingJson.nodes || []).filter((n: any) => n && n.type === "group" && typeof n.label === "string");
  return existingGroups.filter((g: any) => String(g.label).toLowerCase().startsWith(String(familyKey).toLowerCase()));
}

/** Compute final offsetX given base offset, prior count, and increment */
export function computeFinalOffsetX(baseOffset: number, priorCount: number, offsetIncrement: number) {
  return baseOffset + priorCount * offsetIncrement;
}

/** Build snapped nodes array from headings and layout params */
export function buildNodesFromHeadings(
  headings: string[],
  mdPath: string,
  baseName: string,
  offsetX: number,
  yStart: number,
  cardWidth: number,
  cardHeight: number,
  yGap: number,
  cellSize: number
) {
  return headings.map((heading, i) => {
    const id = uuidv4();
    const rawY = yStart + i * (cardHeight + yGap);
    const rect = { x: offsetX, y: rawY, width: cardWidth, height: cardHeight };
    const snapped = snapRect(rect, cellSize);
    const anchor = heading;
    const wikilink = `![[${baseName}#${anchor}]]`;
    return {
      id,
      type: "text",
      text: wikilink,
      styleAttributes: {},
      x: snapped.x,
      y: snapped.y,
      width: snapped.width,
      height: snapped.height,
      metadata: { originalHeading: heading, sourceFile: mdPath },
    };
  });
}

/** Given a group node and canvas nodes, return nodes whose center X lies inside the group's horizontal bounds */
export function findNodesInGroupByGeometry(groupNode: any, allNodes: any[]) {
  if (!groupNode) return [];
  const groupLeft = Number(groupNode.x) || 0;
  const groupRight = groupLeft + (Number(groupNode.width) || 0);
  return (allNodes || []).filter((n: any) => {
    if (!n || typeof n !== "object") return false;
    if (n.type === "group") return false;
    const nx = Number(n.x) || 0;
    const centerX = nx + (Number(n.width) || 0) / 2;
    return centerX >= groupLeft && centerX <= groupRight;
  });
}

/**
 * Create mapping edges from nodes in prevGroup to newNodes when headings match exactly.
 * Returns an array of mapping edges (Canvas-compatible).
 */
export function createMappingEdgesForNewNodes(prevNodes: any[], newNodes: any[], existingEdges: any[] = []) {
  // Build lookups
  const prevByArea = new Map<string, any>();
  const prevByHeading = new Map<string, any>();
  for (const pn of prevNodes) {
    const area = pn.metadata?.areaId;
    const norm = String(pn.metadata?.normalizedHeading || pn.metadata?.originalHeading || "").trim().toLowerCase();
    if (area) prevByArea.set(area, pn);
    if (norm) prevByHeading.set(norm + "|" + (pn.metadata?.headingLevel || ""), pn);
    if (norm) prevByHeading.set(norm, pn); // fallback text-only
  }

  const edgesToAdd: any[] = [];
  for (const newNode of newNodes) {
    const newArea = newNode.metadata?.areaId;
    const newNorm = String(newNode.metadata?.normalizedHeading || newNode.metadata?.originalHeading || "").trim().toLowerCase();
    const newLevel = newNode.metadata?.headingLevel;

    // 1) area->area match
    if (newArea && prevByArea.has(newArea)) {
      const prevNode = prevByArea.get(newArea);
      const existsEdge = (existingEdges || []).some((e: any) => e.fromNode === prevNode.id && e.toNode === newNode.id);
      if (!existsEdge) edgesToAdd.push(createMappingEdge(prevNode.id, newNode.id, { color: "#2b8cff" }));
      continue;
    }

    // 2) exact heading+level match
    const keyLevel = `${newNorm}|${newLevel || ""}`;
    if (prevByHeading.has(keyLevel)) {
      const prevNode = prevByHeading.get(keyLevel);
      const existsEdge = (existingEdges || []).some((e: any) => e.fromNode === prevNode.id && e.toNode === newNode.id);
      if (!existsEdge) edgesToAdd.push(createMappingEdge(prevNode.id, newNode.id, { color: "#2b8cff" }));
      continue;
    }

    // 3) fallback text-only match
    if (prevByHeading.has(newNorm)) {
      const prevNode = prevByHeading.get(newNorm);
      const existsEdge = (existingEdges || []).some((e: any) => e.fromNode === prevNode.id && e.toNode === newNode.id);
      if (!existsEdge) edgesToAdd.push(createMappingEdge(prevNode.id, newNode.id, { color: "#2b8cff" }));
      continue;
    }

    // no match -> no edge
  }
  return edgesToAdd;
}


/** Merge nodes and edges into existing canvas JSON and write using writeCanvas */
export async function mergeAndWriteCanvas(
  app: App,
  outCanvasPath: string,
  existingJson: any,
  nodesToAppend: any[],
  edgesToAppend: any[],
  overwrite: boolean
) {
  const mergedNodes = Array.isArray(existingJson.nodes) ? [...existingJson.nodes] : [];
  if (nodesToAppend && nodesToAppend.length) mergedNodes.push(...nodesToAppend);

  const mergedEdges = Array.isArray(existingJson.edges) ? [...existingJson.edges] : [];
  if (edgesToAppend && edgesToAppend.length) mergedEdges.push(...edgesToAppend);

  const mergedMetadata = existingJson.metadata ? existingJson.metadata : { version: "1.0-1.0", frontmatter: { title: `Canvas` } };

  await writeCanvas(app, outCanvasPath, mergedNodes, mergedEdges, mergedMetadata, overwrite);
}


/* -------------------- Helpers for rightmost-based spacing -------------------- */

/**
 * Return the maximum right-edge X coordinate among nodes in the canvas JSON.
 * If no nodes exist, returns the provided fallback (default 0).
 */
export function findRightmostX(existingJson: any, fallback = 0) {
  if (!existingJson || !Array.isArray(existingJson.nodes) || existingJson.nodes.length === 0) {
    return fallback;
  }
  let maxRight = fallback;
  for (const n of existingJson.nodes) {
    if (!n || typeof n !== "object") continue;
    const nx = Number(n.x) || 0;
    const w = Number(n.width) || 0;
    const right = nx + w;
    if (right > maxRight) maxRight = right;
  }
  return maxRight;
}

/**
 * Compute the X offset to place a new group to the right of the current rightmost content.
 * - rightmostX: the current rightmost X coordinate (e.g., from findRightmostX)
 * - margin: horizontal gap in pixels between rightmost content and new group's left edge
 * - optionalMin: ensure the returned offset is at least this value (useful for base offset)
 */
export function computeOffsetRightOfRightmost(rightmostX: number, margin = 120, optionalMin = 0) {
  const candidate = rightmostX + margin;
  return Math.max(candidate, optionalMin);
}





/* -------------------------
   Multi-level heading parser
   ------------------------- */

/** Parse all headings (# .. ######) and return ordered array of { level, text, lineIndex } */
export function parseAllHeadings(mdText: string) {
  const lines = mdText.split(/\r?\n/);
  const out: { level: number; text: string; lineIndex: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^(#{1,6})\s+(.*)$/);
    if (m) {
      const level = m[1].length;
      const text = m[2].trim();
      out.push({ level, text, lineIndex: i });
    }
  }
  return out;
}

/** Create a simple slug/anchor from heading text */
export function makeAnchor(text: string) {
  return String(text || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\w\-]/g, "")
    .replace(/\-+/g, "-")
    .replace(/^\-+|\-+$/g, "");
}

/** Normalize heading text for matching (lowercase, punctuation stripped) */
export function normalizeHeadingKey(text: string) {
  return String(text || "").toLowerCase().replace(/[^\w\s]/g, "").trim();
}




/* -------------------------
   Area parsing helpers
   ------------------------- */

/**
 * Parse area tags from markdown.
 * Returns array of { id, label, startLine, endLine } where endLine is exclusive.
 * Syntax:
 *   <!-- area: area_id -->
 *   <!-- /area -->
 * Optional label: <!-- area: area_id label="Human label" -->
 */
export function parseAreas(mdText: string) {
  const lines = mdText.split(/\r?\n/);
  const areas: { id: string; label?: string; startLine: number; endLine?: number }[] = [];
  const openStack: { id: string; label?: string; startLine: number }[] = [];

  const openRe = /^\s*<!--\s*area\s*:\s*([A-Za-z0-9_\-]+)(?:\s+label\s*=\s*"(.*?)")?\s*-->\s*$/i;
  const closeRe = /^\s*<!--\s*\/area\s*-->\s*$/i;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const mo = line.match(openRe);
    if (mo) {
      openStack.push({ id: mo[1], label: mo[2], startLine: i + 1 }); // content starts after the tag line
      continue;
    }
    if (closeRe.test(line)) {
      const last = openStack.pop();
      if (last) {
        areas.push({ id: last.id, label: last.label, startLine: last.startLine, endLine: i }); // endLine exclusive
      }
    }
  }
  // any still-open areas run to EOF
  while (openStack.length) {
    const last = openStack.pop()!;
    areas.push({ id: last.id, label: last.label, startLine: last.startLine, endLine: undefined });
  }
  return areas;
}

/** Given a parsed heading (with lineIndex), find the areaId it belongs to (or null) */
export function findAreaForHeading(parsedAreas: { id: string; label?: string; startLine: number; endLine?: number }[], headingLineIndex: number) {
  for (const a of parsedAreas) {
    const start = a.startLine;
    const end = typeof a.endLine === "number" ? a.endLine : Infinity;
    if (headingLineIndex >= start && headingLineIndex < end) return a.id;
  }
  return null;
}




// build nodes at finalOffsetX
export function buildNodesFromParsedHeadings(
parsedHeadings: { level: number; text: string; lineIndex: number }[],
mdPath: string,
baseName: string,
offsetX: number,
yStart: number,
cardWidth: number,
cardHeight: number,
yGap: number,
cellSize: number,
indentPerLevel = 24, // pixels to indent per heading level
opts?: { embedUseSlug?: boolean; calloutLabel?: string },
parsedAreasForThisDoc?: { id: string; label?: string; startLine: number; endLine?: number }[]
) {
  const embedUseSlug = opts?.embedUseSlug ?? false;
  const calloutLabel = opts?.calloutLabel ?? "Template link";

  // right edge for all cards (before snapping)
  const rightEdge = offsetX + cardWidth;

  return parsedHeadings.map((h, i) => {
    const id = uuidv4();

    // compute left X based on heading level (level 1 = no indent)
    const leftX = offsetX + (Math.max(0, h.level - 1) * indentPerLevel);

    // compute width so right edge remains constant
    const width = Math.max(cellSize, rightEdge - leftX);

    const rawY = yStart + i * (cardHeight + yGap);
    const rect = { x: leftX, y: rawY, width, height: cardHeight };
    const snapped = snapRect(rect, cellSize);

    const anchorSlug = makeAnchor(h.text) || `heading-${i}`;
    const rawHeading = h.text;
    const embedAnchor = embedUseSlug ? anchorSlug : rawHeading;

    // Build card text: heading level line + blank line + callout block with embed
    const cardTextLines = [
      `h${h.level}: ${rawHeading}`,
      "",
      `> [!info]- ${opts?.calloutLabel ?? "Template link"}`,
      `> ![[${baseName}#${embedAnchor}]]`,
    ];
    const cardText = cardTextLines.join("\n");

    // determine area membership if parsedAreas were provided
    const areaId = parsedAreasForThisDoc ? findAreaForHeading(parsedAreasForThisDoc, h.lineIndex) : undefined;

    return {
      id,
      type: "text",
      text: cardText,
      styleAttributes: {},
      x: snapped.x,
      y: snapped.y,
      width: snapped.width,
      height: snapped.height,
      metadata: {
        originalHeading: rawHeading,
        headingLevel: h.level,
        anchor: anchorSlug,
        normalizedHeading: normalizeHeadingKey(rawHeading),
        sourceFile: mdPath,
        nodeRole: "card",
        areaId: areaId || undefined,
      },
    };
  });