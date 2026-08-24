import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";

export class RepairDatabase {
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS repairs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        requester_id TEXT NOT NULL,
        requester_tag TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        title TEXT NOT NULL,
        reason TEXT NOT NULL,
        note TEXT,
        arr_id INTEGER NOT NULL,
        file_id INTEGER NOT NULL,
        episode_ids TEXT,
        season_number INTEGER,
        episode_number INTEGER,
        file_path TEXT,
        quality TEXT,
        file_size INTEGER,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        error TEXT
      );
    `);

    this.ensureColumn("tracking_message_id", "TEXT");
    this.ensureColumn("tracking_started_at", "TEXT");
    this.ensureColumn("tracking_detail", "TEXT");
    this.ensureColumn("replacement_file_id", "INTEGER");
    this.ensureColumn("replacement_file_path", "TEXT");
    this.ensureColumn("replacement_quality", "TEXT");
    this.ensureColumn("replacement_file_size", "INTEGER");
    this.ensureColumn("completed_at", "TEXT");
    this.ensureColumn("blocklist_status", "TEXT");
    this.ensureColumn("blocklist_history_id", "INTEGER");
    this.ensureColumn("blocklist_source_title", "TEXT");
    this.ensureColumn("blocklist_detail", "TEXT");
  }

  ensureColumn(name, definition) {
    const columns = this.db.prepare("PRAGMA table_info(repairs)").all();
    if (columns.some((column) => String(column.name) === name)) return;
    this.db.exec(`ALTER TABLE repairs ADD COLUMN ${name} ${definition}`);
  }

  create(input) {
    const now = new Date().toISOString();
    const row = {
      ...input,
      id: randomUUID(),
      status: "PENDING",
      createdAt: now,
      updatedAt: now,
    };
    this.db.prepare(`
      INSERT INTO repairs (
        id, kind, requester_id, requester_tag, guild_id, channel_id, title, reason, note,
        arr_id, file_id, episode_ids, season_number, episode_number, file_path, quality,
        file_size, status, created_at, updated_at, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.kind, row.requesterId, row.requesterTag, row.guildId, row.channelId,
      row.title, row.reason, row.note ?? null, row.arrId, row.fileId,
      row.episodeIds ? JSON.stringify(row.episodeIds) : null,
      row.seasonNumber ?? null, row.episodeNumber ?? null, row.filePath ?? null,
      row.quality ?? null, row.fileSize ?? null, row.status, row.createdAt, row.updatedAt, null,
    );
    return row;
  }

  get(id) {
    const row = this.db.prepare("SELECT * FROM repairs WHERE id = ?").get(id);
    return row ? this.fromRow(row) : undefined;
  }

  listTracking() {
    return this.db.prepare("SELECT * FROM repairs WHERE status = 'TRACKING' ORDER BY tracking_started_at ASC")
      .all()
      .map((row) => this.fromRow(row));
  }

  updateStatus(id, status, error) {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE repairs SET status = ?, updated_at = ?, error = ? WHERE id = ?")
      .run(status, now, error ?? null, id);
    return this.get(id);
  }

  startTracking(id, trackingMessageId) {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE repairs
      SET status = 'TRACKING', tracking_message_id = ?, tracking_started_at = COALESCE(tracking_started_at, ?),
          tracking_detail = 'SEARCHING', updated_at = ?, error = NULL
      WHERE id = ?
    `).run(trackingMessageId ?? null, now, now, id);
    return this.get(id);
  }

  setTrackingMessage(id, trackingMessageId) {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE repairs SET tracking_message_id = ?, updated_at = ? WHERE id = ?")
      .run(trackingMessageId, now, id);
    return this.get(id);
  }

  setTrackingDetail(id, detail) {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE repairs SET tracking_detail = ?, updated_at = ? WHERE id = ?")
      .run(detail, now, id);
    return this.get(id);
  }

  setBlocklistResult(id, result) {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE repairs
      SET blocklist_status = ?, blocklist_history_id = ?, blocklist_source_title = ?,
          blocklist_detail = ?, updated_at = ?
      WHERE id = ?
    `).run(
      result.status ?? null,
      result.historyId ?? null,
      result.sourceTitle ?? null,
      result.detail ?? null,
      now,
      id,
    );
    return this.get(id);
  }

  completeTracking(id, replacement) {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE repairs
      SET status = 'COMPLETED', tracking_detail = 'IMPORTED', replacement_file_id = ?,
          replacement_file_path = ?, replacement_quality = ?, replacement_file_size = ?,
          completed_at = ?, updated_at = ?, error = NULL
      WHERE id = ?
    `).run(
      replacement.fileId ?? null,
      replacement.filePath ?? null,
      replacement.quality ?? null,
      replacement.fileSize ?? null,
      now,
      now,
      id,
    );
    return this.get(id);
  }

  fromRow(row) {
    return {
      id: String(row.id),
      kind: String(row.kind),
      requesterId: String(row.requester_id),
      requesterTag: String(row.requester_tag),
      guildId: String(row.guild_id),
      channelId: String(row.channel_id),
      title: String(row.title),
      reason: String(row.reason),
      note: row.note == null ? undefined : String(row.note),
      arrId: Number(row.arr_id),
      fileId: Number(row.file_id),
      episodeIds: row.episode_ids ? JSON.parse(String(row.episode_ids)) : undefined,
      seasonNumber: row.season_number == null ? undefined : Number(row.season_number),
      episodeNumber: row.episode_number == null ? undefined : Number(row.episode_number),
      filePath: row.file_path == null ? undefined : String(row.file_path),
      quality: row.quality == null ? undefined : String(row.quality),
      fileSize: row.file_size == null ? undefined : Number(row.file_size),
      status: String(row.status),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      error: row.error == null ? undefined : String(row.error),
      trackingMessageId: row.tracking_message_id == null ? undefined : String(row.tracking_message_id),
      trackingStartedAt: row.tracking_started_at == null ? undefined : String(row.tracking_started_at),
      trackingDetail: row.tracking_detail == null ? undefined : String(row.tracking_detail),
      replacementFileId: row.replacement_file_id == null ? undefined : Number(row.replacement_file_id),
      replacementFilePath: row.replacement_file_path == null ? undefined : String(row.replacement_file_path),
      replacementQuality: row.replacement_quality == null ? undefined : String(row.replacement_quality),
      replacementFileSize: row.replacement_file_size == null ? undefined : Number(row.replacement_file_size),
      completedAt: row.completed_at == null ? undefined : String(row.completed_at),
      blocklistStatus: row.blocklist_status == null ? undefined : String(row.blocklist_status),
      blocklistHistoryId: row.blocklist_history_id == null ? undefined : Number(row.blocklist_history_id),
      blocklistSourceTitle: row.blocklist_source_title == null ? undefined : String(row.blocklist_source_title),
      blocklistDetail: row.blocklist_detail == null ? undefined : String(row.blocklist_detail),
    };
  }
}
