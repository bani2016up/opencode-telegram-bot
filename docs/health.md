# Health and readiness

Set `HEALTH_PORT=8080` to enable the controller's HTTP health server. It listens
only on `127.0.0.1` in the controller's network namespace. When the variable is
unset, no health server starts. Do not publish this port or the OpenCode API.

- `GET /healthz` returns HTTP 200 while the controller event loop responds.
- `GET /readyz` returns HTTP 200 after a successful Telegram `getUpdates` call,
  provided the last successful poll is no more than 90 seconds old and no
  subsequent poll has failed. Otherwise it returns HTTP 503 and a non-sensitive
  reason: `starting`, `polling_failed`, `polling_stale`, or `stopping`.

The checks observe existing polling traffic and make no extra Telegram calls.
They do not verify message delivery, database writes, or model responses.
Monitor the OpenCode worker separately through its existing `/global/health`
Docker healthcheck. A controller can remain ready while its worker is unhealthy.

Add the following to the controller's Compose service. The healthcheck runs
inside its container; no additional network access is required:

```yaml
environment:
  HEALTH_PORT: "8080"
healthcheck:
  test:
    - CMD
    - node
    - -e
    - "fetch('http://127.0.0.1:8080/readyz', {signal: AbortSignal.timeout(3000)}).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
  interval: 15s
  timeout: 5s
  start_period: 45s
  retries: 3
```

Recreate only the controller after rebuilding it. Uptime Kuma can then consume
its Docker health status alongside the worker's health status.
