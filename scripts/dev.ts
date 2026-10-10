/**
 * Development: signaling server (auto-restart on change) + Vite dev server.
 * Open http://localhost:5173 in two browser windows (or two devices on your
 * LAN, which needs HTTPS: see README "Testing on your phone").
 */
import { spawn } from "node:child_process";

const serverPort = process.env.SERVER_PORT ?? "8080";
const procs = [
  spawn(process.execPath, ["--watch", "server/src/index.ts"], {
    stdio: "inherit",
    env: { ...process.env, PORT: serverPort, HOST: "127.0.0.1", LOG_LEVEL: process.env.LOG_LEVEL ?? "debug" },
  }),
  spawn("npm", ["run", "dev", "-w", "@webdrop/web", "--", ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, SERVER_PORT: serverPort },
  }),
];

const stop = () => {
  for (const p of procs) p.kill("SIGTERM");
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const p of procs) p.on("exit", (code) => {
  if (code) {
    stop();
    process.exitCode = code;
  }
});
