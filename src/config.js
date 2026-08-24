import { isBotConfigured, loadSettings } from "./settings.js";

export function loadConfig() {
  const settings = loadSettings();
  if (!isBotConfigured(settings)) {
    throw new Error("MediaMedic is not configured. Open the Web UI and complete setup.");
  }
  return {
    discordToken: settings.discordToken,
    discordClientId: settings.discordClientId,
    discordGuildId: settings.discordGuildId || undefined,
    adminRoleId: settings.adminRoleId || undefined,
    repairRoleId: settings.repairRoleId || undefined,
    allowedChannelId: settings.allowedChannelId || undefined,
    radarrUrl: settings.radarrUrl,
    radarrApiKey: settings.radarrApiKey,
    sonarrUrl: settings.sonarrUrl,
    sonarrApiKey: settings.sonarrApiKey,
    dryRun: settings.dryRun,
    databasePath: settings.databasePath || "/config/mediamedic.db",
    logLevel: settings.logLevel || "info",
  };
}
