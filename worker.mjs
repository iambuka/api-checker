// Render background worker: runs guard.mjs once at start and then every hour.
// Each run is its own process, so a crash or hang in one run can't stop the next.
import { spawn } from "child_process";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";

const GUARD = path.join(path.dirname(fileURLToPath(import.meta.url)), "guard.mjs");
const EVERY_MS = (Number(process.env.CHECK_EVERY_MINUTES) || 60) * 60e3;
const TIMEOUT_MS = 15 * 60e3;

let lastRun = null;
function runOnce() {
  const child = spawn(process.execPath, [GUARD], { stdio: "inherit" });
  const kill = setTimeout(() => { console.error("guard run took over 15 min - killed"); child.kill("SIGKILL"); }, TIMEOUT_MS);
  child.on("exit", code => { clearTimeout(kill); lastRun = { at: new Date().toISOString(), code }; if (code) console.error(`guard exited with code ${code}`); });
}

// As a Render Web Service the app must answer on $PORT; as a Background Worker there is no PORT.
if (process.env.PORT) http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, everyMinutes: EVERY_MS / 60e3, lastRun }));
}).listen(process.env.PORT);

runOnce();
setInterval(runOnce, EVERY_MS);
