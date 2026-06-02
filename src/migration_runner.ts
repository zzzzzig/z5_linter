// migration_runner.ts
import { App, Notice } from "obsidian";
import { v4 as uuidv4 } from "uuid";

/* -------------------- Types -------------------- */

type CanvasJson = { nodes: any[]; edges: any[]; metadata?: any };
type MappingEdge = {
  id: string;
  fromNode: string;
  toNode: string;
  // optional internal metadata (not required by Canvas UI)
  metadata?: { op?: "copy" | "move" | "transform"; transform?: string; label?: string };
};

type NodeRef = {
  id: string;
  sourceFile: string;        // note path
  originalHeading: string;   // heading text
  x?: number; y?: number;
};

type TransformContext = {
  app: App;
  fromNode: NodeRef;
  toNode: NodeRef;
  edge: MappingEdge;
  dryRun: boolean;
  logger: (msg: string) => void;
};

type TransformFn = (content: string, ctx: TransformContext) => Promise<{ content: string; extraWrites?: Record<string, string> }>;

/* -------------------- Transform registry -------------------- */

const transformRegistry: Record<string, TransformFn> = {};

/** Register a transform script */
export function registerTransform(name: string, fn: TransformFn) {
  transformRegistry[name] = fn;
}

/* Example transforms (simple, synchronous logic allowed) */

registerTransform("addTags", async (content, ctx) => {
  // opts could be encoded in edge.metadata.transform string (e.g., "addTags:tag1,tag2")
  const tags = (ctx.edge.metadata?.transform || "").replace(/^addTags:?/, "").split(",").map(s => s.trim()).filter(Boolean);
  if (!tags.length) return { content };
  // naive: append tags to frontmatter or end of content
  let newContent = content;
  // if frontmatter exists, inject tags; otherwise append a tags line
  if (/^---\s*[\s\S]*?---\s*/.test(content)) {
    newContent = content.replace(/^---\s*([\s\S]*?)---\s*/, (m, fm) => {
      // simple frontmatter append (not robust YAML editing; replace with YAML lib if needed)
      const hasTags = /(^|\n)tags\s*:/i.test(fm);
      if (hasTags) return m.replace(/(^|\n)(tags\s*:\s*)([^\n]*)/i, (mm, p1, p2, p3) => `${p1}${p2}${p3}, ${tags.join(", ")}`);
      return `---\n${fm}\ntags: ${tags.join(", ")}\n---\n`;
    });
  } else {
    newContent = `${content}\n\ntags: ${tags.join(", ")}\n`;
  }
  return { content: newContent };
});

registerTransform("removeTags", async (content, ctx) => {
  const tagsToRemove = (ctx.edge.metadata?.transform || "").replace(/^removeTags:?/, "").split(",").map(s => s.trim()).filter(Boolean);
  if (!tagsToRemove.length) return { content };
  // naive removal: remove tags from frontmatter line
  let newContent = content.replace(/(^---\s*[\s\S]*?---\s*)/m, (m) => {
    return m.replace(/(^|\n)tags\s*:\s*([^\n]*)/i, (mm, p1, p2) => {
      const remaining = p2.split(",").map(s => s.trim()).filter(t => !tagsToRemove.includes(t));
      return remaining.length ? `\n tags: ${remaining.join(", ")}` : "";
    });
  });
  return { content: newContent };
});

registerTransform("promoteHeading", async (content, ctx) => {
  // promote a heading level inside the content (e.g., ## -> #)
  // transform string could be "promoteHeading:1" to promote by 1 level
  const by = parseInt((ctx.edge.metadata?.transform || "").replace(/^promoteHeading:?/, "") || "1", 10);
  if (!by) return { content };
  const newContent = content.replace(/^(\#{1,6})\s+/gm, (m, hashes) => {
    const newLevel = Math.max(1, hashes.length - by);
    return `${"#".repeat(newLevel)} `;
  });
  return { content: newContent };
});

/* -------------------- Canvas helpers -------------------- */

async function loadCanvasJson(app: App, canvasPath: string): Promise<CanvasJson> {
  const vault = app.vault;
  const raw = await vault.adapter.read(canvasPath);
  return JSON.parse(raw);
}

