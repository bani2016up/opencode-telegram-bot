export const MAX_IMAGE_BYTES = 20_000_000;

export interface ImageAttachment {
  mime: "image/jpeg" | "image/png" | "image/webp";
  filename: string;
  url: string;
}

export interface ImageLoader {
  load(filePath: string, signal: AbortSignal): Promise<ImageAttachment>;
}

class ImageError extends Error {}

function imageType(bytes: Buffer): { mime: ImageAttachment["mime"]; extension: string } {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return { mime: "image/png", extension: "png" };
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return { mime: "image/jpeg", extension: "jpg" };
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP")
    return { mime: "image/webp", extension: "webp" };
  throw new ImageError("Please send a JPEG, PNG, or WebP image.");
}

export class TelegramImageLoader implements ImageLoader {
  constructor(
    private readonly telegramToken: string,
    private readonly fetchImage: typeof fetch = fetch,
    private readonly maxBytes = MAX_IMAGE_BYTES,
  ) {}

  async load(filePath: string, signal: AbortSignal): Promise<ImageAttachment> {
    signal.throwIfAborted();
    if (
      !/^[a-zA-Z0-9_./-]+$/u.test(filePath) ||
      filePath.startsWith("/") ||
      filePath.split("/").some((part) => !part || part === "." || part === "..")
    )
      throw new ImageError("Telegram returned an invalid image path.");
    const timeout = AbortSignal.timeout(60_000);
    const combined = AbortSignal.any([signal, timeout]);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await this.fetchImage(
        `https://api.telegram.org/file/bot${this.telegramToken}/${filePath}`,
        { signal: combined, redirect: "error" },
      );
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new ImageError("Could not download the image from Telegram.");
      }
      reader = response.body.getReader();
      if (Number(response.headers.get("content-length")) > this.maxBytes)
        throw new ImageError("The image exceeds the 20 MB download limit.");
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        combined.throwIfAborted();
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > this.maxBytes)
          throw new ImageError("The image exceeds the 20 MB download limit.");
        chunks.push(value);
      }
      combined.throwIfAborted();
      const bytes = Buffer.concat(chunks, size);
      const { mime, extension } = imageType(bytes);
      return {
        mime,
        filename: `image.${extension}`,
        url: `data:${mime};base64,${bytes.toString("base64")}`,
      };
    } catch (error) {
      signal.throwIfAborted();
      if (timeout.aborted) throw new ImageError("Image download timed out. Please try again.");
      if (error instanceof ImageError) throw error;
      // Fetch and stream errors can contain the bot token in the download URL.
      throw new ImageError("Could not download the image from Telegram.");
    } finally {
      await reader?.cancel().catch(() => undefined);
    }
  }
}
