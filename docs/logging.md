# Application logging

The controller writes JSON events to stdout/stderr. The existing `LOG_LEVEL` controls filtering; use `info` for request diagnostics. No additional service is required.

## Follow a request

```sh
docker compose logs --since 15m --no-log-prefix bot
docker compose logs --since 15m --no-log-prefix bot |
  jq -R 'fromjson? | select(.requestId == "telegram:CHAT_ID:album:ALBUM_ID")'
```

Messages in the same album share a `requestId`. Individual requests use `telegram:CHAT_ID:message:MESSAGE_ID`. `updateId` and `messageId` identify the original Telegram update. Session events include `sessionId` after the session is selected.

Typical events:

| Event                           | Meaning                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `telegram.update.received`      | An authorized private update reached the controller. Contents are excluded.                            |
| `album.item`                    | Another album item was added, duplicated, or arrived after collection closed.                          |
| `images.collected`              | Collection finished; `imageCount` is the number of members received.                                   |
| `request.stage`                 | Processing entered the named stage.                                                                    |
| `image.downloaded`              | One image was downloaded and validated. Includes index, count, bytes, MIME, and duration of the stage. |
| `opencode.prompt.accepted`      | OpenCode accepted the request. This does not mean model work is complete.                              |
| `opencode.tool`                 | A tool entered running/completed status. Includes its name, excluding arguments and output.            |
| `opencode.permission.requested` | OpenCode requested permission. Commands and patterns are excluded.                                     |
| `opencode.retry`                | OpenCode reported a retry. This is not a controller download retry.                                    |
| `opencode.completed`            | The model run returned a response.                                                                     |
| `request.completed`             | Response delivery to Telegram completed.                                                               |
| `request.failed`                | The request failed at `stage`. `modelCompleted` distinguishes model failure from delivery failure.     |
| `request.cancelled`             | The request was cancelled.                                                                             |
| `request.waiting`               | An active request remains at the named stage; emitted every 30 seconds.                                |
| `request.rejected`              | The controller was busy and rejected another request.                                                  |

`elapsedMs` measures time since request processing started. `stageElapsedMs` measures time in the current stage. The last stage and periodic waiting event help distinguish collection, downloading, transcription, model execution, and Telegram delivery.

## Investigate failures

```sh
docker compose logs --since 1h --no-log-prefix bot |
  jq -R 'fromjson? | select(.level == "error" or .level == "warn")'
```

An image download failure includes `imageIndex`, `imageCount`, `operation`, `phase`, `reason`, `receivedBytes`, and `durationMs`. When available, `httpStatus` and `networkCodes` distinguish HTTP rejection, connection failure, and interrupted body transfer. A `httpStatus` of 200 with `phase: read_body` can still indicate a failed download. Telegram API errors can include `retryAfterSeconds`.

The controller logs the original request failure before attempting an error reply. `telegram.error_reply.failed` records a second failure sending that reply. `telegram.response.fallback` records rich-message failure before the existing plain-text fallback. Draft failures are best-effort and logged once per failure streak, followed by a recovery event.

`telegram.polling.state` records readiness transitions, including failure, stale polling, and recovery. Repeated identical polling failures are suppressed. Readiness probes expose stale polling as before.

## Data boundaries and limitations

Logs contain numeric Telegram identifiers, session identifiers, model/tool names, counts, timings, and allowlisted error metadata. They exclude prompts, captions, transcripts, model responses, commands, file IDs/paths, image data, upstream response bodies, headers, raw error messages, and stacks.

Unknown error names and network codes are omitted or normalized. This intentionally limits diagnostics rather than risking credentials embedded in upstream errors. Local voice processing reports its stage; decoder stderr remains excluded. Log rotation/retention belongs to the deployment configuration.

These changes do not introduce download retries or alter album limits. A failed download still prevents submission of the complete album. Historical errors cannot be reconstructed from the new logs.