function collectNodeRefs(canvas: CanvasJson): Map<string, NodeRef> {
  const map = new Map<string, NodeRef>();
  for (const n of canvas.nodes || []) {
    if (!n || !n.id) continue;
    if (n.metadata?.sourceFile && n.metadata?.originalHeading) {
      map.set(n.id, {
        id: n.id,
        sourceFile: n.metadata.sourceFile,
        originalHeading: n.metadata.originalHeading,
        x: n.x, y: n.y,
      });
    }
  }
  return map;
}

function collectMappingEdges(canvas: CanvasJson): MappingEdge[] {
  const edges: MappingEdge[] = [];
  for (const e of canvas.edges || []) {
    if (!e || !e.fromNode || !e.toNode) continue;
    edges.push({
      id: e.id || uuidv4(),
      fromNode: e.fromNode,
      toNode: e.toNode,
      metadata: e.metadata || {},
    });
  }
  return edges;
}

/* -------------------- Note content helpers -------------------- */

/** Read a note file and return its full text */
async function readNote(app: App, path: string): Promise<string> {
  const vault = app.vault;
  return await vault.adapter.read(path);
}

/** Write a note file (overwrites) */
async function writeNote(app: App, path: string, content: string) {
  const vault = app.vault;
  const file = await vault.getAbstractFileByPath(path);
  if (file) {
    await vault.modify(file as any, content);
  } else {
    await vault.create(path, content);
  }
}

/** Extract the content under a heading (exact match) from a note.
 *  Returns { heading, content, startIndex, endIndex } where content excludes the heading line.
 */
