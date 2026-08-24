import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  GuildMember,
  REST,
  Routes,
} from "discord.js";
import { loadConfig } from "./config.js";
import { RadarrClient, SonarrClient } from "./arr.js";
import { commands } from "./commands.js";
import { RepairDatabase } from "./db.js";
import { bestTitleMatches, bytes, normalized, qualityName, safeError } from "./util.js";
import { findOriginalGrab } from "./release-history.js";

const config = loadConfig();
const radarr = new RadarrClient(config.radarrUrl, config.radarrApiKey);
const sonarr = new SonarrClient(config.sonarrUrl, config.sonarrApiKey);
const db = new RepairDatabase(config.databasePath);
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const AUTOCOMPLETE_CACHE_MS = 5 * 60 * 1000;
const autocompleteCache = {
  movies: { items: [], loadedAt: 0 },
  series: { items: [], loadedAt: 0 },
};

const TRACKING_POLL_MS = 15_000;
const TRACKING_TIMEOUT_MS = 6 * 60 * 60 * 1000;
let trackingTickRunning = false;

async function refreshAutocompleteCache(kind) {
  const bucket = autocompleteCache[kind];
  try {
    const items = kind === "movies" ? await radarr.listMovies() : await sonarr.listSeries();
    bucket.items = Array.isArray(items) ? items : [];
    bucket.loadedAt = Date.now();
    console.log(`Autocomplete cache refreshed: ${kind}=${bucket.items.length}`);
    return bucket.items;
  } catch (error) {
    console.error(`Autocomplete cache refresh failed (${kind})`, error);
    return bucket.items;
  }
}

async function warmAutocompleteCaches() {
  await Promise.allSettled([
    refreshAutocompleteCache("movies"),
    refreshAutocompleteCache("series"),
  ]);
}

function cachedAutocompleteItems(kind) {
  const bucket = autocompleteCache[kind];
  if (Date.now() - bucket.loadedAt > AUTOCOMPLETE_CACHE_MS) {
    void refreshAutocompleteCache(kind);
  }
  return bucket.items;
}

function isAdmin(member) {
  return member.permissions.has("Administrator") || (!!config.adminRoleId && member.roles.cache.has(config.adminRoleId));
}

function canRepair(member) {
  return isAdmin(member) || (!!config.repairRoleId && member.roles.cache.has(config.repairRoleId));
}

function requireMember(interaction) {
  return interaction.member instanceof GuildMember ? interaction.member : undefined;
}

function allowedContext(interaction) {
  if (!interaction.guildId || String(interaction.guildId) !== String(config.discordGuildId)) return false;
  if (config.allowedChannelId && String(interaction.channelId) !== String(config.allowedChannelId)) return false;
  return true;
}

function contextMessage() {
  if (config.allowedChannelId) return `MediaMedic can only be used in <#${config.allowedChannelId}>.`;
  return "MediaMedic can only be used in the configured Discord server.";
}

function actionRows(requestId, disabled = false) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`repair:confirm:${requestId}`)
        .setLabel("Confirm repair")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(`repair:cancel:${requestId}`)
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled),
    ),
  ];
}

