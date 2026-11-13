/** 仅供停写后的受控导入调用；运行服务不扫描或混入本机文件。 */
import { createHash } from "node:crypto";
import { validateCommittedWrites, type CommittedWrite } from "@earendil-works/pi-agent-core";
import { addressHash, applySessionRecord, emptySessionStats } from "./databaseSessionStorage.js";
import type { LegacySession } from "./legacySessions.js";
import type { SessionDatabase } from "./sessionDatabase.js";

const markerNamespace = "askmetric.migration";
const digest = (content: string) => createHash("sha256").update(content).digest("hex");
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("SESSION_IMPORT_INVALID");
  return value as Record<string, unknown>;
}
function identity(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 128)
    throw new Error("SESSION_IMPORT_ID_INVALID");
  return value;
}
function timestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("SESSION_IMPORT_TIMESTAMP_INVALID");
  return value;
}

export function parseLegacySession(content: string, owner: string): LegacySession {
  const item = object(JSON.parse(content));
  identity(item.id);
  if (identity(item.userId) !== identity(owner)) throw new Error("SESSION_IMPORT_OWNER_MISMATCH");
  if (
    typeof item.title !== "string" ||
    typeof item.username !== "string" ||
    !Array.isArray(item.messages)
  )
    throw new Error("SESSION_IMPORT_INVALID");
  timestamp(item.createdAt);
  timestamp(item.lastActiveAt);
  return item as unknown as LegacySession;
}

/** 已删除归档保留墓碑；重试导入不能复活删除记录。 */
export async function importLegacySession(
  database: SessionDatabase,
  owner: string,
  content: string,
) {
  const item = parseLegacySession(content, owner);
  const checksum = digest(content);
  return database.transaction(async (sql) => {
    const [existing] = await sql.query(
      "SELECT * FROM agent_legacy_sessions WHERE session_id = ? FOR UPDATE",
      [item.id],
    );
    if (existing) {
      if (
        existing.owner_user_id !== owner ||
        existing.content_sha256 !== checksum ||
        Number(existing.deleted)
      )
        throw new Error("SESSION_IMPORT_CONFLICT");
      return "unchanged" as const;
    }
    if (
      (await sql.query("SELECT session_id FROM agent_sessions WHERE session_id = ?", [item.id]))
        .length
    )
      throw new Error("SESSION_IMPORT_CONFLICT");
    await sql.execute(
      "INSERT INTO agent_legacy_sessions (session_id, owner_user_id, content_sha256, content_json, deleted) VALUES (?, ?, ?, ?, 0)",
      [item.id, owner, checksum, JSON.stringify(item)],
    );
    return "imported" as const;
  });
}

