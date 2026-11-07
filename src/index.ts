import { createTelegramBot } from "./bot.js";
import { loadConfig } from "./config.js";
import { PollingHealth, startHealthServer } from "./health.js";
import { createLogger } from "./logger.js";
import { SdkOpenCodeGateway } from "./opencode.js";
import { Store } from "./store.js";
import { LocalTranscriber } from "./transcription.js";

const config = loadConfig();
const logger = createLogger(config.logLevel);
logger.info("application.starting", { pid: process.pid, nodeVersion: process.version });
const store = new Store(config.databasePath);
const opencode = new SdkOpenCodeGateway(
  config.opencodeBaseUrl,
  config.opencodeUsername,
  config.opencodePassword,
);
const transcriber = config.transcription
  ? new LocalTranscriber(config.transcription, config.telegramToken)
  : undefined;
await transcriber?.validateModels();
const bot = createTelegramBot(config, {
  store,
  opencode,
  logger,
  ...(transcriber ? { transcriber } : {}),
});
const health = new PollingHealth(undefined, logger);
bot.api.config.use(health.track);
const healthServer = await startHealthServer(health, process.env.HEALTH_PORT);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    logger.info("Stopping Telegram bot", { signal });
    health.stopping = true;
    bot.stop();
    store.close();
  });
}

try {
  const version = await opencode.health();
  logger.info("opencode.health.ready", { version });
  await bot.start({
    onStart: (info) => logger.info("Telegram bot started", { username: info.username }),
    allowed_updates: ["message", "callback_query", "stopped_message_generation"],
  });
} finally {
  health.stopping = true;
  healthServer?.close();
  logger.info("application.stopped");
}
