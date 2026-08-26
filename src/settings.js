import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export const SETTINGS_PATH = process.env.MEDIAMEDIC_SETTINGS_PATH?.trim() || "/config/settings.json";

const DEFAULTS = {
  discordToken: "",
  discordClientId: "",
  discordGuildId: "",
  adminRoleId: "",
  repairRoleId: "",
  allowedChannelId: "",
  radarrUrl: "http://127.0.0.1:7878",
  radarrApiKey: "",
  sonarrUrl: "http://127.0.0.1:8989",
  sonarrApiKey: "",
  dryRun: true,
  databasePath: "/config/mediamedic.db",
  logLevel: "info",
  uiPasswordHash: "",
  uiPasswordSalt: "",
};

const DISCORD_SNOWFLAKE = /^\d{17,20}$/;

function trimSlash(value) {
  return String(value ?? "").trim().replace(/\/+$/, "");
}

function envFallback() {
  return {
    discordToken: process.env.DISCORD_TOKEN?.trim() || "",
    discordClientId: process.env.DISCORD_CLIENT_ID?.trim() || "",
    discordGuildId: process.env.DISCORD_GUILD_ID?.trim() || "",
    adminRoleId: process.env.ADMIN_ROLE_ID?.trim() || "",
    repairRoleId: process.env.REPAIR_ROLE_ID?.trim() || "",
    allowedChannelId: process.env.ALLOWED_CHANNEL_ID?.trim() || "",
    radarrUrl: trimSlash(process.env.RADARR_URL || DEFAULTS.radarrUrl),
    radarrApiKey: process.env.RADARR_API_KEY?.trim() || "",
    sonarrUrl: trimSlash(process.env.SONARR_URL || DEFAULTS.sonarrUrl),
    sonarrApiKey: process.env.SONARR_API_KEY?.trim() || "",
    dryRun: (process.env.DRY_RUN ?? "true").toLowerCase() !== "false",
    databasePath: process.env.DATABASE_PATH?.trim() || DEFAULTS.databasePath,
    logLevel: process.env.LOG_LEVEL?.trim() || DEFAULTS.logLevel,
  };
}

function readFileSettings() {
  if (!existsSync(SETTINGS_PATH)) return {};
  try {
    const parsed = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    console.error(`Unable to read ${SETTINGS_PATH}:`, error);
    return {};
  }
}

function validateDiscordIdFields(settings) {
  const fields = [
    ["Application / Client ID", settings.discordClientId],
    ["Server / Guild ID", settings.discordGuildId],
    ["Admin Role ID", settings.adminRoleId],
    ["Repair Role ID", settings.repairRoleId],
    ["Allowed Channel ID", settings.allowedChannelId],
  ];

  for (const [label, value] of fields) {
    if (value && !DISCORD_SNOWFLAKE.test(String(value))) {
      throw new Error(`${label} must be a Discord numeric ID (17-20 digits).`);
    }
  }

  if (settings.allowedChannelId && settings.allowedChannelId === settings.repairRoleId) {
    throw new Error(
      "Allowed Channel ID cannot be the same as Repair Role ID. Paste the channel ID into Allowed Channel ID and a role ID into Repair Role ID, or leave Repair Role ID blank.",
    );
  }

  if (settings.allowedChannelId && settings.allowedChannelId === settings.adminRoleId) {
    throw new Error(
      "Allowed Channel ID cannot be the same as Admin Role ID. Paste the channel ID into Allowed Channel ID and a role ID into Admin Role ID, or leave Admin Role ID blank.",
    );
  }
}

export function loadSettings() {
  const env = envFallback();
  const file = readFileSettings();
  return {
    ...DEFAULTS,
    ...env,
    ...file,
    radarrUrl: trimSlash(file.radarrUrl ?? env.radarrUrl),
    sonarrUrl: trimSlash(file.sonarrUrl ?? env.sonarrUrl),
    dryRun: typeof file.dryRun === "boolean" ? file.dryRun : env.dryRun,
  };
}

export function isBotConfigured(settings = loadSettings()) {
  return Boolean(
    settings.discordToken &&
      settings.discordClientId &&
      settings.discordGuildId &&
      settings.radarrUrl &&
      settings.radarrApiKey &&
      settings.sonarrUrl &&
      settings.sonarrApiKey
  );
}

export function hasUiPassword(settings = loadSettings()) {
  return Boolean(settings.uiPasswordHash && settings.uiPasswordSalt);
}

export function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}

export function verifyPassword(password, settings = loadSettings()) {
  if (!hasUiPassword(settings)) return false;
  try {
    const expected = Buffer.from(settings.uiPasswordHash, "hex");
    const actual = scryptSync(String(password ?? ""), settings.uiPasswordSalt, 64);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function saveSettings(input, { preserveSecrets = true } = {}) {
  const current = loadSettings();
  const next = {
    ...current,
    discordClientId: String(input.discordClientId ?? current.discordClientId).trim(),
    discordGuildId: String(input.discordGuildId ?? current.discordGuildId).trim(),
    adminRoleId: String(input.adminRoleId ?? current.adminRoleId).trim(),
    repairRoleId: String(input.repairRoleId ?? current.repairRoleId).trim(),
    allowedChannelId: String(input.allowedChannelId ?? current.allowedChannelId).trim(),
    radarrUrl: trimSlash(input.radarrUrl ?? current.radarrUrl),
    sonarrUrl: trimSlash(input.sonarrUrl ?? current.sonarrUrl),
    dryRun: input.dryRun == null ? current.dryRun : Boolean(input.dryRun),
    databasePath: current.databasePath || DEFAULTS.databasePath,
    logLevel: current.logLevel || DEFAULTS.logLevel,
  };

  const discordToken = String(input.discordToken ?? "").trim();
  const radarrApiKey = String(input.radarrApiKey ?? "").trim();
  const sonarrApiKey = String(input.sonarrApiKey ?? "").trim();
  next.discordToken = discordToken || (preserveSecrets ? current.discordToken : "");
  next.radarrApiKey = radarrApiKey || (preserveSecrets ? current.radarrApiKey : "");
  next.sonarrApiKey = sonarrApiKey || (preserveSecrets ? current.sonarrApiKey : "");

  if (input.uiPassword) {
    const value = String(input.uiPassword);
    if (value.length < 10) throw new Error("Web UI password must be at least 10 characters.");
    const { salt, hash } = hashPassword(value);
    next.uiPasswordSalt = salt;
    next.uiPasswordHash = hash;
  }

  validateDiscordIdFields(next);

  mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
  writeFileSync(SETTINGS_PATH, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  chmodSync(SETTINGS_PATH, 0o600);
  return next;
}

export function publicSettings(settings = loadSettings()) {
  return {
    discordClientId: settings.discordClientId,
    discordGuildId: settings.discordGuildId,
    adminRoleId: settings.adminRoleId,
    repairRoleId: settings.repairRoleId,
    allowedChannelId: settings.allowedChannelId,
    radarrUrl: settings.radarrUrl,
    sonarrUrl: settings.sonarrUrl,
    dryRun: settings.dryRun,
    hasDiscordToken: Boolean(settings.discordToken),
    hasRadarrApiKey: Boolean(settings.radarrApiKey),
    hasSonarrApiKey: Boolean(settings.sonarrApiKey),
    configured: isBotConfigured(settings),
    authConfigured: hasUiPassword(settings),
  };
}