function extractHeadingContent(noteText: string, heading: string): { content: string; start: number; end: number } | null {
  const lines = noteText.split(/\r?\n/);
  let startIdx = -1;
  let startLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^#{1,6}\s+(.*)/);
    if (m && m[1].trim() === heading) {
      startLine = i;
      startIdx = lines.slice(0, i + 1).join("\n").length; // index after heading line
      break;
    }
  }
  if (startLine === -1) return null;
  // find next heading at same or higher level
  const headingLine = lines[startLine];
  const level = (headingLine.match(/^#{1,6}/) || [""])[0].length;
  let endLine = lines.length;
  for (let j = startLine + 1; j < lines.length; j++) {
    const m = lines[j].match(/^#{1,6}\s+/);
    if (m && m[0].length <= level) {
      endLine = j;
      break;
    }
  }
  const content = lines.slice(startLine + 1, endLine).join("\n");
  const start = lines.slice(0, startLine + 1).join("\n").length + (startLine >= 0 ? 1 : 0);
  const end = lines.slice(0, endLine).join("\n").length;
  return { content, start, end };
}

/** Replace the content under a heading in a note. If heading not found, append heading + content at end. */
function replaceHeadingContent(noteText: string, heading: string, newContent: string): string {
  const lines = noteText.split(/\r?\n/);
  let startLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^#{1,6}\s+(.*)/);
    if (m && m[1].trim() === heading) {
      startLine = i;
      break;
    }
  }
  if (startLine === -1) {
    // append heading and content
    return `${noteText}\n\n## ${heading}\n${newContent}`;
  }
  const headingLine = lines[startLine];
  const level = (headingLine.match(/^#{1,6}/) || [""])[0].length;
  let endLine = lines.length;
  for (let j = startLine + 1; j < lines.length; j++) {
    const m = lines[j].match(/^#{1,6}\s+/);
    if (m && m[0].length <= level) {
      endLine = j;
      break;
    }
  }
  const before = lines.slice(0, startLine + 1).join("\n");
  const after = lines.slice(endLine).join("\n");
  const replaced = `${before}\n${newContent}${after ? "\n" + after : ""}`;
  return replaced;
}

/* -------------------- Migration engine -------------------- */

export async function runMigrationForCanvas(
  app: App,
  canvasPath: string,
  opts?: { dryRun?: boolean; backup?: boolean; logger?: (s: string) => void }
) {
  const dryRun = opts?.dryRun ?? true;
  const backup = opts?.backup ?? true;
  const logger = opts?.logger ?? ((s) => console.log("[migration]", s));

  logger(`Loading canvas: ${canvasPath}`);
  const canvas = await loadCanvasJson(app, canvasPath);
  const nodeMap = collectNodeRefs(canvas);
  const edges = collectMappingEdges(canvas);

  // group edges by target note so we can batch updates per note
  const edgesByTarget = new Map<string, MappingEdge[]>();
  for (const e of edges) {
    const from = nodeMap.get(e.fromNode);
    const to = nodeMap.get(e.toNode);
    if (!from || !to) {
      logger(`Skipping edge ${e.id} because node refs missing`);
      continue;
    }
    // only consider cross-file or cross-version edges (from.sourceFile -> to.sourceFile)
    const key = to.sourceFile;
    if (!edgesByTarget.has(key)) edgesByTarget.set(key, []);
    edgesByTarget.get(key)!.push(e);
  }

  // For each target note, read it once and apply all incoming mappings
  for (const [targetPath, mappings] of edgesByTarget.entries()) {
    logger(`Processing target note: ${targetPath} (${mappings.length} mappings)`);

    // backup original note if requested
    let originalText = "";
    try {
      originalText = await readNote(app, targetPath);
    } catch (e) {
      logger(`Failed to read target note ${targetPath}: ${String(e)}`);
      continue;
    }
    if (backup && !dryRun) {
      const backupPath = `.migration_backups/${targetPath.replace(/\//g, "__")}.${Date.now()}.bak.md`;
      try {
        await writeNote(app, backupPath, originalText);
        logger(`Backup written: ${backupPath}`);
      } catch (e) {
        logger(`Backup failed for ${targetPath}: ${String(e)}`);
      }
    }

    let workingText = originalText;

    // apply each mapping sequentially (order matters if multiple mappings touch same heading)
    for (const edge of mappings) {
      const from = nodeMap.get(edge.fromNode)!;
      const to = nodeMap.get(edge.toNode)!;
      const ctx: TransformContext = { app, fromNode: from, toNode: to, edge, dryRun, logger };

      // read source content
      let sourceText = "";
      try {
        sourceText = await readNote(app, from.sourceFile);
      } catch (e) {
        logger(`Failed to read source note ${from.sourceFile}: ${String(e)}`);
        continue;
      }
      const extracted = extractHeadingContent(sourceText, from.originalHeading);
      if (!extracted) {
        logger(`Source heading "${from.originalHeading}" not found in ${from.sourceFile}`);
        continue;
      }

      // choose transform
      const op = edge.metadata?.op || "copy";
      const transformName = edge.metadata?.transform;
      let transformed = { content: extracted.content, extraWrites: {} as Record<string,string> };

      if (transformName && transformRegistry[transformName]) {
        transformed = await transformRegistry[transformName](extracted.content, ctx);
      } else if (op === "copy") {
        // no-op: content copied as-is
      } else if (op === "move") {
        // move semantics: we'll clear source after applying (handled below)
      } else if (op === "transform" && transformName && transformRegistry[transformName]) {
        transformed = await transformRegistry[transformName](extracted.content, ctx);
      }

      // write into target heading in workingText
      workingText = replaceHeadingContent(workingText, to.originalHeading, transformed.content);

      // if op === move and not dryRun, remove source content from source note
      if (op === "move" && !dryRun) {
        let srcText = sourceText;
        const cleared = replaceHeadingContent(srcText, from.originalHeading, "");
        await writeNote(app, from.sourceFile, cleared);
        logger(`Moved content: cleared ${from.originalHeading} in ${from.sourceFile}`);
      }

      // apply any extraWrites returned by transform (e.g., update other notes)
      if (transformed.extraWrites && !dryRun) {
        for (const [p, c] of Object.entries(transformed.extraWrites)) {
          await writeNote(app, p, c);
          logger(`Transform wrote extra file: ${p}`);
        }
      }
    } // end mappings loop

    // finalize: write workingText back to target note if not dryRun
    if (!dryRun) {
      await writeNote(app, targetPath, workingText);
      logger(`Wrote updated note: ${targetPath}`);
    } else {
      logger(`[dryRun] Preview for ${targetPath} (not written)`);
    }
  } // end notes loop

  logger("Migration run complete.");
}
