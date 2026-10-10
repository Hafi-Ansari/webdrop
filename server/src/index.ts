import { loadConfig } from "./config.ts";
import { createLogger } from "./log.ts";
import { createAppServer } from "./server.ts";

const config = loadConfig();
const log = createLogger(config.logLevel);
const app = createAppServer(config, { log });
await app.listen();

let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    if (stopping) return;
    stopping = true;
    log.info("shutting down", { signal });
    const force = setTimeout(() => process.exit(1), 5000);
    force.unref();
    void app.close().then(() => process.exit(0));
  });
}
