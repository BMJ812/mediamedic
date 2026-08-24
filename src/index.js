import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isBotConfigured, loadSettings } from "./settings.js";
import { startWebServer } from "./web.js";

const botScript = fileURLToPath(new URL("./bot-main.js", import.meta.url));
let botProcess;
let botState = { state: "stopped", detail: "Bot has not started yet." };
let intentionalStop = false;

export function getBotState() {
  return { ...botState };
}

async function stopBot() {
  if (!botProcess) return;
  intentionalStop = true;
  const child = botProcess;
  botProcess = undefined;
  botState = { state: "stopping", detail: "Restarting MediaMedic bot…" };

  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 4000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

async function startBot() {
  const settings = loadSettings();
  if (!isBotConfigured(settings)) {
    botState = { state: "setup-required", detail: "Complete setup in the MediaMedic Web UI." };
    return;
  }

  intentionalStop = false;
  botState = { state: "starting", detail: "Connecting to Discord…" };
  const child = fork(botScript, [], { stdio: ["inherit", "inherit", "inherit", "ipc"] });
  botProcess = child;

  child.on("message", (message) => {
    if (!message || message.type !== "state") return;
    botState = {
      state: message.state,
      detail: message.state === "online"
        ? `${message.tag} — ${message.dryRun ? "DRY RUN" : "LIVE"}`
        : (message.error || message.state),
      tag: message.tag,
      dryRun: message.dryRun,
    };
  });

  child.on("exit", (code, signal) => {
    if (botProcess === child) botProcess = undefined;
    if (intentionalStop) {
      intentionalStop = false;
      return;
    }
    botState = {
      state: "error",
      detail: `Bot process exited (${signal || (code ?? "unknown")}). Check container logs.`,
    };
  });
}

async function restartBot() {
  await stopBot();
  await startBot();
  return getBotState();
}

startWebServer({ getBotState, restartBot });
await startBot();

process.on("SIGTERM", async () => {
  await stopBot();
  process.exit(0);
});
