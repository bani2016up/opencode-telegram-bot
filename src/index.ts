import { createTelegramBot } from "./bot.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { SdkOpenCodeGateway } from "./opencode.js";
import { Store } from "./store.js";

const config = loadConfig();
const logger = createLogger(config.logLevel);
const store = new Store(config.databasePath);
const opencode = new SdkOpenCodeGateway(
  config.opencodeBaseUrl,
  config.opencodeUsername,
  config.opencodePassword,
);
const bot = createTelegramBot(config, { store, opencode, logger });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    logger.info("Stopping Telegram bot", { signal });
    bot.stop();
    store.close();
  });
}

await opencode.health();
await bot.start({
  onStart: (info) => logger.info("Telegram bot started", { username: info.username }),
  allowed_updates: ["message", "callback_query", "stopped_message_generation"],
});
