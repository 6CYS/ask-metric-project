/** 共享会话目录、短事务租约、取消信箱与流式重放；节点间无需互访 HTTP 端口。 */
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BACKGROUND_CONTEXT,
  StorageBackedSession,
  type Context,
  type Session,
  type JsonlSessionMetadata,
} from "@earendil-works/pi-agent-core";
import { NativeSessionStore } from "./nativeSessions.js";
import {
  DatabaseSessionStorage,
  emptySessionStats,
  sessionMetadata,
  SessionCoordinationError,
  type SessionLease,
} from "./databaseSessionStorage.js";
import type { SessionDatabase, SessionSql, SqlRow } from "./sessionDatabase.js";

const LEASE_MS = 45_000;
interface OpenSession {
  session: Session<JsonlSessionMetadata>;
  lease: SessionLease;
  owner: string;
}
export interface SessionStreamEvent {
  seq: number;
  type: string;
  data: Record<string, unknown>;
}

export class DatabaseSessionStore extends NativeSessionStore {
  override readonly cluster = this;
  readonly instance = randomUUID(); // 每次启动不同，不能只用 PID、主机名或部署槽号。
  private readonly opened = new Map<string, OpenSession>();
  private readonly opening = new Map<string, Promise<Session<JsonlSessionMetadata>>>();
  private readonly eventWrites = new Map<string, Promise<void>>();
  private readonly timer: ReturnType<typeof setInterval>;
  private ticking = false;
  private cancellationHandler?: (
    sessionId: string,
    kind: string,
    target: string,
  ) => Promise<boolean>;

