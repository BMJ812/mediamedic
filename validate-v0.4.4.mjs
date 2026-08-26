import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = resolve(process.argv[2] || ".");
const tempDir = mkdtempSync(join(tmpdir(), "mediamedic-v044-"));
const settingsPath = join(tempDir, "settings.json");
process.env.MEDIAMEDIC_SETTINGS_PATH = settingsPath;

try {
  const moduleUrl = `${pathToFileURL(join(repoRoot, "src", "settings.js")).href}?test=${Date.now()}`;
  const { saveSettings } = await import(moduleUrl);

  const base = {
    discordToken: "test-token",
    discordClientId: "1541281782672924673",
    discordGuildId: "947652318369820722",
    adminRoleId: "",
    repairRoleId: "",
    allowedChannelId: "1467084943778910393",
    radarrUrl: "http://127.0.0.1:7878",
    radarrApiKey: "test",
    sonarrUrl: "http://127.0.0.1:8989",
    sonarrApiKey: "test",
    dryRun: true,
    uiPassword: "0123456789",
  };

  saveSettings(base, { preserveSecrets: false });

  let duplicateRejected = false;
  try {
    saveSettings({ ...base, repairRoleId: base.allowedChannelId }, { preserveSecrets: false });
  } catch (error) {
    duplicateRejected = /same as Repair Role ID/.test(String(error?.message || error));
  }
  if (!duplicateRejected) throw new Error("Channel/repair-role collision was not rejected.");

  let malformedRejected = false;
  try {
    saveSettings({ ...base, allowedChannelId: "not-a-discord-id" }, { preserveSecrets: false });
  } catch (error) {
    malformedRejected = /17-20 digits/.test(String(error?.message || error));
  }
  if (!malformedRejected) throw new Error("Malformed Discord ID was not rejected.");

  console.log("v0.4.4 local Discord ID validation checks passed.");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
