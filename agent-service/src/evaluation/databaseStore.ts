import { randomUUID } from "node:crypto";
import type { SessionDatabase, SessionSql, SqlRow } from "../sessionDatabase.js";
import type { EvaluationPersistence } from "./persistence.js";
import {
  EvaluationError,
  evaluationIdentity,
  evaluationVersion,
  frozenRun,
  MAX_STORED_JSON_BYTES,
  parseDatasetInput,
  storedDataset,
  storedRun,
} from "./store.js";
import type { EvaluationReview, EvaluationRun, EvaluationTurn } from "./types.js";

export function evaluationDocument(value: unknown): string {
  const content = JSON.stringify(value);
  if (Buffer.byteLength(content) > MAX_STORED_JSON_BYTES)
    throw new EvaluationError(400, "EVALUATION_STORAGE_LIMIT", "测评记录超过存储容量限制");
  return content;
}
function conflict(): never {
  throw new EvaluationError(409, "EVALUATION_VERSION_CONFLICT", "测评记录已变化，请刷新后重试");
}
function missing(kind: "DATASET" | "RUN"): never {
  throw new EvaluationError(
    404,
    `EVALUATION_${kind}_NOT_FOUND`,
    kind === "RUN" ? "测评批次不存在" : "问题集不存在",
  );
}
function identity(owner: string, id?: string) {
  if (!owner.trim() || owner.length > 128)
    throw new EvaluationError(400, "EVALUATION_OWNER_INVALID", "用户身份无效");
  if (id !== undefined) evaluationIdentity(id);
}