  constructor(
    private readonly dataDir: string,
    readonly database: SessionDatabase,
  ) {
    super(dataDir);
    this.timer = setInterval(() => {
      void this.heartbeat().catch(() => {
        console.warn("共享会话执行租约维护失败");
      });
    }, 5_000);
    this.timer.unref();
  }
  /** 只检查表是否可访问；运行账号不自动建表，迁移失败不能回退到本机历史。 */
  async ready(): Promise<void> {
    const local = await readdir(join(this.dataDir, "native-v1"), {
      recursive: true,
      withFileTypes: true,
    });
    let legacy = false;
    for (const entry of await readdir(this.dataDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const item: unknown = JSON.parse(await readFile(join(this.dataDir, entry.name), "utf8"));
        if (
          item &&
          typeof item === "object" &&
          "id" in item &&
          typeof item.id === "string" &&
          "userId" in item &&
          typeof item.userId === "string" &&
          "messages" in item &&
          Array.isArray(item.messages)
        ) {
          legacy = true;
          break;
        }
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
    if (legacy || local.some((entry) => entry.isFile() && entry.name.endsWith(".jsonl")))
      throw new Error(
        "检测到本机会话历史（JSONL/旧 JSON），请先安排离线迁移并改用新的状态目录；共享库模式不会自动混入本机历史",
      );
    for (const table of [
      "agent_sessions",
      "agent_session_records",
      "agent_session_events",
      "agent_session_cancellations",
    ])
      await this.database.query(`SELECT 1 FROM ${table} WHERE 1 = 0`);
  }
  override async list(owner: string): Promise<JsonlSessionMetadata[]> {
    return (
      await this.database.query(
        "SELECT * FROM agent_sessions WHERE owner_user_id = ? AND deleted = 0 ORDER BY created_ms DESC",
        [owner],
      )
    ).map(sessionMetadata);
  }
  async state(
    owner: string,
    id: string,
    sql: SessionSql = this.database,
    lock = false,
  ): Promise<SqlRow | undefined> {
    return (
      await sql.query(
        `SELECT * FROM agent_sessions WHERE session_id = ? AND owner_user_id = ? AND deleted = 0${lock ? " FOR UPDATE" : ""}`,
        [id, owner],
      )
    )[0];
  }
  override async findMetadata(owner: string, id: string) {
    const row = await this.state(owner, id);
    return row ? sessionMetadata(row) : undefined;
  }
  async title(owner: string, id: string): Promise<string | undefined> {
    const row = await this.state(owner, id);
    return typeof row?.title === "string" ? row.title : undefined;
  }
  async running(owner: string, id: string): Promise<boolean> {
    return Boolean((await this.state(owner, id))?.current_operation_id);
  }
  isWriter(id: string): boolean {
    return Boolean(this.opened.get(id) && !this.opened.get(id)!.lease.lost);
  }

  override async create(owner: string): Promise<Session<JsonlSessionMetadata>> {
    const id = randomUUID(),
      now = await this.database.now();
    await this.database.execute(
      "INSERT INTO agent_sessions (session_id, owner_user_id, created_ms, modified_ms, next_seq, stats_json, deleted, lease_owner, lease_token, lease_until_ms, event_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        id,
        owner,
        now,
        now,
        1,
        JSON.stringify(emptySessionStats()),
        0,
        this.instance,
        1,
        now + LEASE_MS,
        0,
      ],
    );
    return this.remember(owner, (await this.state(owner, id))!, {
      instance: this.instance,
      token: 1,
      lost: false,
    });
  }
  override async open(
    owner: string,
    metadata: JsonlSessionMetadata,
  ): Promise<Session<JsonlSessionMetadata>> {
    const cached = this.opened.get(metadata.id);
    if (cached && cached.owner === owner && !cached.lease.lost) return cached.session;
    const pending = this.opening.get(metadata.id);
    if (pending) return pending;
    const opening = this.database
      .transaction(async (sql) => {
        const row = await this.state(owner, metadata.id, sql, true);
        if (!row) throw new SessionCoordinationError("SESSION_NOT_FOUND", "会话不存在");
        const now = await sql.now();
        if (row.lease_owner && Number(row.lease_until_ms) > now)
          throw new SessionCoordinationError("SESSION_BUSY", "会话由另一实例使用中，请稍后重试");
        const token = Number(row.lease_token) + 1;
        await sql.execute(
          "UPDATE agent_sessions SET lease_owner = ?, lease_token = ?, lease_until_ms = ? WHERE session_id = ?",
          [this.instance, token, now + LEASE_MS, metadata.id],
        );
        return { row, token };
      })
      .then(({ row, token }) =>
        this.remember(owner, row, { instance: this.instance, token, lost: false }),
      );
    this.opening.set(metadata.id, opening);
    try {
      return await opening;
    } finally {
      this.opening.delete(metadata.id);
    }
  }
  private remember(owner: string, row: SqlRow, lease: SessionLease) {
    const session = new StorageBackedSession(
      sessionMetadata(row),
      new DatabaseSessionStorage(this.database, owner, String(row.session_id), lease),
    );
    this.opened.set(session.metadata.id, { owner, session, lease });
    return session;
  }
  /** 只读句柄不争写租约、不进入宿主缓存，跨节点查历史不会阻塞正在生成的回答。 */
  async observe(owner: string, id: string): Promise<Session<JsonlSessionMetadata> | undefined> {
    return this.database.transaction(async (sql) => {
      // 短暂锁定后复制原生读视图；避免其他节点提交期间读到不配套的分支与检查点。
      const row = await this.state(owner, id, sql, true);
      if (!row) return undefined;
      const records = await sql.query(
        "SELECT * FROM agent_session_records WHERE session_id = ? ORDER BY seq ASC",
        [id],
      );
      return new StorageBackedSession(
        sessionMetadata(row),
        new DatabaseSessionStorage(this.database, owner, id, undefined, { row, records }),
      );
    });
  }
  override async release(
    owner: string,
    id: string,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<void> {
    const item = this.opened.get(id);
    if (!item || item.owner !== owner) return;
    try {
      await this.flushEvents(id);
    } finally {
      this.opened.delete(id);
      await item.session.close(context).catch(() => undefined);
      await this.database.execute(
        "UPDATE agent_sessions SET lease_owner = NULL, lease_until_ms = 0 WHERE session_id = ? AND lease_owner = ? AND lease_token = ?",
        [id, this.instance, item.lease.token],
      );
    }
  }
  override async delete(owner: string, metadata: JsonlSessionMetadata): Promise<void> {
    // 接纳与删除都受同一租约约束；活动 operation 和租约检查与墓碑写入是一个事务。
    await this.database.transaction(async (sql) => {
      const row = await this.state(owner, metadata.id, sql, true);
      if (!row) return;
      if (
        row.current_operation_id ||
        (row.lease_owner &&
          row.lease_owner !== this.instance &&
          Number(row.lease_until_ms) > (await sql.now()))
      )
        throw new SessionCoordinationError("SESSION_BUSY", "会话正在处理提问，请先停止后再删除");
      await sql.execute(
        "UPDATE agent_sessions SET deleted = 1, lease_token = lease_token + 1, lease_owner = NULL, lease_until_ms = 0, title = NULL, stats_json = ? WHERE session_id = ?",
        [JSON.stringify(emptySessionStats()), metadata.id],
      );
      for (const table of [
        "agent_session_records",
        "agent_session_events",
        "agent_session_cancellations",
      ])
        await sql.execute(`DELETE FROM ${table} WHERE session_id = ?`, [metadata.id]);
    });
    const item = this.opened.get(metadata.id);
    if (item) item.lease.lost = true;
    await this.release(owner, metadata.id);
  }
  onCancellation(handler: NonNullable<DatabaseSessionStore["cancellationHandler"]>): void {
    this.cancellationHandler = handler;
  }
  async cancel(
    owner: string,
    id: string,
    kind: "operation" | "request",
    target: string,
  ): Promise<boolean> {
    return this.database.transaction(async (sql) => {
      if (!(await this.state(owner, id, sql, true))) return false;
      const existing = await sql.query(
        "SELECT target_id FROM agent_session_cancellations WHERE session_id = ? AND target_kind = ? AND target_id = ?",
        [id, kind, target],
      );
      if (!existing.length)
        await sql.execute(
          "INSERT INTO agent_session_cancellations (session_id, target_kind, target_id) VALUES (?, ?, ?)",
          [id, kind, target],
        );
      return true;
    });
  }
  async drainCancellations(id: string): Promise<void> {
    if (!this.isWriter(id) || !this.cancellationHandler) return;
    const commands = await this.database.query(
      "SELECT target_kind, target_id FROM agent_session_cancellations WHERE session_id = ?",
      [id],
    );
    for (const command of commands) {
      const handled = await this.cancellationHandler(
        id,
        String(command.target_kind),
        String(command.target_id),
      );
      if (handled)
        await this.database.execute(
          "DELETE FROM agent_session_cancellations WHERE session_id = ? AND target_kind = ? AND target_id = ?",
          [id, command.target_kind, command.target_id],
        );
    }
  }
  private async heartbeat(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const [id, item] of this.opened) {
        if (item.lease.lost) continue;
        try {
          await this.database.transaction(async (sql) => {
            const storage = new DatabaseSessionStorage(this.database, item.owner, id, item.lease);
            const row = await storage.row(sql, true);
            await storage.assertWriter(sql, row);
            await sql.execute("UPDATE agent_sessions SET lease_until_ms = ? WHERE session_id = ?", [
              (await sql.now()) + LEASE_MS,
              id,
            ]);
          });
        } catch {
          item.lease.lost = true;
        }
        if (!item.lease.lost)
          await this.drainCancellations(id).catch(() => {
            console.warn(JSON.stringify({ event: "session_cancellation_pending", session_id: id }));
          });
      }
    } finally {
      this.ticking = false;
    }
  }
  /** 流事件串行入库后再发给浏览器；断线后的驱动仍写入同一日志，另一节点可重放。 */
  publish(
    owner: string,
    id: string,
    operation: string,
    type: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const previous = this.eventWrites.get(id) ?? Promise.resolve();
    const next = previous.then(() =>
      this.database.transaction(async (sql) => {
        const item = this.opened.get(id);
        const storage = new DatabaseSessionStorage(this.database, owner, id, item?.lease);
        const row = await storage.row(sql, true);
        await storage.assertWriter(sql, row);
        const seq = Number(row.event_seq) + 1;
        if (type === "accepted")
          await sql.execute(
            "DELETE FROM agent_session_events WHERE session_id = ? AND operation_id <> ?",
            [id, operation],
          );
        await sql.execute(
          "INSERT INTO agent_session_events (session_id, seq, operation_id, event_type, data_json) VALUES (?, ?, ?, ?, ?)",
          [id, seq, operation, type, JSON.stringify(data)],
        );
        await sql.execute("UPDATE agent_sessions SET event_seq = ? WHERE session_id = ?", [
          seq,
          id,
        ]);
      }),
    );
    // 写失败后该写链保持失败；不能越过缺失片段并继续宣称流完整。
    this.eventWrites.set(id, next);
    void next.catch(() => undefined);
    return next;
  }
  async events(
    owner: string,
    id: string,
    operation: string,
    after: number,
  ): Promise<SessionStreamEvent[]> {
    if (!(await this.state(owner, id)))
      throw new SessionCoordinationError("SESSION_NOT_FOUND", "会话不存在");
    return (
      await this.database.query(
        "SELECT seq, event_type, data_json FROM agent_session_events WHERE session_id = ? AND operation_id = ? AND seq > ? ORDER BY seq ASC LIMIT 200",
        [id, operation, after],
      )
    ).map((row) => ({
      seq: Number(row.seq),
      type: String(row.event_type),
      data: JSON.parse(String(row.data_json)) as Record<string, unknown>,
    }));
  }
  async flushEvents(id: string): Promise<void> {
    try {
      await this.eventWrites.get(id);
    } finally {
      this.eventWrites.delete(id);
    }
  }
  override async close(): Promise<void> {
    clearInterval(this.timer);
    await Promise.all([...this.opened].map(([id, item]) => this.release(item.owner, id)));
    await this.database.close();
  }
}
