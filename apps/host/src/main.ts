import { buildHostServer } from "./server.js";
import { loadHostConfiguration } from "@george/config";

const host = await buildHostServer();
const { app } = host;
const config = loadHostConfiguration(process.env);
const { port } = config.host;

await app.listen({ host: "127.0.0.1", port });
app.log.info({ address: "127.0.0.1", port }, "George Host is running");

let shuttingDown = false;
const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "George Host is shutting down");
  await host.close();
  process.exitCode = 0;
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
