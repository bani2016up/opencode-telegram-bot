import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

import { z } from "zod";

const schema = z
  .object({
    defaultModel: z.string().min(1),
    models: z
      .array(
        z.object({
          id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
          label: z.string().min(1).max(48),
          path: z.string().refine(isAbsolute, "Model paths must be absolute"),
        }),
      )
      .min(1),
    language: z.enum(["auto", "en", "ru"]).default("auto"),
    threads: z.number().int().min(1).max(8).default(2),
    maxDurationSeconds: z.number().int().min(1).max(600).default(180),
    maxFileBytes: z.number().int().min(1).max(20_000_000).default(10_000_000),
    timeoutSeconds: z.number().int().min(1).max(900).default(240),
    whisperPath: z.string().min(1).default("whisper-cli"),
    ffmpegPath: z.string().min(1).default("ffmpeg"),
    ffprobePath: z.string().min(1).default("ffprobe"),
    tempDirectory: z
      .string()
      .refine(isAbsolute, "Temporary directory must be absolute")
      .default("/tmp"),
  })
  .superRefine((settings, context) => {
    const ids = settings.models.map((model) => model.id);
    if (new Set(ids).size !== ids.length)
      context.addIssue({ code: "custom", message: "Duplicate transcription model ID" });
    if (!ids.includes(settings.defaultModel))
      context.addIssue({
        code: "custom",
        message: "Default transcription model is not in the catalog",
      });
  });

export type TranscriptionConfig = z.infer<typeof schema>;

export function parseTranscriptionConfig(value: unknown): TranscriptionConfig {
  return schema.parse(value);
}

export function loadTranscriptionConfig(path: string | undefined): TranscriptionConfig | undefined {
  return path ? parseTranscriptionConfig(JSON.parse(readFileSync(path, "utf8"))) : undefined;
}
