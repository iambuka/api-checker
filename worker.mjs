// Render background worker: runs guard.mjs once at start and then every hour.
// Each run is its own process, so a crash or hang in one run can't stop the next.
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const GUARD = path.join(path.dirname(fileURLToPath(import.meta.url)), "guard.mjs");
const EVERY_MS = (Number(process.env.CHECK_EVERY_MINUTES) || 60) * 60e3;
const TIMEOUT_MS = 15 * 60e3;

function runOnce() {
  const child = spawn(process.execPath, [GUARD], { stdio: "inherit" });
  const kill = setTimeout(() => { console.error("guard run took over 15 min - killed"); child.kill("SIGKILL"); }, TIMEOUT_MS);
  child.on("exit", code => { clearTimeout(kill); if (code) console.error(`guard exited with code ${code}`); });
}

runOnce();
setInterval(runOnce, EVERY_MS);
