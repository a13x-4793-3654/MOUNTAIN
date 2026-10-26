import { createServer } from "node:http";
import { App, ExpressAdapter } from "@microsoft/teams.apps";
import { ConsoleLogger } from "@microsoft/teams.common";
import { configureRoutes } from "./app.js";
import { readPort } from "./config.js";

try {
  if (process.env.NODE_ENV === "production") {
    throw new Error("The unauthenticated Playground entry point is disabled in production.");
  }
  for (const name of ["CLIENT_ID", "CLIENT_SECRET", "TENANT_ID", "MANAGED_IDENTITY_CLIENT_ID"]) {
    delete process.env[name];
  }
  const server = createServer();
  const logger = new ConsoleLogger("mountain-teams-bot-playground", { level: "info" });
  const adapter = new ExpressAdapter(server, { logger });
  const app = new App({
    dangerouslyAllowUnauthenticatedRequests: true,
    httpServerAdapter: adapter,
    logger,
  });
  configureRoutes(app, adapter);
  await app.initialize();
  const port = readPort(process.env);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  console.log(`Playground only: http://127.0.0.1:${port}/api/messages (authentication disabled).`);
} catch (error) {
  console.error("Playground startup failed:", error instanceof Error ? error.message : "Unknown error");
  process.exit(1);
}
