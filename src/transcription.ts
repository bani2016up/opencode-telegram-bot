import { spawn } from "node:child_process";
import { access, mkdtemp, open, readFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";

import type { TranscriptionConfig } from "./transcription-config.js";

export interface Transcriber {
  transcribe(filePath: string, modelId: string, signal: AbortSignal): Promise<string>;
}

// Discard stderr: decoders and HTTP errors can include private audio or token-bearing URLs.
export function runAudioProcess(
  command: string,
  args: string[],
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"], shell: false });
    let output = "";
    let failed = false;
    const stop = () => child.kill("SIGKILL");
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (output.length > 256_000) {
        failed = true;
        stop();
      }
    });
    child.on("error", () => {
      failed = true;
    });
    child.on("close", (code) => {
      signal.removeEventListener("abort", stop);
      if (signal.aborted) reject(signal.reason);
      else if (code !== 0 || failed)
        reject(
          new Error(
            "Audio processing failed. Check the installed decoder and transcription model.",
          ),
        );
      else resolve(output);
    });
  });
}

export class LocalTranscriber implements Transcriber {
  private busy = false;

  constructor(
    private readonly config: TranscriptionConfig,
    private readonly telegramToken: string,
    private readonly fetchAudio: typeof fetch = fetch,
    private readonly run = runAudioProcess,
  ) {}

  async validateModels(): Promise<void> {
    for (const model of this.config.models) await access(model.path, constants.R_OK);
  }

  async transcribe(filePath: string, modelId: string, signal: AbortSignal): Promise<string> {
    const model = this.config.models.find((candidate) => candidate.id === modelId);
    if (!model)
      throw new Error(
        "This transcription model is unavailable. Select another model in Voice settings.",
      );
    if (
      !/^[a-zA-Z0-9_./-]+$/.test(filePath) ||
      filePath.startsWith("/") ||
      filePath.split("/").some((part) => !part || part === "." || part === "..")
    ) {
      throw new Error("Telegram returned an invalid audio file path.");
    }
    if (this.busy)
      throw new Error("Another voice message is being transcribed. Please try again shortly.");
    signal.throwIfAborted();
    this.busy = true;
    const timeout = AbortSignal.timeout(this.config.timeoutSeconds * 1000);
    const combined = AbortSignal.any([signal, timeout]);
    let directory: string | undefined;
    try {
      directory = await mkdtemp(join(this.config.tempDirectory, "opencode-voice-"));
      const input = join(directory, "input");
      await this.download(filePath, input, combined);
      const wav = join(directory, "audio.wav");
      await this.run(
        this.config.ffmpegPath,
        [
          "-nostdin",
          "-v",
          "error",
          "-protocol_whitelist",
          "file,pipe",
          "-threads",
          "1",
          "-i",
          input,
          "-t",
          String(this.config.maxDurationSeconds + 1),
          "-vn",
          "-ar",
          "16000",
          "-ac",
          "1",
          "-c:a",
          "pcm_s16le",
          "-threads",
          "1",
          wav,
        ],
        combined,
      );
      const duration = Number(
        (
          await this.run(
            this.config.ffprobePath,
            [
              "-v",
              "error",
              "-show_entries",
              "format=duration",
              "-of",
              "default=noprint_wrappers=1:nokey=1",
              wav,
            ],
            combined,
          )
        ).trim(),
      );
      if (!Number.isFinite(duration) || duration <= 0)
        throw new Error("The voice message contains no usable audio.");
      if (duration > this.config.maxDurationSeconds + 0.05)
        throw new Error(
          `Voice messages must be at most ${this.config.maxDurationSeconds} seconds long.`,
        );
      const output = join(directory, "transcript");
      await this.run(
        this.config.whisperPath,
        [
          "-m",
          model.path,
          "-f",
          wav,
          "-l",
          this.config.language,
          "-t",
          String(this.config.threads),
          "-ng",
          "-np",
          "-nt",
          "-otxt",
          "-of",
          output,
        ],
        combined,
      );
      combined.throwIfAborted();
      const transcript = (await readFile(`${output}.txt`, "utf8")).trim();
      if (!transcript || /^\[(?:blank_audio|silence|music)\]$/i.test(transcript))
        throw new Error("No speech was recognized. Please try again or send text.");
      return transcript;
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (timeout.aborted)
        throw new Error(
          "Voice transcription timed out. Try a shorter recording or a faster model.",
        );
      throw error;
    } finally {
      try {
        if (directory) await rm(directory, { recursive: true, force: true });
      } finally {
        this.busy = false;
      }
    }
  }

  private async download(
    filePath: string,
    destination: string,
    signal: AbortSignal,
  ): Promise<void> {
    let response: Response;
    try {
      response = await this.fetchAudio(
        `https://api.telegram.org/file/bot${this.telegramToken}/${filePath}`,
        { signal, redirect: "error" },
      );
    } catch {
      signal.throwIfAborted();
      throw new Error("Could not download the voice message from Telegram.");
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error("Could not download the voice message from Telegram.");
    }
    if (Number(response.headers.get("content-length")) > this.config.maxFileBytes) {
      await response.body.cancel();
      throw new Error("The voice message exceeds the configured file size limit.");
    }
    const file = await open(destination, "wx", 0o600);
    const reader = response.body.getReader();
    let size = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > this.config.maxFileBytes)
          throw new Error("The voice message exceeds the configured file size limit.");
        await file.writeFile(value);
      }
      if (size === 0) throw new Error("Telegram returned an empty voice message.");
    } catch (error) {
      if (error instanceof Error && /^(The voice message|Telegram returned)/.test(error.message))
        throw error;
      signal.throwIfAborted();
      throw new Error("Could not download the voice message from Telegram.");
    } finally {
      await reader.cancel().catch(() => undefined);
      await file.close();
    }
  }
}