/** 所有修改先锁定归属行；快照保持整份有序文档，人工复核独立保存，不被执行进度覆盖。 */
export class DatabaseEvaluationStore implements EvaluationPersistence {
  readonly shared = true;
  readonly instance = randomUUID();
  private readonly leases = new WeakMap<EvaluationRun, number>();
  private readonly revisions = new WeakMap<EvaluationRun, number>();
  constructor(readonly database: SessionDatabase) {}
  async ready() {
    for (const table of [
      "evaluation_datasets",
      "evaluation_runs",
      "evaluation_reviews",
      "evaluation_execution_slots",
    ])
      await this.database.query(`SELECT 1 FROM ${table} WHERE 1 = 0`);
    if (
      !(
        await this.database.query(
          "SELECT slot_key FROM evaluation_execution_slots WHERE slot_key = 'batch'",
        )
      ).length
    )
      throw new EvaluationError(503, "EVALUATION_NOT_INITIALIZED", "测评执行槽尚未通过迁移初始化");
  }
  private async io<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof EvaluationError) throw error;
      throw new EvaluationError(503, "EVALUATION_STORAGE_UNAVAILABLE", "测评存储暂不可用");
    }
  }
  async listDatasets(owner: string) {
    identity(owner);
    return this.io(async () =>
      (
        await this.database.query(
          "SELECT content_json FROM evaluation_datasets WHERE owner_user_id = ? AND deleted = 0 ORDER BY updated_at DESC",
          [owner],
        )
      ).map((row) => storedDataset(JSON.parse(String(row.content_json)))),
    );
  }
  async getDataset(owner: string, id: string) {
    identity(owner, id);
    return this.io(async () => {
      const [row] = await this.database.query(
        "SELECT content_json FROM evaluation_datasets WHERE owner_user_id = ? AND id = ? AND deleted = 0",
        [owner, id],
      );
      if (!row) missing("DATASET");
      return storedDataset(JSON.parse(String(row.content_json)));
    });
  }
  async createDataset(owner: string, input: unknown) {
    identity(owner);
    const item = {
      ...parseDatasetInput(input),
      id: randomUUID(),
      version: 1,
      updated_at: new Date().toISOString(),
    };
    await this.io(() =>
      this.database.execute(
        "INSERT INTO evaluation_datasets (owner_user_id, id, version, updated_at, content_json, deleted) VALUES (?, ?, ?, ?, ?, 0)",
        [owner, item.id, item.version, item.updated_at, evaluationDocument(item)],
      ),
    );
    return item;
  }
  async updateDataset(owner: string, id: string, version: number, input: unknown) {
    identity(owner, id);
    evaluationVersion(version);
    const item = {
      ...parseDatasetInput(input),
      id,
      version: version + 1,
      updated_at: new Date().toISOString(),
    };
    await this.io(() =>
      this.database.transaction(async (sql) => {
        const [row] = await sql.query(
          "SELECT version, deleted FROM evaluation_datasets WHERE owner_user_id = ? AND id = ? FOR UPDATE",
          [owner, id],
        );
        if (!row || Number(row.deleted)) missing("DATASET");
        if (Number(row.version) !== version) conflict();
        await sql.execute(
          "UPDATE evaluation_datasets SET version = ?, updated_at = ?, content_json = ? WHERE owner_user_id = ? AND id = ?",
          [item.version, item.updated_at, evaluationDocument(item), owner, id],
        );
      }),
    );
    return item;
  }
  async deleteDataset(owner: string, id: string, version: number) {
    identity(owner, id);
    evaluationVersion(version);
    await this.io(() =>
      this.database.transaction(async (sql) => {
        const [row] = await sql.query(
          "SELECT version, deleted FROM evaluation_datasets WHERE owner_user_id = ? AND id = ? FOR UPDATE",
          [owner, id],
        );
        if (!row || Number(row.deleted)) missing("DATASET");
        if (Number(row.version) !== version) conflict();
        await sql.execute(
          "UPDATE evaluation_datasets SET deleted = 1, content_json = '' WHERE owner_user_id = ? AND id = ?",
          [owner, id],
        );
      }),
    );
  }
  private async runRow(sql: SessionSql, owner: string, id: string, lock = false) {
    const [row] = await sql.query(
      `SELECT * FROM evaluation_runs WHERE owner_user_id = ? AND id = ? AND deleted = 0${lock ? " FOR UPDATE" : ""}`,
      [owner, id],
    );
    if (!row) missing("RUN");
    return row;
  }
  private async materialize(sql: SessionSql, owner: string, row: SqlRow) {
    const run = storedRun(JSON.parse(String(row.content_json)));
    if (run.actor.id !== owner) missing("RUN");
    const reviews = new Map(
      (
        await sql.query(
          "SELECT turn_id, content_json FROM evaluation_reviews WHERE owner_user_id = ? AND run_id = ?",
          [owner, run.id],
        )
      ).map((item) => [
        String(item.turn_id),
        JSON.parse(String(item.content_json)) as EvaluationReview,
      ]),
    );
    for (const turn of run.turns) turn.review = reviews.get(turn.id) ?? null;
    if (["running", "cancelling"].includes(run.status)) {
      const [slot] = await sql.query(
        "SELECT cancel_requested FROM evaluation_execution_slots WHERE slot_key = 'batch' AND owner_user_id = ? AND run_id = ?",
        [owner, run.id],
      );
      if (Number(slot?.cancel_requested)) run.status = "cancelling";
    }
    this.revisions.set(run, Number(row.revision));
    return run;
  }
  async listRuns(owner: string) {
    identity(owner);
    return this.io(() =>
      this.database.transaction(async (sql) => {
        const rows = await sql.query(
          "SELECT * FROM evaluation_runs WHERE owner_user_id = ? AND deleted = 0 ORDER BY created_at DESC",
          [owner],
        );
        const result: EvaluationRun[] = [];
        for (const row of rows) result.push(await this.materialize(sql, owner, row));
        return result;
      }),
    );
  }
  async getRun(owner: string, id: string) {
    identity(owner, id);
    return this.io(() =>
      this.database.transaction(async (sql) =>
        this.materialize(sql, owner, await this.runRow(sql, owner, id)),
      ),
    );
  }
  async saveRun(owner: string, run: EvaluationRun) {
    identity(owner, run.id);
    storedRun(run);
    if (run.actor.id !== owner) missing("RUN");
    const body = evaluationDocument({
      ...run,
      turns: run.turns.map((turn) => ({ ...turn, review: null })),
    });
    const revision = await this.io(() =>
      this.database.transaction(async (sql) => {
        if (this.leases.has(run)) await this.executionRow(sql, run);
        const [row] = await sql.query(
          "SELECT * FROM evaluation_runs WHERE owner_user_id = ? AND id = ? FOR UPDATE",
          [owner, run.id],
        );
        if (row) {
          if (Number(row.deleted)) missing("RUN");
          if (frozenRun(storedRun(JSON.parse(String(row.content_json)))) !== frozenRun(run))
            throw new EvaluationError(409, "EVALUATION_RUN_IMMUTABLE", "测评输入快照不可修改");
          if (this.revisions.get(run) !== Number(row.revision)) conflict();
          await sql.execute(
            "UPDATE evaluation_runs SET revision = revision + 1, status = ?, content_json = ? WHERE owner_user_id = ? AND id = ?",
            [run.status, body, owner, run.id],
          );
          return Number(row.revision) + 1;
        }
        await sql.execute(
          "INSERT INTO evaluation_runs (owner_user_id, id, revision, status, created_at, content_json, deleted) VALUES (?, ?, 1, ?, ?, ?, 0)",
          [owner, run.id, run.status, run.created_at, body],
        );
        return 1;
      }),
    );
    this.revisions.set(run, revision);
  }
  async reviewTurn(
    owner: string,
    runId: string,
    turnId: string,
    review: EvaluationReview,
  ): Promise<EvaluationTurn> {
    identity(owner, runId);
    evaluationIdentity(turnId);
    return this.io(() =>
      this.database.transaction(async (sql) => {
        const run = storedRun(
          JSON.parse(String((await this.runRow(sql, owner, runId, true)).content_json)),
        );
        if (run.status === "deleting")
          throw new EvaluationError(409, "EVALUATION_DELETING", "该批次已开始删除");
        const turn = run.turns.find((item) => item.id === turnId);
        if (!turn) throw new EvaluationError(404, "EVALUATION_TURN_NOT_FOUND", "测评轮次不存在");
        if (turn.status === "pending" || turn.status === "running")
          throw new EvaluationError(
            409,
            "EVALUATION_REVIEW_NOT_READY",
            "该轮尚未结束，不能人工复核",
          );
        await sql.execute(
          "DELETE FROM evaluation_reviews WHERE owner_user_id = ? AND run_id = ? AND turn_id = ?",
          [owner, runId, turnId],
        );
        await sql.execute(
          "INSERT INTO evaluation_reviews (owner_user_id, run_id, turn_id, content_json) VALUES (?, ?, ?, ?)",
          [owner, runId, turnId, evaluationDocument(review)],
        );
        return { ...turn, review };
      }),
    );
  }
  async deleteRun(owner: string, id: string) {
    identity(owner, id);
    await this.io(() =>
      this.database.transaction(async (sql) => {
        const row = await this.runRow(sql, owner, id, true);
        if (row.status !== "deleting")
          throw new EvaluationError(409, "EVALUATION_DELETE_NOT_STARTED", "尚未开始清理批次会话");
        await sql.execute("DELETE FROM evaluation_reviews WHERE owner_user_id = ? AND run_id = ?", [
          owner,
          id,
        ]);
        await sql.execute(
          "UPDATE evaluation_runs SET deleted = 1, content_json = '', revision = revision + 1 WHERE owner_user_id = ? AND id = ?",
          [owner, id],
        );
      }),
    );
  }
  /** 共享模式不能在某节点启动时修改其他节点的运行记录；执行恢复由数据库协调层决定。 */
  recoverInterruptedRuns(): Promise<void> {
    return Promise.resolve();
  }

  async importDataset(owner: string, value: unknown) {
    const item = storedDataset(value);
    identity(owner, item.id);
    return this.io(() =>
      this.database.transaction(async (sql) => {
        const [row] = await sql.query(
          "SELECT * FROM evaluation_datasets WHERE owner_user_id = ? AND id = ? FOR UPDATE",
          [owner, item.id],
        );
        const body = evaluationDocument(item);
        if (row) {
          if (Number(row.deleted) || String(row.content_json) !== body) conflict();
          return "unchanged";
        }
        await sql.execute(
          "INSERT INTO evaluation_datasets (owner_user_id, id, version, updated_at, content_json, deleted) VALUES (?, ?, ?, ?, ?, 0)",
          [owner, item.id, item.version, item.updated_at, body],
        );
        return "imported";
      }),
    );
  }
  async importRun(owner: string, value: unknown) {
    const run = storedRun(value);
    identity(owner, run.id);
    if (run.actor.id !== owner) missing("RUN");
    if (run.status === "running" || run.status === "cancelling")
      throw new EvaluationError(
        409,
        "EVALUATION_RUN_ACTIVE",
        "请先确认原测评停止，不能导入运行中批次",
      );
    const body = evaluationDocument({
      ...run,
      turns: run.turns.map((turn) => ({ ...turn, review: null })),
    });
    return this.io(() =>
      this.database.transaction(async (sql) => {
        const [row] = await sql.query(
          "SELECT * FROM evaluation_runs WHERE owner_user_id = ? AND id = ? FOR UPDATE",
          [owner, run.id],
        );
        if (row) {
          if (
            Number(row.deleted) ||
            evaluationDocument(await this.materialize(sql, owner, row)) !== evaluationDocument(run)
          )
            conflict();
          return "unchanged";
        }
        await sql.execute(
          "INSERT INTO evaluation_runs (owner_user_id, id, revision, status, created_at, content_json, deleted) VALUES (?, ?, 1, ?, ?, ?, 0)",
          [owner, run.id, run.status, run.created_at, body],
        );
        for (const turn of run.turns)
          if (turn.review)
            await sql.execute(
              "INSERT INTO evaluation_reviews (owner_user_id, run_id, turn_id, content_json) VALUES (?, ?, ?, ?)",
              [owner, run.id, turn.id, evaluationDocument(turn.review)],
            );
        return "imported";
      }),
    );
  }
  private async slot(sql: SessionSql) {
    const [slot] = await sql.query(
      "SELECT * FROM evaluation_execution_slots WHERE slot_key = 'batch' FOR UPDATE",
    );
    if (!slot) throw new EvaluationError(503, "EVALUATION_NOT_INITIALIZED", "测评执行槽尚未初始化");
    return slot;
  }
  private async executionRow(sql: SessionSql, run: EvaluationRun) {
    const slot = await this.slot(sql);
    if (
      slot.owner_user_id !== run.actor.id ||
      slot.run_id !== run.id ||
      slot.lease_owner !== this.instance ||
      Number(slot.lease_token) !== this.leases.get(run) ||
      Number(slot.lease_until_ms) <= (await sql.now())
    )
      throw new EvaluationError(
        409,
        "EVALUATION_LEASE_LOST",
        "测评执行权已变更，当前实例停止继续执行",
      );
    return slot;
  }
  async startExecution(owner: string, run: EvaluationRun) {
    identity(owner, run.id);
    storedRun(run);
    if (run.actor.id !== owner) missing("RUN");
    const token = await this.io(() =>
      this.database.transaction(async (sql) => {
        const slot = await this.slot(sql),
          now = await sql.now();
        if (slot.run_id)
          throw new EvaluationError(
            409,
            Number(slot.lease_until_ms) <= now ? "EVALUATION_RECOVERY_REQUIRED" : "EVALUATION_BUSY",
            Number(slot.lease_until_ms) <= now
              ? "上个测评执行节点已离线，请先停止并确认原操作结束"
              : "已有测评批次正在执行或停止",
          );
        const next = Number(slot.lease_token) + 1;
        await sql.execute(
          "INSERT INTO evaluation_runs (owner_user_id, id, revision, status, created_at, content_json, deleted) VALUES (?, ?, 1, ?, ?, ?, 0)",
          [owner, run.id, run.status, run.created_at, evaluationDocument(run)],
        );
        await sql.execute(
          "UPDATE evaluation_execution_slots SET owner_user_id = ?, run_id = ?, lease_owner = ?, lease_token = ?, lease_until_ms = ?, cancel_requested = 0, cancel_confirmed = 0 WHERE slot_key = 'batch'",
          [owner, run.id, this.instance, next, now + 45_000],
        );
        return next;
      }),
    );
    this.revisions.set(run, 1);
    this.leases.set(run, token);
  }
  async maintainExecution(run: EvaluationRun) {
    return this.io(() =>
      this.database.transaction(async (sql) => {
        const slot = await this.executionRow(sql, run);
        await sql.execute(
          "UPDATE evaluation_execution_slots SET lease_until_ms = ? WHERE slot_key = 'batch'",
          [(await sql.now()) + 45_000],
        );
        return {
          cancelRequested: Boolean(Number(slot.cancel_requested)),
          cancelConfirmed: Boolean(Number(slot.cancel_confirmed)),
        };
      }),
    );
  }
  async requestExecutionCancellation(owner: string, id: string) {
    identity(owner, id);
    return this.io(() =>
      this.database.transaction(async (sql) => {
        const slot = await this.slot(sql);
        if (slot.owner_user_id !== owner || slot.run_id !== id) {
          await this.runRow(sql, owner, id);
          throw new EvaluationError(409, "EVALUATION_NOT_RUNNING", "该测评批次当前未在执行");
        }
        const run = await this.materialize(sql, owner, await this.runRow(sql, owner, id, true));
        const now = await sql.now();
        // 只接管过期槽；先增加代次阻止旧节点写入，确认停止前不释放槽也不重跑题目。
        const takeover = Number(slot.lease_until_ms) <= now;
        const token = Number(slot.lease_token) + (takeover ? 1 : 0);
        const canFinalize = takeover || slot.lease_owner === this.instance;
        await sql.execute(
          "UPDATE evaluation_execution_slots SET cancel_requested = 1, lease_owner = ?, lease_token = ?, lease_until_ms = ? WHERE slot_key = 'batch'",
          [
            takeover ? this.instance : slot.lease_owner,
            token,
            takeover ? now + 45_000 : slot.lease_until_ms,
          ],
        );
        if (canFinalize) this.leases.set(run, token);
        return { run, canFinalize };
      }),
    );
  }
  async confirmExecutionCancellation(owner: string, id: string) {
    await this.io(() =>
      this.database.transaction(async (sql) => {
        const slot = await this.slot(sql);
        if (slot.owner_user_id !== owner || slot.run_id !== id || !Number(slot.cancel_requested))
          throw new EvaluationError(409, "EVALUATION_NOT_RUNNING", "该测评批次已变更");
        await sql.execute(
          "UPDATE evaluation_execution_slots SET cancel_confirmed = 1 WHERE slot_key = 'batch'",
        );
      }),
    );
  }
  async endExecution(run: EvaluationRun) {
    await this.io(() =>
      this.database.transaction(async (sql) => {
        const slot = await this.slot(sql);
        if (!slot.run_id) {
          const row = await this.runRow(sql, run.actor.id, run.id);
          if (!["running", "cancelling"].includes(String(row.status))) return;
        }
        await this.executionRow(sql, run);
        const row = await this.runRow(sql, run.actor.id, run.id, true);
        if (["running", "cancelling"].includes(String(row.status)))
          throw new EvaluationError(409, "EVALUATION_RUN_ACTIVE", "停止未确认，不能释放执行槽");
        await sql.execute(
          "UPDATE evaluation_execution_slots SET owner_user_id = NULL, run_id = NULL, lease_owner = NULL, lease_token = lease_token + 1, lease_until_ms = 0, cancel_requested = 0, cancel_confirmed = 0 WHERE slot_key = 'batch'",
        );
      }),
    );
  }
}