export function parseNativeSession(content: string, owner: string, modifiedAt: number) {
  identity(owner);
  timestamp(modifiedAt);
  // 不把不完整尾行当成成功迁移；不调用 SDK 的原地修复，源文件始终只读。
  if (!content.endsWith("\n")) throw new Error("SESSION_IMPORT_INCOMPLETE");
  const lines = content.trimEnd().split("\n");
  const header = object(JSON.parse(lines.shift()!));
  if (header.v !== 4 || header.kind !== "header" || header.storageVersion !== 1)
    throw new Error("SESSION_IMPORT_FORMAT_UNSUPPORTED");
  const id = identity(header.id),
    created = timestamp(header.createdAt);
  const records: CommittedWrite[] = [];
  const ids = new Set<string>(),
    entries = new Set<string>();
  const values = new Map<string, unknown>();
  const stats = emptySessionStats();
  let nextSeq = 1;
  for (const line of lines) {
    const parsed: unknown = JSON.parse(line);
    const writes = (Array.isArray(parsed) ? parsed : [parsed]).map((raw) => {
      const write = object(raw);
      if (
        !Number.isSafeInteger(write.seq) ||
        Number(write.seq) < 1 ||
        !["entry", "usage", "value", "list"].includes(String(write.kind))
      )
        throw new Error("SESSION_IMPORT_RECORD_INVALID");
      if (write.kind === "entry" || write.kind === "usage") identity(write.id);
      if (write.kind === "entry") {
        timestamp(write.timestamp);
        if (write.parentId !== null) identity(write.parentId);
        if (!["message", "custom", "compaction", "branch_summary"].includes(String(write.type)))
          throw new Error("SESSION_IMPORT_RECORD_INVALID");
      }
      if (write.kind === "value" || write.kind === "list") {
        if (
          typeof write.namespace !== "string" ||
          write.namespace.length > 255 ||
          typeof write.key !== "string" ||
          !(write.kind === "value" ? ["set", "delete"] : ["append", "delete"]).includes(
            String(write.op),
          )
        )
          throw new Error("SESSION_IMPORT_RECORD_INVALID");
      }
      return write as unknown as CommittedWrite;
    });
    validateCommittedWrites(writes, nextSeq, {
      hasEntryOrUsageId: (key) => ids.has(key),
      hasEntryId: (key) => entries.has(key),
    });
    for (const write of writes) {
      records.push(write);
      nextSeq = write.seq + 1;
      if (write.kind === "entry" || write.kind === "usage") ids.add(write.id);
      if (write.kind === "entry") {
        entries.add(write.id);
        if (write.type === "message") stats.messageCount++;
      }
      if (write.kind === "usage") {
        for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
          if (!Number.isFinite(write.usage?.[key])) throw new Error("SESSION_IMPORT_USAGE_INVALID");
          stats.usage[key] += write.usage[key];
        }
        for (const key of ["cacheWrite1h", "reasoning"] as const)
          if (write.usage[key] !== undefined)
            stats.usage[key] = (stats.usage[key] ?? 0) + write.usage[key];
        for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
          if (!Number.isFinite(write.usage.cost?.[key]))
            throw new Error("SESSION_IMPORT_USAGE_INVALID");
          stats.usage.cost[key] += write.usage.cost[key];
        }
      }
      if (write.kind === "value") {
        const key = addressHash(write.namespace, write.key);
        if (write.op === "set") values.set(key, write.value);
        else values.delete(key);
      }
    }
  }
  if (values.get(addressHash("askmetric", "owner")) !== owner)
    throw new Error("SESSION_IMPORT_OWNER_MISMATCH");
  const lane = values.get(addressHash("pi.lane.state", "main"));
  const current = lane ? object(lane).currentOperationId : null;
  // 未结束操作没有完整的新配置版本绑定，禁止在迁移时猜测并自动重跑。
  if (current) throw new Error("SESSION_IMPORT_ACTIVE_OPERATION");
  const title = values.get(addressHash("pi.session.name", ""));
  if (title !== undefined && (typeof title !== "string" || title.length > 255))
    throw new Error("SESSION_IMPORT_TITLE_INVALID");
  if (header.nextSeq !== undefined) nextSeq = Math.max(nextSeq, timestamp(header.nextSeq));
  if (!Number.isSafeInteger(nextSeq)) throw new Error("SESSION_IMPORT_SEQUENCE_INVALID");
  return {
    id,
    created,
    modifiedAt,
    records,
    stats,
    title: title ?? null,
    nextSeq,
    checksum: digest(content),
  };
}

/** 一会话一事务，原生 entry/seq/分支/values/lists/usage 全部保留；不覆盖已有历史。 */
export async function importNativeSession(
  database: SessionDatabase,
  owner: string,
  content: string,
  modifiedAt: number,
) {
  const item = parseNativeSession(content, owner, modifiedAt);
  return database.transaction(async (sql) => {
    const [existing] = await sql.query(
      "SELECT * FROM agent_sessions WHERE session_id = ? FOR UPDATE",
      [item.id],
    );
    if (existing) {
      const [marker] = await sql.query(
        "SELECT data_json FROM agent_session_records WHERE session_id = ? AND record_id = ?",
        [item.id, `v:${addressHash(markerNamespace, "source")}`],
      );
      const record: unknown = marker ? JSON.parse(String(marker.data_json)) : null;
      if (
        existing.owner_user_id !== owner ||
        Number(existing.deleted) ||
        !record ||
        object(record).value !== item.checksum
      )
        throw new Error("SESSION_IMPORT_CONFLICT");
      return "unchanged" as const;
    }
    if (
      (
        await sql.query("SELECT session_id FROM agent_legacy_sessions WHERE session_id = ?", [
          item.id,
        ])
      ).length
    )
      throw new Error("SESSION_IMPORT_CONFLICT");
    await sql.execute(
      "INSERT INTO agent_sessions (session_id, owner_user_id, created_ms, modified_ms, next_seq, stats_json, title, deleted, lease_token, lease_until_ms, event_seq) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0)",
      [
        item.id,
        owner,
        item.created,
        item.modifiedAt,
        item.nextSeq + 1,
        JSON.stringify(item.stats),
        item.title,
      ],
    );
    for (const write of item.records) await applySessionRecord(sql, item.id, write);
    await applySessionRecord(sql, item.id, {
      kind: "value",
      op: "set",
      namespace: markerNamespace,
      key: "source",
      seq: item.nextSeq,
      value: item.checksum,
    });
    return "imported" as const;
  });
}
