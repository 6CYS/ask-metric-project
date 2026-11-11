/**
 * Pi 公共 Storage 接口的数据库实现。原生 Session/分支/压缩/操作检查点仍由 SDK 管理。
 * 每次写事务先锁会话元数据并校验租约代次，防止暂停、失联的旧节点恢复后继续写入。
 */
import { createHash } from "node:crypto";
import {
  prepareStorageCommit,
  validateCommittedWrites,
  resolveListReadOptions,
  type Storage,
  type Write,
  type Entry,
  type UsageRow,
  type SessionStats,
  type StoredValue,
  type Value,
  type ValueList,
  type ListReadOptions,
  type EntryScan,
  type UsageScan,
  type StorageBranchScan,
  type CommittedWrite,
} from "@earendil-works/pi-agent-core";
import type { SessionDatabase, SessionSql, SqlRow } from "./sessionDatabase.js";

export class SessionCoordinationError extends Error {
  constructor(
    readonly code: "SESSION_BUSY" | "SESSION_NOT_FOUND" | "SESSION_LEASE_LOST",
    message: string,
  ) {
    super(message);
  }
}
export interface SessionLease {
  instance: string;
  token: number;
  lost: boolean;
}
export function addressHash(namespace: string, key: string): string {
  return createHash("sha256")
    .update(JSON.stringify([namespace, key]))
    .digest("hex");
}
export const emptySessionStats = (): SessionStats => ({
  messageCount: 0,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
});
export function sessionMetadata(row: SqlRow) {
  return {
    id: String(row.session_id),
    createdAt: Number(row.created_ms),
    modifiedAt: Number(row.modified_ms),
    storageVersion: 1,
    cwd: "database",
    path: `database://${String(row.session_id)}`,
  };
}

export class DatabaseSessionStorage implements Storage {
  private closing = false;
  private writes: Promise<unknown> = Promise.resolve();
  constructor(
    readonly database: SessionDatabase,
    readonly owner: string,
    readonly id: string,
    readonly lease?: SessionLease,
    private readonly frozen?: { row: SqlRow; records: SqlRow[] },
  ) {}