function requestEmbed(request, footer) {
  const lines = [
    `**Type:** ${request.kind === "movie" ? "Movie" : "TV episode"}`,
    `**Title:** ${request.title}`,
  ];
  if (request.kind === "episode") {
    lines.push(`**Episode:** S${String(request.seasonNumber).padStart(2, "0")}E${String(request.episodeNumber).padStart(2, "0")}`);
  }
  lines.push(
    `**Reason:** ${request.reason}`,
    `**Quality:** ${request.quality ?? "Unknown"}`,
    `**Size:** ${bytes(request.fileSize)}`,
    `**File:** \`${request.filePath ?? "Unknown"}\``,
  );
  if (request.note) lines.push(`**Note:** ${request.note}`);
  if ((request.episodeIds?.length ?? 0) > 1) {
    lines.push(`\n⚠️ **Multi-episode file:** this physical file maps to ${request.episodeIds.length} Sonarr episodes. Confirming removes the shared file and searches all mapped episodes.`);
  }

  return new EmbedBuilder()
    .setTitle(config.dryRun ? "MediaMedic repair preview — DRY RUN" : "MediaMedic repair confirmation")
    .setDescription(lines.join("\n"))
    .setFooter({ text: footer ?? `Request ${request.id}` })
    .setTimestamp(new Date(request.createdAt));
}

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(config.discordToken);
  if (config.discordGuildId) {
    await rest.put(Routes.applicationGuildCommands(config.discordClientId, config.discordGuildId), { body: commands });
    console.log(`Registered guild commands in ${config.discordGuildId}`);
  } else {
    await rest.put(Routes.applicationCommands(config.discordClientId), { body: commands });
    console.log("Registered global commands");
  }
}

async function autocomplete(interaction) {
  if (!allowedContext(interaction)) return interaction.respond([]);
  const focused = interaction.options.getFocused(true);
  if (focused.name !== "title") return interaction.respond([]);
  const query = String(focused.value ?? "").trim();
  if (!query) return interaction.respond([]);
  const sub = interaction.options.getSubcommand(false);

  try {
    if (sub === "movie") {
      const movies = bestTitleMatches(cachedAutocompleteItems("movies"), query);
      await interaction.respond(movies.map((m) => ({
        name: `${m.title}${m.year ? ` (${m.year})` : ""}`.slice(0, 100),
        value: `id:${m.id}`,
      })));
    } else if (sub === "episode") {
      const series = bestTitleMatches(cachedAutocompleteItems("series"), query);
      await interaction.respond(series.map((s) => ({
        name: `${s.title}${s.year ? ` (${s.year})` : ""}`.slice(0, 100),
        value: `id:${s.id}`,
      })));
    } else {
      await interaction.respond([]);
    }
  } catch (error) {
    console.error("Autocomplete failed", error);
    await interaction.respond([]).catch(() => undefined);
  }
}

function parseSelectedId(value) {
  const match = /^id:(\d+)$/.exec(value);
  return match ? Number(match[1]) : undefined;
}

async function resolveMovie(value) {
  const selectedId = parseSelectedId(value);
  if (selectedId) return radarr.getMovie(selectedId);
  const movies = bestTitleMatches(await radarr.listMovies(), value, 5);
  const exact = movies.find((m) => normalized(m.title) === normalized(value));
  if (exact) return exact;
  if (movies.length === 1) return movies[0];
  throw new Error("Movie title was ambiguous. Re-run /repair and select the title from autocomplete.");
}

async function resolveSeries(value) {
  const selectedId = parseSelectedId(value);
  const allSeries = await sonarr.listSeries();
  if (selectedId) {
    const series = allSeries.find((s) => s.id === selectedId);
    if (!series) throw new Error("Selected series no longer exists in Sonarr.");
    return series;
  }
  const series = bestTitleMatches(allSeries, value, 5);
  const exact = series.find((s) => normalized(s.title) === normalized(value));
  if (exact) return exact;
  if (series.length === 1) return series[0];
  throw new Error("Series title was ambiguous. Re-run /repair and select the title from autocomplete.");
}

