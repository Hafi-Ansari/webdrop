import type { Config } from "./config.ts";

type Level = Exclude<Config["logLevel"], "silent">;
const order: Record<Config["logLevel"], number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

/** JSON-lines logger. Never pass raw client IPs or tokens in `fields`. */
export function createLogger(level: Config["logLevel"]): Logger {
  const min = order[level];
  const emit = (lvl: Level, msg: string, fields?: Record<string, unknown>) => {
    if (order[lvl] < min) return;
    const line = JSON.stringify({ time: new Date().toISOString(), level: lvl, msg, ...fields });
    if (lvl === "error" || lvl === "warn") process.stderr.write(line + "\n");
    else process.stdout.write(line + "\n");
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
  };
}
