import { afterEach, describe, expect, it, vi } from "vitest";
import { ImageAlbum } from "../src/image-album.js";

afterEach(() => vi.useRealTimers());

describe("ImageAlbum", () => {
  it("resets the quiet window, ignores duplicates, and sorts message IDs", async () => {
    vi.useFakeTimers();
    const album = new ImageAlbum<string>(100, 1000);
    album.add(20, "second");
    const collected = album.collect(new AbortController().signal);
    await vi.advanceTimersByTimeAsync(90);
    expect(album.add(10, "first")).toBe("added");
    expect(album.add(10, "duplicate")).toBe("duplicate");
    await vi.advanceTimersByTimeAsync(90);
    expect(album.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(10);
    await expect(collected).resolves.toEqual(["first", "second"]);
    expect(album.add(30, "late")).toBe("closed");
    expect(album.add(20, "replay")).toBe("duplicate");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels collection and clears its timers", async () => {
    vi.useFakeTimers();
    const album = new ImageAlbum<string>();
    album.add(1, "first");
    const controller = new AbortController();
    const result = expect(album.collect(controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    controller.abort();
    await result;
    expect(album.closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails the entire album on deadline or excess item count", async () => {
    vi.useFakeTimers();
    const album = new ImageAlbum<string>(100, 150);
    album.add(1, "first");
    const result = expect(album.collect(new AbortController().signal)).rejects.toThrow(
      "delivery timed out",
    );
    await vi.advanceTimersByTimeAsync(90);
    album.add(2, "second");
    await vi.advanceTimersByTimeAsync(60);
    await result;
    expect(vi.getTimerCount()).toBe(0);
    const excessive = new ImageAlbum<number>();
    for (let i = 0; i < 11; i++) excessive.add(i, i);
    await expect(excessive.collect(new AbortController().signal)).rejects.toThrow("at most 10");
  });
});
