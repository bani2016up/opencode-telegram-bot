import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import { parseTranscriptionConfig } from "../src/transcription-config.js";
import { LocalTranscriber, runAudioProcess } from "../src/transcription.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function setup(overrides: Record<string, unknown> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "voice-tests-"));
  directories.push(directory);
  const config = parseTranscriptionConfig({
    defaultModel: "custom",
    models: [{ id: "custom", label: "Custom", path: "/models/custom.bin" }],
    tempDirectory: directory,
    ...overrides,
  });
  const download = vi.fn<typeof fetch>().mockImplementation(async () => new Response("audio"));
  const run = vi.fn<typeof runAudioProcess>().mockImplementation(async (command, args) => {
    if (command === "ffprobe") return "5.5";
    if (command === "whisper-cli")
      await writeFile(`${args[args.indexOf("-of") + 1]}.txt`, "Привет. Check the server.\n");
    return "";
  });
  const transcriber = new LocalTranscriber(config, "private-test-token", download, run);
  return { directory, config, download, run, transcriber };
}

describe("local transcription", () => {
  it("uses the configured model and language and removes audio and output afterwards", async () => {
    const test = await setup({ language: "ru", threads: 1 });
    expect(
      await test.transcriber.transcribe("voice/file_1.oga", "custom", new AbortController().signal),
    ).toBe("Привет. Check the server.");
    expect(test.run.mock.calls[2]![1]).toEqual(
      expect.arrayContaining(["/models/custom.bin", "ru", "1", "-ng", "-otxt"]),
    );
    expect(test.download.mock.calls[0]![1]?.redirect).toBe("error");
    expect(await readdir(test.directory)).toEqual([]);
  });

  it.each(["../secret", "https://example.com/audio", "voice/a?token=secret"])(
    "rejects an invalid Telegram path: %s",
    async (path) => {
      const test = await setup();
      await expect(
        test.transcriber.transcribe(path, "custom", new AbortController().signal),
      ).rejects.toThrow("invalid audio file path");
      expect(test.download).not.toHaveBeenCalled();
    },
  );

  it("rejects unknown models without downloading or running a process", async () => {
    const test = await setup();
    await expect(
      test.transcriber.transcribe("voice/a", "missing", new AbortController().signal),
    ).rejects.toThrow("unavailable");
    expect(test.download).not.toHaveBeenCalled();
  });

  it("enforces the actual streamed size without trusting content-length", async () => {
    const test = await setup({ maxFileBytes: 4 });
    await expect(
      test.transcriber.transcribe("voice/a", "custom", new AbortController().signal),
    ).rejects.toThrow("size limit");
    expect(test.run).not.toHaveBeenCalled();
    expect(await readdir(test.directory)).toEqual([]);
  });

  it("rejects an excessive decoded duration before running Whisper", async () => {
    const test = await setup({ maxDurationSeconds: 2 });
    await expect(
      test.transcriber.transcribe("voice/a", "custom", new AbortController().signal),
    ).rejects.toThrow("at most 2 seconds");
    expect(test.run).toHaveBeenCalledTimes(2);
    expect(await readdir(test.directory)).toEqual([]);
  });

  it("does not expose a token-bearing download error", async () => {
    const test = await setup();
    test.download.mockRejectedValue(
      new Error("https://api.telegram.org/file/botprivate-test-token/voice/a"),
    );
    await expect(
      test.transcriber.transcribe("voice/a", "custom", new AbortController().signal),
    ).rejects.toThrow("Could not download the voice message from Telegram.");
    expect(await readdir(test.directory)).toEqual([]);
  });

  it("rejects concurrent transcription, cancels the active one, then accepts another", async () => {
    const test = await setup();
    test.run.mockImplementationOnce(
      (_command, _args, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    const controller = new AbortController();
    const pending = test.transcriber.transcribe("voice/a", "custom", controller.signal);
    const cancelled = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await expect.poll(() => test.run.mock.calls.length).toBe(1);
    await expect(
      test.transcriber.transcribe("voice/b", "custom", new AbortController().signal),
    ).rejects.toThrow("Another voice message");
    controller.abort();
    await cancelled;
    expect(await readdir(test.directory)).toEqual([]);
    await expect(
      test.transcriber.transcribe("voice/c", "custom", new AbortController().signal),
    ).resolves.toContain("Привет");
  });

  it("enforces a processing deadline and cleans up temporary files", async () => {
    const test = await setup({ timeoutSeconds: 1 });
    test.run.mockImplementation(
      (_command, _args, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    await expect(
      test.transcriber.transcribe("voice/a", "custom", new AbortController().signal),
    ).rejects.toThrow("timed out");
    expect(await readdir(test.directory)).toEqual([]);
  });

  it("kills and reaps the child process when cancelled", async () => {
    const test = await setup();
    const marker = join(test.directory, "pid");
    const controller = new AbortController();
    const pending = runAudioProcess(
      process.execPath,
      [
        "-e",
        "require('fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)",
        marker,
      ],
      controller.signal,
    );
    const cancelled = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await expect.poll(() => readFile(marker, "utf8").catch(() => "")).toMatch(/^\d+$/);
    const pid = Number(await readFile(marker, "utf8"));
    controller.abort();
    await cancelled;
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("rejects duplicate IDs and a default absent from the configurable catalog", () => {
    const model = { id: "one", label: "One", path: "/models/one.bin" };
    expect(() => parseTranscriptionConfig({ defaultModel: "two", models: [model] })).toThrow(
      "not in the catalog",
    );
    expect(() => parseTranscriptionConfig({ defaultModel: "one", models: [model, model] })).toThrow(
      "Duplicate",
    );
  });
});