async function handleRepair(interaction) {
  if (!allowedContext(interaction)) {
    return interaction.reply({ content: contextMessage(), ephemeral: true });
  }
  const member = requireMember(interaction);
  if (!member || !canRepair(member)) {
    return interaction.reply({ content: "You do not have the configured MediaMedic repair role.", ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });
  const sub = interaction.options.getSubcommand();
  const titleValue = interaction.options.getString("title", true);
  const reason = interaction.options.getString("reason", true);
  const note = interaction.options.getString("note") ?? undefined;

  try {
    let request;
    if (sub === "movie") {
      const movie = await resolveMovie(titleValue);
      if (!movie.hasFile || !movie.movieFile?.id) throw new Error(`${movie.title} does not currently have a Radarr-managed movie file.`);
      const file = await radarr.getMovieFile(movie.movieFile.id);
      request = db.create({
        kind: "movie",
        requesterId: interaction.user.id,
        requesterTag: interaction.user.tag,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        title: `${movie.title}${movie.year ? ` (${movie.year})` : ""}`,
        reason,
        note,
        arrId: movie.id,
        fileId: file.id,
        filePath: file.relativePath ?? file.path,
        quality: qualityName(file),
        fileSize: file.size,
      });
    } else {
      const series = await resolveSeries(titleValue);
      const season = interaction.options.getInteger("season", true);
      const episodeNumber = interaction.options.getInteger("episode", true);
      const episodes = await sonarr.getEpisodes(series.id);
      const episode = episodes.find((e) => e.seasonNumber === season && e.episodeNumber === episodeNumber);
      if (!episode) throw new Error(`${series.title} S${season}E${episodeNumber} does not exist in Sonarr.`);
      if (!episode.hasFile || !episode.episodeFileId) throw new Error(`${series.title} S${season}E${episodeNumber} does not currently have a Sonarr-managed file.`);
      const file = await sonarr.getEpisodeFile(episode.episodeFileId);
      request = db.create({
        kind: "episode",
        requesterId: interaction.user.id,
        requesterTag: interaction.user.tag,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        title: `${series.title} — ${episode.title ?? "Untitled"}`,
        reason,
        note,
        arrId: episode.id,
        fileId: file.id,
        episodeIds: file.episodeIds?.length ? file.episodeIds : [episode.id],
        seasonNumber: season,
        episodeNumber,
        filePath: file.relativePath ?? file.path,
        quality: qualityName(file),
        fileSize: file.size,
      });
    }

    await interaction.editReply({ embeds: [requestEmbed(request)], components: actionRows(request.id) });
  } catch (error) {
    await interaction.editReply(`MediaMedic could not create the repair request: ${safeError(error)}`);
  }
}

async function handleHealth(interaction) {
  if (!allowedContext(interaction)) {
    return interaction.reply({ content: contextMessage(), ephemeral: true });
  }
  const member = requireMember(interaction);
  if (!member || !canRepair(member)) {
    return interaction.reply({ content: "You do not have the configured MediaMedic repair role.", ephemeral: true });
  }
  await interaction.deferReply({ ephemeral: true });
  const results = await Promise.allSettled([radarr.health(), sonarr.health()]);
  const radarrState = results[0].status === "fulfilled" ? `Connected — ${results[0].value}` : `ERROR — ${safeError(results[0].reason)}`;
  const sonarrState = results[1].status === "fulfilled" ? `Connected — ${results[1].value}` : `ERROR — ${safeError(results[1].reason)}`;
  await interaction.editReply([
    "**MediaMedic health**",
    `Radarr: ${radarrState}`,
    `Sonarr: ${sonarrState}`,
    `Safety mode: **${config.dryRun ? "DRY RUN — nothing can be deleted" : "LIVE — confirmed repairs can delete managed media files"}**`,
    `Repair tracking: **Enabled — ${db.listTracking().length} active**`,
  ].join("\n"));
}

async function identifyAndBlocklist(request, file, { seriesId } = {}) {
  let history;
  let arrClient;
  if (request.kind === "movie") {
    history = await radarr.movieHistory(request.arrId);
    arrClient = radarr;
  } else {
    history = await sonarr.seriesHistory(seriesId);
    arrClient = sonarr;
  }

  const match = findOriginalGrab(history, file);
  if (!match.matched) {
    const result = {
      status: config.dryRun ? "DRY_RUN_SKIPPED" : "SKIPPED",
      detail: match.detail,
    };
    db.setBlocklistResult(request.id, result);
    console.warn(`Release blocklist skipped for ${request.id}: ${match.detail}`);
    return result;
  }

  if (config.dryRun) {
    const result = {
      status: "DRY_RUN_MATCH",
      historyId: match.historyId,
      sourceTitle: match.sourceTitle,
      detail: `DRY RUN: would mark history ${match.historyId} failed/blocklisted. ${match.detail}`,
    };
    db.setBlocklistResult(request.id, result);
    console.log(`DRY RUN blocklist match for ${request.id}: history=${match.historyId} release=${match.sourceTitle}`);
    return result;
  }

  try {
    await arrClient.markHistoryFailed(match.historyId);
  } catch (error) {
    const detail = `MediaMedic identified ${match.sourceTitle} (history ${match.historyId}) but ${request.kind === "movie" ? "Radarr" : "Sonarr"} refused the blocklist operation: ${safeError(error)}`;
    db.setBlocklistResult(request.id, {
      status: "FAILED",
      historyId: match.historyId,
      sourceTitle: match.sourceTitle,
      detail,
    });
    throw new Error(`${detail}. The original media file was NOT deleted.`);
  }

  const result = {
    status: "BLOCKLISTED",
    historyId: match.historyId,
    sourceTitle: match.sourceTitle,
    detail: match.detail,
  };
  db.setBlocklistResult(request.id, result);
  console.log(`Original release blocklisted for ${request.id}: history=${match.historyId} release=${match.sourceTitle}`);
  return result;
}

async function performRepair(request) {
  if (request.kind === "movie") {
    const movie = await radarr.getMovie(request.arrId);
    if (!movie.hasFile || !movie.movieFile?.id) throw new Error("Radarr says this movie no longer has a file.");
    if (movie.movieFile.id !== request.fileId) throw new Error("Radarr's current movie file changed since this request was created. Refusing to delete it.");
    const file = await radarr.getMovieFile(request.fileId);
    if (file.movieId !== request.arrId) throw new Error("Movie-file ownership changed. Refusing repair.");
    await identifyAndBlocklist(request, file);
    if (!config.dryRun) {
      await radarr.deleteMovieFile(request.fileId);
      await radarr.searchMovie(request.arrId);
    }
    return db.get(request.id);
  }

  const episode = await sonarr.getEpisode(request.arrId);
  if (!episode.hasFile || !episode.episodeFileId) throw new Error("Sonarr says this episode no longer has a file.");
  if (episode.episodeFileId !== request.fileId) throw new Error("Sonarr's current episode file changed since this request was created. Refusing to delete it.");
  const file = await sonarr.getEpisodeFile(request.fileId);
  const ids = file.episodeIds?.length ? file.episodeIds : request.episodeIds ?? [request.arrId];
  if (!ids.includes(request.arrId)) throw new Error("Episode-file ownership changed. Refusing repair.");
  await identifyAndBlocklist(request, file, { seriesId: episode.seriesId });
  if (!config.dryRun) {
    await sonarr.deleteEpisodeFile(request.fileId);
    await sonarr.searchEpisodes(ids);
  }
  return db.get(request.id);
}

function elapsedText(start, end = new Date()) {
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return "Unknown";
  const seconds = Math.max(0, Math.round((endMs - startMs) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

function trackingLinkRow(request, messageId) {
  if (!messageId) return [];
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel("View repair status")
        .setStyle(ButtonStyle.Link)
        .setURL(`https://discord.com/channels/${request.guildId}/${request.channelId}/${messageId}`),
    ),
  ];
}

function blocklistLine(request) {
  switch (request.blocklistStatus) {
    case "BLOCKLISTED":
      return `✅ Original release blocklisted${request.blocklistSourceTitle ? ` — \`${request.blocklistSourceTitle}\`` : ""}`;
    case "SKIPPED":
      return "⚠️ Original release not blocklisted — exact history match was not proven";
    case "FAILED":
      return "❌ Original release blocklist failed — repair was stopped before file deletion";
    case "DRY_RUN_MATCH":
      return `🧪 DRY RUN would blocklist${request.blocklistSourceTitle ? ` — \`${request.blocklistSourceTitle}\`` : " the matched release"}`;
    case "DRY_RUN_SKIPPED":
      return "🧪 DRY RUN found no exact release-history match to blocklist";
    default:
      return "⏳ Identifying original release for blocklist";
  }
}

function trackingEmbed(request, state) {
  const stage = state.stage ?? request.trackingDetail ?? "SEARCHING";
  const steps = {
    PREPARING: ["⏳ Verifying repair request", "⬜ Bad file removed", "⬜ Replacement search started", "⬜ Replacement imported"],
    SEARCHING: ["✅ Bad file removed", "✅ Replacement search started", "⏳ Waiting for a release", "⬜ Replacement imported"],
    DOWNLOADING: ["✅ Bad file removed", "✅ Replacement search started", "✅ Replacement grabbed", "⏳ Downloading replacement"],
    IMPORTING: ["✅ Bad file removed", "✅ Replacement search started", "✅ Replacement downloaded", "⏳ Waiting for import"],
    IMPORTED: ["✅ Bad file removed", "✅ Replacement search started", "✅ Replacement downloaded", "✅ Imported by " + (request.kind === "movie" ? "Radarr" : "Sonarr")],
    TIMED_OUT: ["✅ Bad file removed", "✅ Replacement search started", "⚠️ Replacement not confirmed", "⚠️ Manual review recommended"],
    FAILED: ["❌ Repair failed before tracking completed"],
  };

  const lines = [
    `**Item:** ${request.title}`,
    request.kind === "episode" ? `**Episode:** S${String(request.seasonNumber).padStart(2, "0")}E${String(request.episodeNumber).padStart(2, "0")}` : undefined,
    `**Reported problem:** ${request.reason}`,
    "",
    blocklistLine(request),
    ...(steps[stage] ?? steps.SEARCHING),
  ].filter((value) => value !== undefined);

  if (state.progress != null) {
    lines.push(`**Download progress:** ${state.progress}%${state.timeLeft ? ` — ${state.timeLeft} remaining` : ""}`);
  }
  if (state.queueStatus) lines.push(`**Queue status:** ${state.queueStatus}`);

  lines.push("", `**Old:** ${request.quality ?? "Unknown"} • ${bytes(request.fileSize)}`, `\`${request.filePath ?? "Unknown"}\``);

  const replacementPath = state.replacement?.filePath ?? request.replacementFilePath;
  const replacementQuality = state.replacement?.quality ?? request.replacementQuality;
  const replacementSize = state.replacement?.fileSize ?? request.replacementFileSize;
  if (replacementPath) {
    lines.push("", `**Replacement:** ${replacementQuality ?? "Unknown"} • ${bytes(replacementSize)}`, `\`${replacementPath}\``);
  }

  if (stage === "IMPORTED") {
    lines.push("", `**Completed in:** ${elapsedText(request.trackingStartedAt ?? request.createdAt, request.completedAt ?? new Date())}`);
  }
  if (stage === "TIMED_OUT") {
    lines.push("", "MediaMedic stopped automatic tracking after 6 hours. The *arr search may still complete later; check the server if needed.");
  }
  if (state.error) lines.push("", `**Error:** ${state.error}`);

  const title = stage === "IMPORTED"
    ? "MediaMedic repair complete"
    : stage === "TIMED_OUT"
      ? "MediaMedic repair needs attention"
      : stage === "FAILED"
        ? "MediaMedic repair failed"
        : "MediaMedic repair in progress";

  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(lines.join("\n"))
    .setFooter({ text: `Repair ${request.id}` })
    .setTimestamp(new Date());
}

async function trackingChannel(request) {
  const channel = await client.channels.fetch(request.channelId);
  if (!channel?.isTextBased?.() || typeof channel.send !== "function") {
    throw new Error("MediaMedic cannot post repair tracking messages in the configured Discord channel. Grant the bot View Channel, Send Messages, and Embed Links there.");
  }
  return channel;
}

async function publishTracking(request, state, { notify = false } = {}) {
  const channel = await trackingChannel(request);
  const content = notify
    ? (state.stage === "IMPORTED"
        ? `<@${request.requesterId}> ✅ Your MediaMedic repair is complete.`
        : `<@${request.requesterId}> ⚠️ MediaMedic needs attention on this repair.`)
    : "";
  const payload = {
    content,
    embeds: [trackingEmbed(request, state)],
    allowedMentions: { parse: [], users: notify ? [request.requesterId] : [] },
  };

  if (request.trackingMessageId) {
    try {
      const message = await channel.messages.edit(request.trackingMessageId, payload);
      return { request, message };
    } catch (error) {
      console.warn(`Unable to edit tracking message ${request.trackingMessageId}; creating a replacement status post.`, safeError(error));
    }
  }

  const message = await channel.send(payload);
  const updated = db.setTrackingMessage(request.id, message.id);
  return { request: updated, message };
}

function queueState(item) {
  if (!item) return { stage: "SEARCHING", key: "SEARCHING" };
  const size = Number(item.size ?? 0);
  const sizeLeft = Number(item.sizeleft ?? item.sizeLeft ?? 0);
  const status = String(item.status ?? item.trackedDownloadStatus ?? item.trackedDownloadState ?? "downloading");
  const progress = size > 0 ? Math.max(0, Math.min(100, Math.round(((size - sizeLeft) / size) * 100))) : undefined;
  const lower = status.toLowerCase();
  const stage = (size > 0 && sizeLeft <= 0) || lower.includes("import") || lower.includes("completed")
    ? "IMPORTING"
    : "DOWNLOADING";
  const bucket = progress == null ? "x" : Math.floor(progress / 5) * 5;
  return {
    stage,
    key: `${stage}:${bucket}:${status}`,
    progress,
    timeLeft: item.timeleft ?? item.timeLeft,
    queueStatus: status,
  };
}

async function inspectTrackedRepair(request) {
  if (request.kind === "movie") {
    const movie = await radarr.getMovie(request.arrId);
    if (movie.hasFile && movie.movieFile?.id && Number(movie.movieFile.id) !== Number(request.fileId)) {
      const file = await radarr.getMovieFile(movie.movieFile.id);
      return {
        stage: "IMPORTED",
        key: "IMPORTED",
        replacement: {
          fileId: file.id,
          filePath: file.relativePath ?? file.path,
          quality: qualityName(file),
          fileSize: file.size,
        },
      };
    }
    try {
      return queueState(await radarr.findQueueItem(request.arrId));
    } catch (error) {
      console.warn(`Radarr queue check failed for ${request.id}:`, safeError(error));
      return { stage: "SEARCHING", key: "SEARCHING" };
    }
  }

  const ids = request.episodeIds?.length ? request.episodeIds : [request.arrId];
  const episodes = await Promise.all(ids.map((id) => sonarr.getEpisode(id)));
  const restored = episodes.every((episode) => episode.hasFile && episode.episodeFileId && Number(episode.episodeFileId) !== Number(request.fileId));
  if (restored) {
    const target = episodes.find((episode) => Number(episode.id) === Number(request.arrId)) ?? episodes[0];
    const file = await sonarr.getEpisodeFile(target.episodeFileId);
    return {
      stage: "IMPORTED",
      key: "IMPORTED",
      replacement: {
        fileId: file.id,
        filePath: file.relativePath ?? file.path,
        quality: qualityName(file),
        fileSize: file.size,
      },
    };
  }
  try {
    return queueState(await sonarr.findQueueItem(ids));
  } catch (error) {
    console.warn(`Sonarr queue check failed for ${request.id}:`, safeError(error));
    return { stage: "SEARCHING", key: "SEARCHING" };
  }
}

async function trackRepair(request) {
  const started = new Date(request.trackingStartedAt ?? request.updatedAt ?? request.createdAt).getTime();
  if (Number.isFinite(started) && Date.now() - started >= TRACKING_TIMEOUT_MS) {
    const timedOut = db.updateStatus(request.id, "TIMED_OUT", "Replacement was not confirmed within 6 hours.");
    await publishTracking(timedOut, { stage: "TIMED_OUT" }, { notify: true }).catch((error) => {
      console.error(`Unable to publish timeout for ${request.id}:`, safeError(error));
    });
    return;
  }

  try {
    const state = await inspectTrackedRepair(request);
    if (state.stage === "IMPORTED") {
      const completed = db.completeTracking(request.id, state.replacement);
      await publishTracking(completed, state, { notify: true });
      console.log(`Repair completed: ${request.id} ${request.title}`);
      return;
    }

    if (state.key !== request.trackingDetail) {
      const updated = db.setTrackingDetail(request.id, state.key);
      await publishTracking(updated, state);
    }
  } catch (error) {
    console.error(`Repair tracking check failed for ${request.id}:`, safeError(error));
  }
}

async function trackingTick() {
  if (trackingTickRunning || !client.isReady()) return;
  trackingTickRunning = true;
  try {
    const repairs = db.listTracking();
    for (const request of repairs) await trackRepair(request);
  } finally {
    trackingTickRunning = false;
  }
}

async function handleButton(interaction) {
  if (!allowedContext(interaction)) {
    return interaction.reply({ content: contextMessage(), ephemeral: true });
  }
  const [namespace, action, id] = interaction.customId.split(":");
  if (namespace !== "repair" || !id || !["confirm", "cancel"].includes(action)) return;
  const request = db.get(id);
  if (!request) return interaction.reply({ content: "That repair request no longer exists.", ephemeral: true });
  const member = requireMember(interaction);
  if (!member) return interaction.reply({ content: "Unable to resolve your server membership.", ephemeral: true });

  const ownsRequest = request.requesterId === interaction.user.id;
  if (!isAdmin(member) && !ownsRequest) {
    return interaction.reply({ content: "Only the requester or a MediaMedic admin can act on this repair.", ephemeral: true });
  }
  if (!canRepair(member)) {
    return interaction.reply({ content: "You no longer have the configured MediaMedic repair role.", ephemeral: true });
  }
  if (request.status !== "PENDING") {
    return interaction.reply({ content: `This request is already ${request.status}.`, ephemeral: true });
  }

  if (action === "cancel") {
    const cancelled = db.updateStatus(id, "CANCELLED");
    return interaction.update({ embeds: [requestEmbed(cancelled, `CANCELLED by ${interaction.user.tag}`)], components: actionRows(id, true) });
  }

  await interaction.deferUpdate();
  db.updateStatus(id, "PROCESSING");
  let trackingMessage;
  try {
    if (config.dryRun) {
      const checked = await performRepair(request);
      const updated = db.updateStatus(id, "DRY_RUN");
      const blocklistNote = checked?.blocklistStatus === "DRY_RUN_MATCH"
        ? ` Original release match found; LIVE mode would blocklist: ${checked.blocklistSourceTitle}.`
        : " No exact original-release history match was proven, so MediaMedic would not guess at a blocklist entry.";
      return interaction.editReply({
        embeds: [requestEmbed(updated, `DRY RUN verified successfully by ${interaction.user.tag}. No file was deleted and no search was started.${blocklistNote}`)],
        components: actionRows(id, true),
      });
    }

    // Create the public tracking post BEFORE deleting anything. If MediaMedic cannot
    // post status updates in the channel, the destructive repair is aborted.
    const prepared = await publishTracking(db.get(id), { stage: "PREPARING" });
    trackingMessage = prepared.message;

    await performRepair(request);
    let tracking = db.startTracking(id, trackingMessage.id);
    await publishTracking(tracking, { stage: "SEARCHING" });

    await interaction.editReply({
      embeds: [requestEmbed(tracking, `REPAIR STARTED by ${interaction.user.tag}. MediaMedic is tracking the replacement and will notify you when it is imported.`)],
      components: trackingLinkRow(tracking, trackingMessage.id),
    });

    void trackingTick();
  } catch (error) {
    const message = safeError(error);
    const failed = db.updateStatus(id, "FAILED", message);
    if (trackingMessage) {
      await publishTracking(failed, { stage: "FAILED", error: message }, { notify: true }).catch(() => undefined);
    }
    await interaction.editReply({ embeds: [requestEmbed(failed, `FAILED: ${message}`)], components: actionRows(id, true) });
  }
}

client.on("interactionCreate", async (interaction) => {
  try {
    // Enforce guild/channel scope at the router before ANY command or button handler.
    // Discord Administrators can bypass Discord's native command-permission UI,
    // but they cannot bypass this application-side lock.
    if (!allowedContext(interaction)) {
      console.warn(
        `Blocked Discord interaction outside configured scope: type=${interaction.type} guild=${interaction.guildId ?? "DM"} channel=${interaction.channelId ?? "none"} allowedGuild=${config.discordGuildId ?? "none"} allowedChannel=${config.allowedChannelId ?? "any"}`,
      );

      if (interaction.isAutocomplete()) {
        return void interaction.respond([]).catch(() => undefined);
      }

      if (interaction.isRepliable()) {
        return void interaction.reply({ content: contextMessage(), ephemeral: true }).catch(() => undefined);
      }
      return;
    }

    if (interaction.isAutocomplete()) return void autocomplete(interaction);
    if (interaction.isButton()) return void handleButton(interaction);
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName === "repair") return void handleRepair(interaction);
    if (interaction.commandName === "mediamedic" && interaction.options.getSubcommand() === "health") return void handleHealth(interaction);
  } catch (error) {
    console.error("Interaction failed", error);
    if (interaction.isRepliable()) {
      const content = `MediaMedic error: ${safeError(error)}`;
      if (interaction.deferred || interaction.replied) await interaction.followUp({ content, ephemeral: true }).catch(() => undefined);
      else await interaction.reply({ content, ephemeral: true }).catch(() => undefined);
    }
  }
});

