# Local voice transcription

Voice notes are decoded and transcribed inside the Telegram controller, using FFmpeg and whisper.cpp.
No paid transcription API, OpenAI API key, or application on the user's computer is needed.
The supplied catalog contains multilingual Base and Tiny Q5_1 models. Both support English and Russian.
The configured language is `auto`; use `en` or `ru` to force one language. Transcription preserves the spoken language.

## Configure

1. Copy `examples/transcription.json` to an administrator-owned configuration file.
2. Review its model IDs, display labels, absolute container paths, download URLs, checksums, and limits.
3. Download the catalog into a persistent model directory:

   ```bash
   python3 scripts/download-transcription-models.py deploy/transcription.json --directory /srv/opencode-transcription/models
   ```

4. Build `docker/Dockerfile` with target `runtime`. It includes whisper.cpp 1.9.5, pinned to a source revision and checksum.
5. Mount the model directory at `/models:ro` and the configuration at `/etc/opencode-telegram-bot/transcription.json:ro`.
6. Set `TRANSCRIPTION_CONFIG=/etc/opencode-telegram-bot/transcription.json` in the controller environment and recreate the controller.

Without `TRANSCRIPTION_CONFIG`, voice input stays disabled and text behavior is unchanged.
Startup rejects an invalid catalog or unreadable model file. Do not use English-only `.en` models for Russian.
Model paths and executable paths come only from administrator configuration; Telegram callbacks cannot supply executable arguments or download URLs.
Changing the catalog requires restarting the controller. Adding a model requires no application code change.

## Use

Open `/start` → **Voice settings** and choose a model. Selection is saved per Telegram user in SQLite and survives restarts.
When a selected model is removed, the configured default is used. Agent model, session, and workspace selections are independent.
Send a voice note in the private chat. The bot displays **Heard:** with the recognized text, then submits it to the current OpenCode session.
The transcript is plain prompt text, not a bot command. Existing OpenCode permissions still apply.
**Abort** and the draft Stop control also cancel downloading, decoding, or transcription.

## Resource and privacy limits

- Only authorized users can download or transcribe. Authorization is checked again before submitting a transcript.
- One transcription runs at a time per controller. A second user gets a busy response rather than starting another model.
- The sample configuration accepts at most 180 seconds and 10 MB, with a 240-second transcription deadline.
- Both advertised and downloaded sizes are checked. Decoded duration is verified before inference.
- FFmpeg accepts local files only. Child processes run without a shell and are killed on cancellation.
- The model is loaded for one request, then released when the process exits. It is not kept resident.
- Audio and intermediate files use a private temporary directory and are removed on success, failure, or cancellation.
- A container restart clears its temporary filesystem. Do not persist or back up `/tmp`.
- Transcripts appear in Telegram and the OpenCode session. Audio, model output, and token-bearing download URLs are not logged.

Allocate sufficient temporary space for compressed audio and 16 kHz mono WAV (about 5.8 MB for 180 seconds).
Use a container memory limit and CPU limit appropriate to the host. The entire controller, including Node and FFmpeg, counts toward that limit.
Quality and latency depend on the model, accent, noise, and CPU. Compact models can misrecognize commands and technical names.

Back up the controller database for model preferences. Preserve the catalog and its checksums; model binaries can be downloaded again.
For offline recovery, also preserve the model files and built image.
