import { describe, expect, it, vi } from "vitest";

import { TelegramImageLoader } from "../src/images.js";

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);

describe("TelegramImageLoader", () => {
  it.each([
    [png, "image/png", "image.png"],
    [Buffer.from([255, 216, 255, 224]), "image/jpeg", "image.jpg"],
    [Buffer.from("RIFFxxxxWEBPdata"), "image/webp", "image.webp"],
  ])("detects image bytes independently of response metadata", async (bytes, mime, filename) => {
    const download = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(bytes, { headers: { "content-type": "text/plain" } }));
    const result = await new TelegramImageLoader("private-token", download).load(
      "photos/file.jpg",
      new AbortController().signal,
    );
    expect(result).toEqual({
      mime,
      filename,
      url: `data:${mime};base64,${bytes.toString("base64")}`,
    });
    expect(download.mock.calls[0]![1]?.redirect).toBe("error");
    expect(result.url).not.toContain("private-token");
  });

  it.each([
    "../secret",
    "/image.png",
    "https://other.test/image",
    "photos/../image",
    "photos/image?token=x",
  ])("rejects unsafe paths before downloading: %s", async (path) => {
    const download = vi.fn<typeof fetch>();
    await expect(
      new TelegramImageLoader("token", download).load(path, new AbortController().signal),
    ).rejects.toThrow("invalid image path");
    expect(download).not.toHaveBeenCalled();
  });

  it.each([Buffer.from("<svg>not a supported image</svg>"), Buffer.alloc(0)])(
    "rejects unsupported or empty content despite a claimed image MIME",
    async (bytes) => {
      const download = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(bytes, { headers: { "content-type": "image/png" } }));
      await expect(
        new TelegramImageLoader("token", download).load(
          "documents/file.png",
          new AbortController().signal,
        ),
      ).rejects.toThrow("JPEG, PNG, or WebP");
    },
  );

  it("enforces both declared and streamed byte limits", async () => {
    const download = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(png, { headers: { "content-length": "100" } }))
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(png);
              controller.enqueue(png);
              controller.close();
            },
          }),
        ),
      );
    const loader = new TelegramImageLoader("token", download, 12);
    await expect(loader.load("photos/file.png", new AbortController().signal)).rejects.toThrow(
      "download limit",
    );
    await expect(loader.load("photos/file.png", new AbortController().signal)).rejects.toThrow(
      "download limit",
    );
  });

  it("redacts download and stream errors containing credential URLs", async () => {
    const leak = new Error("https://api.telegram.org/file/botprivate-token/photos/file.png");
    const download = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(leak)
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(leak);
            },
          }),
        ),
      );
    const loader = new TelegramImageLoader("private-token", download);
    for (let i = 0; i < 2; i++)
      await expect(loader.load("photos/file.png", new AbortController().signal)).rejects.toThrow(
        /^Could not download the image from Telegram\.$/,
      );
  });

  it("propagates cancellation and rejects HTTP failures", async () => {
    const controller = new AbortController();
    const download = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => {
      controller.abort();
      options?.signal?.throwIfAborted();
      return new Response(png);
    });
    const loader = new TelegramImageLoader("token", download);
    await expect(loader.load("photos/file.png", controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    download.mockResolvedValue(new Response("failure", { status: 403 }));
    await expect(loader.load("photos/file.png", new AbortController().signal)).rejects.toThrow(
      "Could not download",
    );
  });
});