client.once("clientReady", (readyClient) => {
  console.log(`MediaMedic logged in as ${readyClient.user.tag}`);
  console.log(`Guild lock: ${config.discordGuildId ?? "NONE"}`);
  console.log(`Channel lock: ${config.allowedChannelId ?? "NONE (all guild channels allowed)"}`);
  console.log(`Safety mode: ${config.dryRun ? "DRY RUN" : "LIVE"}`);
  process.send?.({ type: "state", state: "online", tag: readyClient.user.tag, dryRun: config.dryRun });

  const timer = setInterval(() => {
    void warmAutocompleteCaches();
  }, AUTOCOMPLETE_CACHE_MS);
  timer.unref?.();


  const trackingTimer = setInterval(() => {
    void trackingTick();
  }, TRACKING_POLL_MS);
  trackingTimer.unref?.();

  const resumable = db.listTracking().length;
  console.log(`Repair tracker: ${resumable} active repair${resumable === 1 ? "" : "s"} to monitor`);
  void trackingTick();
});

process.on("SIGTERM", () => {
  process.send?.({ type: "state", state: "stopping" });
  client.destroy();
  process.exit(0);
});

try {
  process.send?.({ type: "state", state: "starting" });
  await warmAutocompleteCaches();
  await registerCommands();
  await client.login(config.discordToken);
} catch (error) {
  process.send?.({ type: "state", state: "error", error: safeError(error) });
  throw error;
}
