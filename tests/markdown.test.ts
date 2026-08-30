import { describe, expect, it } from "vitest";

import { sanitizeRichMarkdown, splitRichMarkdown } from "../src/markdown.js";

describe("sanitizeRichMarkdown", () => {
  it("preserves GitHub tables and code fences", () => {
    const result = sanitizeRichMarkdown(
      "| Name | Value |\n| --- | --- |\n| test | `42` |\n\n```ts\nconst x = 1;\n```",
    );
    expect(result).toContain("| Name");
    expect(result).toContain("```ts");
  });

  it("removes model-generated Telegram controls and media", () => {
    const result = sanitizeRichMarkdown(
      '<tg-button type="callback_data" data="approve">Approve</tg-button>\n\n![secret](https://example.com/image.png)',
    );
    expect(result).not.toContain("tg-button");
    expect(result).not.toContain("https://example.com/image.png");
    expect(result).toContain("Media omitted");
  });

  it("neutralizes unsafe link protocols", () => {
    const result = sanitizeRichMarkdown(
      "[approve](tg://user?id=123) and [safe](https://example.com)",
    );
    expect(result).not.toContain("tg://");
    expect(result).toContain("https://example.com");
  });

  it("neutralizes unsafe reference-style links", () => {
    const result = sanitizeRichMarkdown("[approve][control]\n\n[control]: tg://user?id=123");
    expect(result).toContain("approve");
    expect(result).not.toContain("tg://");
  });
});

describe("splitRichMarkdown", () => {
  it("splits on block boundaries", () => {
    expect(splitRichMarkdown("first block\n\nsecond block", 15)).toEqual([
      "first block",
      "second block",
    ]);
  });
});
