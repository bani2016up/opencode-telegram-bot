import type { Content, Parent, Root } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { unified } from "unified";

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkStringify, {
  bullet: "-",
  fences: true,
  listItemIndent: "one",
});

const safeProtocols = new Set(["http:", "https:", "mailto:"]);

function isSafeUrl(url: string): boolean {
  try {
    return safeProtocols.has(new URL(url).protocol);
  } catch {
    return url.startsWith("#");
  }
}

function sanitizeChildren(parent: Parent, unsafeReferences: ReadonlySet<string>): void {
  const sanitized: Content[] = [];
  for (const child of parent.children) {
    if (child.type === "html") continue;
    if (child.type === "definition") {
      if (isSafeUrl(child.url)) sanitized.push(child);
      continue;
    }
    if (child.type === "image" || child.type === "imageReference") {
      sanitized.push({
        type: "text",
        value: `[Media omitted${"alt" in child && child.alt ? `: ${child.alt}` : ""}]`,
      });
      continue;
    }
    if (child.type === "link") {
      sanitizeChildren(child, unsafeReferences);
      if (!isSafeUrl(child.url)) sanitized.push(...child.children);
      else sanitized.push(child);
      continue;
    }
    if (child.type === "linkReference" && unsafeReferences.has(child.identifier.toLowerCase())) {
      sanitizeChildren(child, unsafeReferences);
      sanitized.push(...child.children);
      continue;
    }
    if ("children" in child) sanitizeChildren(child as Parent, unsafeReferences);
    sanitized.push(child);
  }
  parent.children = sanitized;
}

export function sanitizeRichMarkdown(markdown: string): string {
  const tree = processor.parse(markdown.replaceAll("\0", "")) as Root;
  const unsafeReferences = new Set(
    tree.children
      .filter((child) => child.type === "definition" && !isSafeUrl(child.url))
      .map((child) => (child.type === "definition" ? child.identifier.toLowerCase() : "")),
  );
  sanitizeChildren(tree, unsafeReferences);
  return processor.stringify(tree).trim();
}

export function splitRichMarkdown(markdown: string, limit = 30_000): string[] {
  if (markdown.length <= limit) return [markdown];
  const blocks = markdown.split(/\n{2,}/u);
  const chunks: string[] = [];
  let current = "";
  for (const block of blocks) {
    if (block.length > limit) {
      if (current) chunks.push(current);
      for (let offset = 0; offset < block.length; offset += limit)
        chunks.push(block.slice(offset, offset + limit));
      current = "";
      continue;
    }
    const candidate = current ? `${current}\n\n${block}` : block;
    if (candidate.length > limit) {
      chunks.push(current);
      current = block;
    } else current = candidate;
  }
  if (current) chunks.push(current);
  return chunks;
}
