import { createBot } from "./app.js";
import { readConfig } from "./config.js";

try {
  const config = readConfig(process.env);
  const app = createBot(config);
  await app.start(config.port);

  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      if (stopping) return;
      stopping = true;
      const timeout = setTimeout(() => {
        console.error("Bot shutdown timed out.");
        process.exit(1);
      }, 10_000);
      timeout.unref();
      app.stop().then(() => {
        clearTimeout(timeout);
        process.exit(0);
      }).catch(() => {
        console.error("Bot shutdown failed.");
        process.exit(1);
      });
    });
  }
} catch (error) {
  console.error("Bot startup failed:", error instanceof Error ? error.message : "Unknown error");
  process.exit(1);
}
