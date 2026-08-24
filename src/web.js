import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RadarrClient, SonarrClient } from "./arr.js";
import {
  hasUiPassword,
  isBotConfigured,
  loadSettings,
  publicSettings,
  saveSettings,
  verifyPassword,
} from "./settings.js";
import { safeError } from "./util.js";

const VERSION = "0.4.2";
const PORT = Number.parseInt(process.env.MEDIAMEDIC_WEB_PORT || "8787", 10);
const HOST = process.env.MEDIAMEDIC_WEB_HOST || "0.0.0.0";
const indexHtml = readFileSync(fileURLToPath(new URL("../public/index.html", import.meta.url)), "utf8");
const logoIconPng = readFileSync(fileURLToPath(new URL("../public/logo-icon.png", import.meta.url)));
const logoFullPng = readFileSync(fileURLToPath(new URL("../public/logo-full.png", import.meta.url)));
const sessions = new Map();
const SESSION_MS = 12 * 60 * 60 * 1000;

function json(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function html(res, body) {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
  });
  res.end(body);
}

function parseCookies(req) {
  const result = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    result[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return result;
}

function sessionFor(req) {
  const token = parseCookies(req).mediamedic_session;
  if (!token) return undefined;
  const expires = sessions.get(token);
  if (!expires || Date.now() > expires) {
    if (token) sessions.delete(token);
    return undefined;
  }
  sessions.set(token, Date.now() + SESSION_MS);
  return token;
}

function newSession() {
  const token = randomBytes(32).toString("hex");
  sessions.set(token, Date.now() + SESSION_MS);
  return token;
}

function sessionCookie(token) {
  return `mediamedic_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_MS / 1000)}`;
}

function requireAuth(req, res) {
  const settings = loadSettings();
  if (!hasUiPassword(settings)) return true;
  if (sessionFor(req)) return true;
  json(res, 401, { ok: false, error: "Authentication required." });
  return false;
}

async function readJson(req, limit = 65536) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function mergedCandidate(input) {
  const current = loadSettings();
  return {
    ...current,
    discordToken: String(input.discordToken || "").trim() || current.discordToken,
    discordClientId: String(input.discordClientId ?? current.discordClientId).trim(),
    discordGuildId: String(input.discordGuildId ?? current.discordGuildId).trim(),
    adminRoleId: String(input.adminRoleId ?? current.adminRoleId).trim(),
    repairRoleId: String(input.repairRoleId ?? current.repairRoleId).trim(),
    allowedChannelId: String(input.allowedChannelId ?? current.allowedChannelId).trim(),
    radarrUrl: String(input.radarrUrl ?? current.radarrUrl).trim().replace(/\/+$/, ""),
    radarrApiKey: String(input.radarrApiKey || "").trim() || current.radarrApiKey,
    sonarrUrl: String(input.sonarrUrl ?? current.sonarrUrl).trim().replace(/\/+$/, ""),
    sonarrApiKey: String(input.sonarrApiKey || "").trim() || current.sonarrApiKey,
    dryRun: input.dryRun == null ? current.dryRun : Boolean(input.dryRun),
  };
}

async function testDiscord(settings) {
  if (!settings.discordToken) throw new Error("Discord bot token is missing.");
  if (!settings.discordGuildId) throw new Error("Discord server ID is missing.");
  if (!settings.discordClientId) throw new Error("Discord application/client ID is missing.");

  const headers = { Authorization: `Bot ${settings.discordToken}` };
  const me = await fetch("https://discord.com/api/v10/users/@me", { headers });
  if (!me.ok) throw new Error(`Discord authentication failed (${me.status}).`);
  const user = await me.json();

  const guild = await fetch(`https://discord.com/api/v10/guilds/${encodeURIComponent(settings.discordGuildId)}`, { headers });
  if (!guild.ok) throw new Error(`Bot cannot access Discord server (${guild.status}).`);
  const guildData = await guild.json();

  // Do not use GET /channels/{id} as a connectivity test. Discord can return
  // 403 when the bot user itself lacks View Channel even though guild-scoped
  // application commands and interactions are working normally in that channel.
  // MediaMedic's channel lock is enforced by matching interaction.channelId.
  const channelDetail = settings.allowedChannelId
    ? ` — channel lock ${settings.allowedChannelId}`
    : "";

  return `${user.username} — ${guildData.name}${channelDetail}`;
}

async function testAll(settings) {
  const radarr = new RadarrClient(settings.radarrUrl, settings.radarrApiKey);
  const sonarr = new SonarrClient(settings.sonarrUrl, settings.sonarrApiKey);
  const settled = await Promise.allSettled([testDiscord(settings), radarr.health(), sonarr.health()]);
  const result = {};
  for (const [index, key] of ["discord", "radarr", "sonarr"].entries()) {
    const item = settled[index];
    result[key] = item.status === "fulfilled"
      ? { ok: true, detail: index === 0 ? item.value : `Connected — ${item.value}` }
      : { ok: false, detail: safeError(item.reason) };
  }
  return result;
}

export function startWebServer({ getBotState, restartBot }) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    try {
      if (req.method === "GET" && url.pathname === "/") return html(res, indexHtml);
      if (req.method === "GET" && url.pathname === "/logo-icon.png") {
        res.writeHead(200, {"Content-Type": "image/png", "Cache-Control": "public, max-age=3600"});
        return res.end(logoIconPng);
      }
      if (req.method === "GET" && url.pathname === "/logo-full.png") {
        res.writeHead(200, {"Content-Type": "image/png", "Cache-Control": "public, max-age=3600"});
        return res.end(logoFullPng);
      }

      if (req.method === "GET" && url.pathname === "/api/bootstrap") {
        const settings = loadSettings();
        return json(res, 200, {
          ok: true,
          version: VERSION,
          authRequired: hasUiPassword(settings),
          authenticated: Boolean(sessionFor(req)),
          configured: isBotConfigured(settings),
          bot: getBotState(),
        });
      }

      if (req.method === "POST" && url.pathname === "/api/login") {
        const body = await readJson(req);
        const settings = loadSettings();
        if (!hasUiPassword(settings)) return json(res, 409, { ok: false, error: "Web UI password has not been created yet." });
        if (!verifyPassword(body.password, settings)) return json(res, 401, { ok: false, error: "Incorrect password." });
        const token = newSession();
        return json(res, 200, { ok: true }, { "Set-Cookie": sessionCookie(token) });
      }

      if (req.method === "POST" && url.pathname === "/api/logout") {
        const token = sessionFor(req);
        if (token) sessions.delete(token);
        return json(res, 200, { ok: true }, {
          "Set-Cookie": "mediamedic_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
        });
      }

      if (req.method === "GET" && url.pathname === "/api/settings") {
        if (!requireAuth(req, res)) return;
        return json(res, 200, { ok: true, settings: publicSettings(loadSettings()) });
      }

      if (req.method === "POST" && url.pathname === "/api/test") {
        if (!requireAuth(req, res)) return;
        const body = await readJson(req);
        return json(res, 200, { ok: true, results: await testAll(mergedCandidate(body)) });
      }

      if (req.method === "GET" && url.pathname === "/api/status") {
        if (!requireAuth(req, res)) return;
        const settings = loadSettings();
        const results = isBotConfigured(settings)
          ? await testAll(settings)
          : {
              discord: { ok: false, detail: "Setup incomplete" },
              radarr: { ok: false, detail: "Setup incomplete" },
              sonarr: { ok: false, detail: "Setup incomplete" },
            };
        return json(res, 200, { ok: true, bot: getBotState(), dryRun: settings.dryRun, results });
      }

      if (req.method === "POST" && url.pathname === "/api/settings") {
        const current = loadSettings();
        const firstRun = !hasUiPassword(current);
        if (!firstRun && !requireAuth(req, res)) return;
        const body = await readJson(req);

        if (firstRun && !body.uiPassword) throw new Error("Create a Web UI password to finish first-run setup.");
        if (body.dryRun === false && body.liveConfirm !== "LIVE") {
          throw new Error("Type LIVE in the confirmation field before disabling Dry Run.");
        }

        const saved = saveSettings(body, { preserveSecrets: true });
        const bot = await restartBot();
        const headers = {};
        if (firstRun) headers["Set-Cookie"] = sessionCookie(newSession());
        return json(res, 200, { ok: true, settings: publicSettings(saved), bot }, headers);
      }

      return json(res, 404, { ok: false, error: "Not found." });
    } catch (error) {
      console.error("Web UI request failed:", safeError(error));
      return json(res, 400, { ok: false, error: safeError(error) });
    }
  });

  server.listen(PORT, HOST, () => console.log(`MediaMedic Web UI listening on http://${HOST}:${PORT}`));
  return server;
}