  async row(sql: SessionSql = this.database, lock = false, admitted = false): Promise<SqlRow> {
    if (this.closing && !admitted) throw new Error("SESSION_STORAGE_CLOSED");
    if (this.frozen) return this.frozen.row;
    const rows = await sql.query(
      `SELECT * FROM agent_sessions WHERE session_id = ? AND owner_user_id = ? AND deleted = 0${lock ? " FOR UPDATE" : ""}`,
      [this.id, this.owner],
    );
    if (!rows[0]) throw new SessionCoordinationError("SESSION_NOT_FOUND", "会话不存在");
    return rows[0];
  }
  async assertWriter(sql: SessionSql, row: SqlRow): Promise<void> {
    if (
      !this.lease ||
      this.lease.lost ||
      row.lease_owner !== this.lease.instance ||
      Number(row.lease_token) !== this.lease.token ||
      Number(row.lease_until_ms) <= (await sql.now())
    ) {
      if (this.lease) this.lease.lost = true;
      throw new SessionCoordinationError("SESSION_LEASE_LOST", "会话执行权已变更，请重新打开会话");
    }
  }
  commit(writes: Write[]) {
    if (this.closing) return Promise.reject(new Error("SESSION_STORAGE_CLOSED"));
    const commit = this.writes.then(() => this.commitAdmitted(writes));
    this.writes = commit.catch(() => undefined);
    return commit;
  }
  private async commitAdmitted(writes: Write[]) {
    return this.database.transaction(async (sql) => {
      const row = await this.row(sql, true, true);
      await this.assertWriter(sql, row);
      const stats = JSON.parse(String(row.stats_json)) as SessionStats;
      const prepared = prepareStorageCommit(writes, Number(row.next_seq), await sql.now());
      const referenced = new Set<string>();
      for (const write of prepared.writes) {
        if (write.kind === "entry") {
          referenced.add(write.id);
          if (write.parentId) referenced.add(write.parentId);
        }
        if (write.kind === "usage") {
          referenced.add(write.id);
          if (write.entryId) referenced.add(write.entryId);
        }
      }
      const ids = [...referenced].flatMap((id) => [`e:${id}`, `u:${id}`]);
      const identities = ids.length
        ? await sql.query(
            `SELECT record_id, kind FROM agent_session_records WHERE session_id = ? AND record_id IN (${ids.map(() => "?").join(",")})`,
            [this.id, ...ids],
          )
        : [];
      const all = new Set(identities.map((item) => String(item.record_id).slice(2)));
      const entries = new Set(
        identities
          .filter((item) => item.kind === "entry")
          .map((item) => String(item.record_id).slice(2)),
      );
      validateCommittedWrites(prepared.writes, Number(row.next_seq), {
        hasEntryOrUsageId: (id) => all.has(id),
        hasEntryId: (id) => entries.has(id),
      });
      let title = row.title,
        current = row.current_operation_id;
      for (const write of prepared.writes) {
        if (write.kind === "entry" && write.type === "message") stats.messageCount++;
        if (write.kind === "usage") {
          for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const)
            stats.usage[key] += write.usage[key];
          for (const key of ["cacheWrite1h", "reasoning"] as const)
            if (write.usage[key] !== undefined)
              stats.usage[key] = (stats.usage[key] ?? 0) + write.usage[key];
          for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const)
            stats.usage.cost[key] += write.usage.cost[key];
        }
        if (write.kind === "value" && write.namespace === "pi.session.name" && write.key === "")
          title = write.op === "set" ? write.value : null;
        if (write.kind === "value" && write.namespace === "pi.lane.state" && write.key === "main")
          current =
            write.op === "set"
              ? (write.value as { currentOperationId: string | null }).currentOperationId
              : null;
        await this.apply(sql, write);
      }
      await sql.execute(
        "UPDATE agent_sessions SET next_seq = ?, modified_ms = ?, stats_json = ?, title = ?, current_operation_id = ? WHERE session_id = ?",
        [
          Number(row.next_seq) + writes.length,
          prepared.result.timestamp,
          JSON.stringify(stats),
          title ?? null,
          current ?? null,
          this.id,
        ],
      );
      return { ...prepared.result, stats };
    });
  }
  private async apply(sql: SessionSql, write: CommittedWrite): Promise<void> {
    const addressed = write.kind === "value" || write.kind === "list";
    const hash = addressed ? addressHash(write.namespace, write.key) : null;
    if (addressed && (write.kind === "value" || write.op === "delete"))
      await sql.execute(
        "DELETE FROM agent_session_records WHERE session_id = ? AND kind = ? AND address_hash = ?",
        [this.id, write.kind, hash],
      );
    if (addressed && write.op === "delete") return;
    const recordId =
      write.kind === "entry"
        ? `e:${write.id}`
        : write.kind === "usage"
          ? `u:${write.id}`
          : write.kind === "value"
            ? `v:${hash}`
            : `l:${write.seq}`;
    await sql.execute(
      "INSERT INTO agent_session_records (session_id, record_id, kind, seq, address_hash, namespace_name, address_key, data_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        this.id,
        recordId,
        write.kind,
        write.seq,
        hash,
        addressed ? write.namespace : null,
        addressed ? write.key : null,
        JSON.stringify(write),
      ],
    );
  }
  private async records(
    kind: string,
    filter: { ids?: string[]; address?: string; namespace?: string } = {},
  ) {
    await this.row();
    let suffix = "";
    const parameters: unknown[] = [];
    if (filter.ids) {
      suffix += ` AND record_id IN (${filter.ids.map(() => "?").join(",")})`;
      parameters.push(...filter.ids);
    }
    if (filter.address !== undefined) {
      suffix += " AND address_hash = ?";
      parameters.push(filter.address);
    }
    if (filter.namespace !== undefined) {
      suffix += " AND namespace_name = ?";
      parameters.push(filter.namespace);
    }
    const rows = this.frozen
      ? this.frozen.records.filter(
          (row) =>
            row.kind === kind &&
            (!filter.ids || filter.ids.includes(String(row.record_id))) &&
            (filter.address === undefined || row.address_hash === filter.address) &&
            (filter.namespace === undefined || row.namespace_name === filter.namespace),
        )
      : await this.database.query(
          `SELECT data_json FROM agent_session_records WHERE session_id = ? AND kind = ?${suffix} ORDER BY seq ASC`,
          [this.id, kind, ...parameters],
        );
    return rows.map((row) => JSON.parse(String(row.data_json)) as CommittedWrite);
  }
  async getEntries(ids: string[]): Promise<Map<string, Entry>> {
    if (this.closing) throw new Error("SESSION_STORAGE_CLOSED");
    if (!ids.length) return new Map();
    const records = await this.records("entry", { ids: ids.map((id) => `e:${id}`) });
    return new Map(
      records.map((record) => {
        const { kind, ...entry } = record;
        void kind;
        return [(entry as Entry).id, entry as Entry];
      }),
    );
  }
  async getValue<T>(address: Value<T>): Promise<StoredValue<T> | undefined> {
    const records = await this.records("value", {
      address: addressHash(address.namespace, address.key),
    });
    const record = records[0];
    return record?.kind === "value" && record.op === "set"
      ? { address, seq: record.seq, value: record.value as T }
      : undefined;
  }
  async scanValues<T>(prefix: Value<T>): Promise<StoredValue<T>[]> {
    const records = await this.records("value", { namespace: prefix.namespace });
    return records
      .flatMap((record) =>
        record.kind === "value" && record.op === "set" && record.key.startsWith(prefix.key)
          ? [
              {
                address: { kind: "value" as const, namespace: record.namespace, key: record.key },
                seq: record.seq,
                value: record.value as T,
              },
            ]
          : [],
      )
      .sort((a, b) => Buffer.compare(Buffer.from(a.address.key), Buffer.from(b.address.key)));
  }
  async readList<T>(address: ValueList<T>, options?: ListReadOptions) {
    const resolved = resolveListReadOptions(options);
    const records = await this.records("list", {
      address: addressHash(address.namespace, address.key),
    });
    const elements = records.flatMap((record) =>
      record.kind === "list" && record.op === "append"
        ? [{ seq: record.seq, value: record.value as T }]
        : [],
    );
    if (resolved.order === "desc") elements.reverse();
    return elements
      .filter(
        (item) =>
          !resolved.cursor ||
          (resolved.order === "desc"
            ? item.seq < resolved.cursor.seq
            : item.seq > resolved.cursor.seq),
      )
      .slice(0, resolved.limit);
  }
  async scanEntries(query: EntryScan = {}) {
    const records = await this.records("entry");
    let entries = records.map((record) => {
      const { kind, ...entry } = record;
      void kind;
      return entry as Entry;
    });
    entries = entries.filter(
      (entry) =>
        (!query.type || query.type === entry.type) &&
        (!query.customType || query.customType === entry.customType) &&
        (query.fromSeq === undefined || entry.seq >= query.fromSeq) &&
        (query.toSeq === undefined || entry.seq <= query.toSeq),
    );
    if (query.order === "desc") entries.reverse();
    return query.limit === undefined
      ? entries
      : entries.slice(0, Math.max(0, Math.trunc(query.limit)));
  }
  async scanUsage(query: UsageScan = {}) {
    const records = await this.records("usage");
    const rows = records
      .map((record) => {
        const { kind, ...row } = record;
        void kind;
        return row as UsageRow;
      })
      .filter(
        (row) =>
          (query.fromSeq === undefined || row.seq >= query.fromSeq) &&
          (query.toSeq === undefined || row.seq <= query.toSeq),
      );
    if (query.order === "desc") rows.reverse();
    return query.limit === undefined ? rows : rows.slice(0, Math.max(0, Math.trunc(query.limit)));
  }
  async scanBranch(query: StorageBranchScan) {
    const entries = new Map((await this.scanEntries()).map((entry) => [entry.id, entry]));
    const path: Entry[] = [],
      seen = new Set<string>();
    let id: string | null = query.start;
    while (id !== null) {
      const entry = entries.get(id);
      if (!entry || seen.has(id)) throw new Error("SESSION_BRANCH_CORRUPT");
      seen.add(id);
      path.push(entry);
      id = entry.parentId;
    }
    if (query.order === "oldestFirst") path.reverse();
    const selected: Entry[] = [];
    for (const entry of path) {
      selected.push(entry);
      if (entry.id === query.stopAtId || entry.type === query.stopAtType) break;
    }
    const filtered = selected.filter(
      (entry) =>
        (!query.type || entry.type === query.type) &&
        (!query.customType || entry.customType === query.customType) &&
        (!query.cursor ||
          (query.order === "oldestFirst"
            ? entry.seq > query.cursor.seq
            : entry.seq < query.cursor.seq)),
    );
    return query.limit === undefined
      ? filtered
      : filtered.slice(0, Math.max(0, Math.trunc(query.limit)));
  }
  async scanBranchStructure(query: StorageBranchScan) {
    return (await this.scanBranch(query)).map(
      ({ id, parentId, seq, timestamp, type, customType }) => ({
        id,
        parentId,
        seq,
        timestamp,
        type,
        ...(customType ? { customType } : {}),
      }),
    );
  }
  async getStats() {
    return JSON.parse(String((await this.row()).stats_json)) as SessionStats;
  }
  async close() {
    this.closing = true;
    await this.writes;
  }
}
