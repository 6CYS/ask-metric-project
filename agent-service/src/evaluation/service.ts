import { randomUUID } from "node:crypto";
import { BackendApiError, type BackendUser } from "../backendClient.js";
import type { AgentServiceConfig } from "../config.js";
import {
  EvaluationError,
  evaluationHash,
  evaluationIdentity,
  evaluationRecord,
  evaluationText,
  evaluationVersion,
} from "./store.js";
import type {
  EvaluationDataset,
  EvaluationReview,
  EvaluationRun,
  EvaluationTurn,
  EvaluationTurnDetail,
  ExecutionIdentity,
  ExecutionResult,
  RunInput,
  SessionEvaluationClient,
} from "./types.js";

import type { EvaluationPersistence } from "./persistence.js";
import type { ConfigurationVersions } from "../configurationVersions.js";

interface ActiveBatch {
  service: EvaluationService;
  run: EvaluationRun;
  token: string;
  abort: AbortController;
  task: Promise<void>;
  cancellation: Promise<void> | null;
  cancellationSettled: boolean;
  cancelFailure: ExecutionResult | null;
  currentTurn: EvaluationTurn | null;
  executionSettled: boolean;
  maintenance?: ReturnType<typeof setInterval>;
  maintaining?: boolean;
  cancelConfirmed?: boolean;
  leaseLost?: boolean;
}

// 与现有数据根单写锁配合，同一 Agent 进程的所有账号和路由共用一个执行槽。
let fileBatch: ActiveBatch | undefined;
let fileStarting = false;

const authenticationCodes = new Set([
  "AUTHENTICATION_REQUIRED",
  "AUTHENTICATION_FAILED",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "HISTORY_PERMISSION_DENIED",
  "TOKEN_EXPIRED",
  "PERMISSION_DENIED",
  "INQUIRY_FORBIDDEN",
]);

function authenticationFailure(value: unknown): boolean {
  return value instanceof BackendApiError && (value.status === 401 || value.status === 403);
}

function failedResult(error: unknown, identity?: ExecutionIdentity | null): ExecutionResult {
  const cancelUnconfirmed =
    error instanceof BackendApiError && error.code === "EVALUATION_CANCEL_UNCONFIRMED";
  return {
    status: "failed",
    run_status: null,
    user_entry_id: identity?.user_entry_id ?? null,
    operation_id: identity?.operation_id ?? null,
    answer_status: null,
    error_code: authenticationFailure(error)
      ? "AUTHENTICATION_FAILED"
      : cancelUnconfirmed
        ? "EVALUATION_CANCEL_UNCONFIRMED"
        : "EVALUATION_EXECUTION_FAILED",
    error_message: authenticationFailure(error)
      ? "身份或访问权限已失效，本批次已停止"
      : cancelUnconfirmed
        ? "无法确认原操作已停止，本批次不再继续执行"
        : "会话执行失败，请检查服务状态后新建批次",
    timings_ms: {},
  };
}

function runInput(value: unknown): RunInput {
  const body = evaluationRecord(value);
  return {
    dataset_id: evaluationIdentity(body.dataset_id),
    dataset_version: evaluationVersion(body.dataset_version),
    name: evaluationText(body.name, "批次名称", 200),
    version_label: evaluationText(body.version_label, "代码版本说明", 200, true),
    data_label: evaluationText(body.data_label, "数据条件说明", 1_000, true),
  };
}

function reviewInput(value: unknown, user: BackendUser): EvaluationReview {
  const body = evaluationRecord(value);
  if (body.verdict !== "passed" && body.verdict !== "failed" && body.verdict !== "needs_review") {
    throw new EvaluationError(400, "EVALUATION_REVIEW_INVALID", "人工复核结论无效");
  }
  return {
    verdict: body.verdict,
    note: evaluationText(body.note, "复核说明", 4_000, true),
    updated_at: new Date().toISOString(),
    reviewer: user.display_name || user.username,
  };
}

function findTurn(run: EvaluationRun, id: string): EvaluationTurn {
  evaluationIdentity(id);
  const turn = run.turns.find((item) => item.id === id);
  if (!turn) throw new EvaluationError(404, "EVALUATION_TURN_NOT_FOUND", "测评轮次不存在");
  return turn;
}

function skipPending(run: EvaluationRun, groupId?: string): void {
  for (const turn of run.turns) {
    if (turn.status === "pending" && (groupId === undefined || turn.group_id === groupId)) {
      turn.status = "skipped";
      turn.finished_at = new Date().toISOString();
    }
  }
}

export class EvaluationService {
  private localBatch: ActiveBatch | undefined;
  private localStarting = false;
  private get batch() {
    return this.store.shared ? this.localBatch : fileBatch;
  }
  private set batch(batch: ActiveBatch | undefined) {
    if (this.store.shared) this.localBatch = batch;
    else fileBatch = batch;
  }
  private get starting() {
    return this.store.shared ? this.localStarting : fileStarting;
  }
  private set starting(value: boolean) {
    if (this.store.shared) this.localStarting = value;
    else fileStarting = value;
  }
  private readonly persistenceFailures = new Map<string, EvaluationRun>();
  private readonly sessionIds = new Map<string, Set<string>>();
  private readonly loadedSessionOwners = new Set<string>();
  private readonly deletingOwners = new Set<string>();
  private readonly ready: Promise<void>;
  constructor(
    private readonly store: EvaluationPersistence,
    private readonly client: SessionEvaluationClient,
    private readonly config: AgentServiceConfig,
    private readonly options: {
      configuration?: (
        token: string,
      ) => Promise<{ config: AgentServiceConfig; versions: ConfigurationVersions }>;
    } = {},
  ) {
    // 重启只修正测评记录，不打开原生会话，也不重放问题。
    this.ready = !this.batch ? Promise.resolve(store.recoverInterruptedRuns()) : Promise.resolve();
    void this.ready.catch(() => undefined);
  }

  async createDataset(userId: string, input: unknown): Promise<EvaluationDataset> {
    return await this.store.createDataset(userId, input);
  }
  async listDatasets(userId: string): Promise<EvaluationDataset[]> {
    return await this.store.listDatasets(userId);
  }
  async updateDataset(
    userId: string,
    id: string,
    version: number,
    input: unknown,
  ): Promise<EvaluationDataset> {
    return await this.store.updateDataset(userId, id, version, input);
  }
  async deleteDataset(userId: string, id: string, version: number): Promise<void> {
    await this.store.deleteDataset(userId, id, version);
  }

  async deleteRun(userId: string, token: string, id: string): Promise<void> {
    const run = await this.getRun(userId, id);
    if (run.status === "running" || run.status === "cancelling" || this.batch?.run.id === id)
      throw new EvaluationError(
        409,
        "EVALUATION_RUN_ACTIVE",
        "请先停止测评并确认停止完成，再删除批次",
      );
    if (this.deletingOwners.has(userId))
      throw new EvaluationError(409, "EVALUATION_DELETE_BUSY", "已有批次正在删除，请稍后重试");

    const retainedSessions = new Set(
      (await this.store.listRuns(userId))
        .filter((item) => item.id !== id)
        .flatMap((item) =>
          item.turns.flatMap((turn) => (turn.session_id ? [turn.session_id] : [])),
        ),
    );
    const sessions = [
      ...new Set(run.turns.flatMap((turn) => (turn.session_id ? [turn.session_id] : []))),
    ].filter((sessionId) => !retainedSessions.has(sessionId));
    // 先持久化删除意图；部分清理或进程中断后仍保留会话归属，不能恢复为完整测评结果。
    run.status = "deleting";
    await this.store.saveRun(userId, run);
    this.deletingOwners.add(userId);
    try {
      const deadline = AbortSignal.timeout(25_000);
      for (const sessionId of sessions) {
        deadline.throwIfAborted();
        await this.client.deleteSession(token, sessionId, deadline);
        // 逐项保存清理进度，重启或超时后只继续剩余会话，避免重复请求耗尽预算。
        for (const turn of run.turns) {
          if (turn.session_id === sessionId) turn.session_id = null;
        }
        await this.store.saveRun(userId, run);
        this.sessionIds.get(userId)?.delete(sessionId);
      }
      await this.store.deleteRun(userId, id);
    } catch (error) {
      if (error instanceof BackendApiError && (error.status === 401 || error.status === 403))
        throw error;
      throw new EvaluationError(
        error instanceof BackendApiError && error.status === 409 ? 409 : 503,
        "EVALUATION_DELETE_INCOMPLETE",
        "批次删除未完成，部分记录可能已清理。请稍后继续删除；已清理的内容无法恢复。",
      );
    } finally {
      this.deletingOwners.delete(userId);
    }
  }
  async listRuns(userId: string): Promise<EvaluationRun[]> {
    if (
      !this.store.shared &&
      [...this.persistenceFailures.values()].some((run) => run.actor.id === userId)
    )
      throw this.persistenceFailure();
    return await this.store.listRuns(userId);
  }
  async getRun(userId: string, id: string): Promise<EvaluationRun> {
    const failed = this.persistenceFailures.get(id);
    if (!this.store.shared && failed?.actor.id === userId) throw this.persistenceFailure();
    return await this.store.getRun(userId, id);
  }

  private persistenceFailure(): EvaluationError {
    return new EvaluationError(
      503,
      "EVALUATION_PERSISTENCE_FAILED",
      "测评结果持久化失败，当前批次不可用",
    );
  }

  async listSessionIds(userId: string): Promise<string[]> {
    if (this.store.shared)
      return [
        ...new Set(
          (await this.store.listRuns(userId)).flatMap((run) =>
            run.turns.flatMap((turn) => (turn.session_id ? [turn.session_id] : [])),
          ),
        ),
      ];
    const ids = this.sessionIds.get(userId) ?? new Set<string>();
    if (!this.loadedSessionOwners.has(userId)) {
      for (const run of await this.store.listRuns(userId)) {
        for (const turn of run.turns) if (turn.session_id) ids.add(turn.session_id);
      }
      this.loadedSessionOwners.add(userId);
      this.sessionIds.set(userId, ids);
    }
    return [...ids];
  }

  private registerSession(userId: string, sessionId: string): void {
    const ids = this.sessionIds.get(userId) ?? new Set<string>();
    ids.add(sessionId);
    this.sessionIds.set(userId, ids);
  }

  async startRun(user: BackendUser, token: string, value: unknown): Promise<EvaluationRun> {
    await this.ready;
    const input = runInput(value);
    if (this.batch || this.starting)
      throw new EvaluationError(409, "EVALUATION_BUSY", "已有测评批次正在执行或停止");
    this.starting = true;
    try {
      const dataset = await this.store.getDataset(user.id, input.dataset_id);
      if (dataset.version !== input.dataset_version)
        throw new EvaluationError(
          409,
          "EVALUATION_VERSION_CONFLICT",
          "问题集版本已变化，请刷新后重试",
        );
      if (!token.trim())
        throw new EvaluationError(400, "EVALUATION_TOKEN_REQUIRED", "运行需要当前登录身份");
      const snapshot = await this.options.configuration?.(token);
      const runtime = snapshot?.config ?? this.config;
      const model = runtime.model;
      const configHash = evaluationHash({
        model: {
          name: model.name,
          baseUrl: model.baseUrl,
          userMessageSuffix: model.userMessageSuffix,
          extraBody: model.extraBody,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
        },
        compaction: runtime.compaction,
        modelRetry: runtime.modelRetry,
        modelFirstResponseTimeoutMs: runtime.modelFirstResponseTimeoutMs,
        modelStreamIdleTimeoutMs: runtime.modelStreamIdleTimeoutMs,
        answerStreaming: runtime.answerStreaming,
        ...(snapshot ? { versions: snapshot.versions } : {}),
      });
      const run: EvaluationRun = {
        id: randomUUID(),
        name: input.name,
        status: "running",
        dataset: structuredClone(dataset),
        dataset_hash: evaluationHash(dataset),
        version_label: input.version_label,
        data_label: input.data_label,
        model: model.name,
        config_hash: configHash,
        ...(snapshot ? { configuration_versions: snapshot.versions } : {}),
        actor: {
          id: user.id,
          name: user.display_name || user.username,
          org_code: user.org_code,
          role_code: user.role_code,
        },
        created_at: new Date().toISOString(),
        finished_at: null,
        turns: dataset.groups.flatMap((group) =>
          group.turns.map((question): EvaluationTurn => ({
            ...question,
            group_id: group.id,
            status: "pending",
            session_id: null,
            request_id: null,
            started_at: null,
            finished_at: null,
            result: null,
            review: null,
          })),
        ),
      };
      if (this.store.startExecution) await this.store.startExecution(user.id, run);
      else await this.store.saveRun(user.id, run);
      const batch: ActiveBatch = {
        service: this,
        run,
        token,
        abort: new AbortController(),
        task: Promise.resolve(),
        cancellation: null,
        cancellationSettled: false,
        cancelFailure: null,
        currentTurn: null,
        executionSettled: false,
      };
      this.batch = batch;
      if (this.store.maintainExecution) {
        batch.maintenance = setInterval(() => {
          if (batch.maintaining) return;
          batch.maintaining = true;
          void this.checkExecution(batch)
            .then(async () => {
              if (batch.abort.signal.aborted && !batch.leaseLost && batch.run.status === "running")
                await this.cancelRun(batch.run.actor.id, batch.token, batch.run.id);
            })
            .catch(() => {})
            .finally(() => {
              batch.maintaining = false;
            });
        }, 3_000);
        batch.maintenance.unref();
      }
      // 延后执行，先把唯一运行身份交回调用者；异常始终走终态保存与释放分支。
      batch.task = Promise.resolve()
        .then(() => this.execute(batch))
        .catch(async (error: unknown) => {
          run.status = batch.cancelFailure ? "cancelling" : "failed";
          run.finished_at = batch.cancelFailure ? null : new Date().toISOString();
          skipPending(run);
          for (const turn of run.turns) {
            if (turn.status === "running") {
              turn.status = "failed";
              turn.result = failedResult(error, turn.result);
              turn.finished_at = new Date().toISOString();
            }
          }
          try {
            await this.store.saveRun(user.id, run);
          } catch {
            this.persistenceFailures.set(run.id, structuredClone(run));
            console.error("测评批次终态无法写入持久存储");
          }
          if (!(error instanceof EvaluationError)) console.error("测评批次协调执行失败");
        })
        .finally(async () => {
          batch.executionSettled = true;
          batch.token = "";
          if (run.status !== "cancelling" || batch.leaseLost) {
            clearInterval(batch.maintenance);
            if (!batch.leaseLost)
              await this.store.endExecution?.(run).catch(() => {
                console.error("测评终态已保存，但执行槽未能释放，请停止原批次确认后重试");
              });
            if (this.batch === batch) this.batch = undefined;
          }
        });
      return structuredClone(run);
    } finally {
      this.starting = false;
    }
  }

  async waitForIdle(): Promise<void> {
    await this.batch?.task;
  }

  private async checkExecution(batch: ActiveBatch): Promise<void> {
    if (!this.store.maintainExecution || batch.leaseLost) return;
    try {
      const state = await this.store.maintainExecution(batch.run);
      batch.cancelConfirmed = state.cancelConfirmed;
      if (state.cancelRequested) batch.abort.abort();
    } catch (error) {
      // 数据库失联或代次失效都停止继续发题；外部已接纳操作另外按 request_id 请求停止。
      batch.leaseLost = true;
      clearInterval(batch.maintenance);
      batch.abort.abort();
      void this.requestCancellation(batch, batch.token).catch(() => {});
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    const batch = this.batch;
    if (!batch || batch.service !== this) return;
    try {
      if (batch.run.status === "running") {
        await this.cancelRun(batch.run.actor.id, batch.token, batch.run.id);
      }
    } finally {
      await batch.task;
      clearInterval(batch.maintenance);
    }
  }

  async cancelRun(userId: string, token: string, id: string): Promise<EvaluationRun> {
    const batch = this.batch;
    if (
      !batch ||
      batch.service !== this ||
      batch.run.id !== id ||
      batch.run.actor.id !== userId ||
      batch.leaseLost
    ) {
      if (this.store.requestExecutionCancellation) return this.cancelRemote(userId, token, id);
      await this.getRun(userId, id);
      throw new EvaluationError(409, "EVALUATION_NOT_RUNNING", "该测评批次当前未在执行");
    }
    if (this.store.requestExecutionCancellation) {
      await this.checkExecution(batch).catch(() => {});
      if (batch.leaseLost) return this.cancelRemote(userId, token, id);
      await this.store.requestExecutionCancellation(userId, id);
    }
    if (!["running", "cancelling"].includes(batch.run.status)) {
      throw new EvaluationError(409, "EVALUATION_NOT_RUNNING", "该测评批次当前未在执行");
    }
    if (batch.cancelFailure && batch.cancellationSettled) {
      // 先收束旧观察任务，再由本次请求重新确认，避免旧终态覆盖重试中的状态。
      await batch.task;
      if (batch.cancelFailure && batch.cancellationSettled) batch.cancellation = null;
    }
    batch.run.status = "cancelling";
    let cancellingWriteFailed = false;
    try {
      await this.store.saveRun(userId, batch.run);
    } catch {
      // 持久化失败必须反馈给调用者，但不能阻止实际取消，也不能继续发送后续问题。
      cancellingWriteFailed = true;
    }
    // 先发服务端取消，再中止本地等待；终态必须等待取消确认，不能仅凭 SSE 断开宣称已停止。
    const cancellation = this.requestCancellation(batch, token);
    batch.abort.abort();
    await cancellation.catch(() => undefined);
    if (batch.executionSettled) {
      await batch.task;
      if (batch.run.status === "cancelling") {
        try {
          await this.finishCancellation(batch);
        } finally {
          if (!batch.cancelFailure && this.batch === batch) {
            await this.store.endExecution?.(batch.run);
            clearInterval(batch.maintenance);
            this.batch = undefined;
          }
        }
      }
    }
    if (batch.cancelFailure)
      throw new EvaluationError(
        503,
        "EVALUATION_CANCEL_UNCONFIRMED",
        "无法确认原操作已停止，本批次不再继续执行",
      );
    if (cancellingWriteFailed)
      throw new EvaluationError(
        503,
        "EVALUATION_CANCELLING_PERSISTENCE_FAILED",
        "停止已请求，但停止状态未能及时保存，请刷新确认结果",
      );
    return structuredClone(batch.run);
  }

  private requestCancellation(batch: ActiveBatch, token: string): Promise<void> {
    if (batch.cancellation) return batch.cancellation;
    batch.cancelFailure = null;
    batch.cancellationSettled = false;
    const turn = batch.currentTurn;
    const cancellation = Promise.resolve().then(async () => {
      try {
        if (!batch.leaseLost)
          await this.store.requestExecutionCancellation?.(batch.run.actor.id, batch.run.id);
        if (!batch.cancelConfirmed && turn?.session_id && turn.request_id)
          await this.client.cancelTurn(token, turn.session_id, turn.request_id);
        if (!batch.leaseLost)
          await this.store.confirmExecutionCancellation?.(batch.run.actor.id, batch.run.id);
      } catch (error) {
        // 未确认原操作停止时保留执行槽；身份过期也只能由当前令牌再次确认。
        batch.cancelFailure = {
          ...failedResult(error, turn?.result),
          error_code: "EVALUATION_CANCEL_UNCONFIRMED",
          error_message: authenticationFailure(error)
            ? "停止确认时登录或权限已失效，请重新登录后再次停止"
            : "无法确认原操作已停止，请再次停止以确认结果",
        };
        throw new BackendApiError(
          503,
          batch.cancelFailure.error_message ?? "停止未确认",
          "EVALUATION_CANCEL_UNCONFIRMED",
        );
      }
    });
    batch.cancellation = cancellation;
    const settled = () => {
      batch.cancellationSettled = true;
    };
    void cancellation.then(settled, settled);
    return cancellation;
  }

  private async cancelRemote(userId: string, token: string, id: string): Promise<EvaluationRun> {
    const plan = await this.store.requestExecutionCancellation!(userId, id);
    // 先持久停止意图，再用本次有效身份确认原生操作停止；令牌从不写库。
    const current = plan.run.turns
      .slice()
      .reverse()
      .find((turn) => turn.session_id && turn.request_id);
    if (current?.session_id && current.request_id)
      await this.client.cancelTurn(token, current.session_id, current.request_id);
    try {
      await this.store.confirmExecutionCancellation!(userId, id);
    } catch (error) {
      const latest = await this.getRun(userId, id);
      if (!["running", "cancelling"].includes(latest.status)) return latest;
      throw error;
    }
    if (!plan.canFinalize) return { ...plan.run, status: "cancelling" };
    if (["running", "cancelling"].includes(plan.run.status)) {
      const now = new Date().toISOString();
      plan.run.status = "cancelled";
      plan.run.finished_at = now;
      for (const turn of plan.run.turns) {
        if (turn.status === "running") {
          turn.status = "cancelled";
          turn.finished_at = now;
          turn.result = {
            ...failedResult(undefined, turn.result),
            status: "cancelled",
            error_code: "EVALUATION_CANCELLED",
            error_message: "执行节点离线后，已确认原操作停止；未重跑题目",
          };
        }
      }
      skipPending(plan.run);
      await this.store.saveRun(userId, plan.run);
    }
    await this.store.endExecution!(plan.run);
    return plan.run;
  }

  private async finishCancellation(batch: ActiveBatch): Promise<void> {
    const { run, currentTurn: turn } = batch;
    const now = new Date().toISOString();
    run.status = batch.cancelFailure ? "cancelling" : "cancelled";
    run.finished_at = batch.cancelFailure ? null : now;
    if (turn) {
      turn.status = batch.cancelFailure ? "failed" : "cancelled";
      turn.finished_at = now;
      turn.result = batch.cancelFailure
        ? {
            ...batch.cancelFailure,
            user_entry_id: turn.result?.user_entry_id ?? batch.cancelFailure.user_entry_id,
            operation_id: turn.result?.operation_id ?? batch.cancelFailure.operation_id,
          }
        : {
            ...failedResult(undefined, turn.result),
            status: "cancelled",
            run_status: turn.result?.run_status ?? null,
            answer_status: turn.result?.answer_status ?? null,
            timings_ms: turn.result?.timings_ms ?? {},
            error_code: "EVALUATION_CANCELLED",
            error_message: "测评已停止",
          };
    }
    skipPending(run);
    try {
      await this.store.saveRun(run.actor.id, run);
      this.persistenceFailures.delete(run.id);
    } catch {
      this.persistenceFailures.set(run.id, structuredClone(run));
      throw this.persistenceFailure();
    }
  }

  async turnDetail(
    userId: string,
    token: string,
    runId: string,
    turnId: string,
  ): Promise<EvaluationTurnDetail> {
    const run = await this.getRun(userId, runId);
    if (run.status === "deleting")
      throw new EvaluationError(
        409,
        "EVALUATION_DELETING",
        "该批次已开始删除，不能再查看或复核依据",
      );
    const turn = findTurn(run, turnId);
    // 只保存执行身份；正文必须通过当前令牌重新授权读取正式会话投影。
    const messages =
      turn.session_id && turn.result?.user_entry_id
        ? await this.client.readTurn(token, turn.session_id, turn.result.user_entry_id)
        : [];
    return { turn, messages };
  }

  async reviewTurn(
    user: BackendUser,
    runId: string,
    turnId: string,
    value: unknown,
  ): Promise<EvaluationTurn> {
    if (this.store.reviewTurn)
      return this.store.reviewTurn(user.id, runId, turnId, reviewInput(value, user));
    const stored = await this.getRun(user.id, runId);
    if (stored.status === "deleting")
      throw new EvaluationError(
        409,
        "EVALUATION_DELETING",
        "该批次已开始删除，不能再查看或复核依据",
      );
    const run =
      this.batch?.service === this && this.batch.run.id === runId ? this.batch.run : stored;
    const turn = findTurn(run, turnId);
    if (turn.status === "pending" || turn.status === "running")
      throw new EvaluationError(409, "EVALUATION_REVIEW_NOT_READY", "该轮尚未结束，不能人工复核");
    turn.review = reviewInput(value, user);
    await this.store.saveRun(user.id, run);
    return structuredClone(turn);
  }

  private async execute(batch: ActiveBatch): Promise<void> {
    const { run } = batch;
    for (const group of run.dataset.groups) {
      await this.checkExecution(batch);
      if (batch.abort.signal.aborted) break;
      batch.currentTurn = null;
      const turns = run.turns.filter((turn) => turn.group_id === group.id);
      let sessionId: string;
      try {
        sessionId = await this.client.createSession(batch.token);
      } catch (error) {
        const first = turns[0];
        if (first) {
          first.status = "failed";
          first.result = failedResult(error);
          first.finished_at = new Date().toISOString();
        }
        skipPending(run, group.id);
        if (authenticationFailure(error)) {
          run.status = "failed";
          skipPending(run);
          break;
        }
        await this.store.saveRun(run.actor.id, run);
        continue;
      }
      this.registerSession(run.actor.id, sessionId);
      for (const turn of turns) turn.session_id = sessionId;
      await this.store.saveRun(run.actor.id, run);
      for (const turn of turns) {
        await this.checkExecution(batch);
        if (batch.abort.signal.aborted) break;
        turn.status = "running";
        turn.session_id = sessionId;
        turn.request_id = randomUUID();
        turn.started_at = new Date().toISOString();
        batch.currentTurn = turn;
        batch.cancellation = null;
        batch.cancellationSettled = false;
        await this.store.saveRun(run.actor.id, run);
        await this.checkExecution(batch);
        if (batch.abort.signal.aborted) break;
        try {
          turn.result = await this.client.executeTurn({
            token: batch.token,
            sessionId,
            requestId: turn.request_id,
            question: turn.question,
            ...(run.configuration_versions
              ? { configurationVersions: run.configuration_versions }
              : {}),
            signal: batch.abort.signal,
            cancel: () => this.requestCancellation(batch, batch.token),
            onIdentity: async (identity) => {
              // 接纳身份先落盘；正文仍只从当前授权的原生快照读取。
              turn.result = {
                ...identity,
                status: "running",
                run_status: null,
                answer_status: null,
                error_code: null,
                error_message: null,
                timings_ms: {},
              };
              await this.store.saveRun(run.actor.id, run);
            },
          });
        } catch (error) {
          if (error instanceof EvaluationError) throw error;
          const failure = failedResult(error, turn.result);
          turn.result =
            batch.abort.signal.aborted && failure.error_code === "EVALUATION_EXECUTION_FAILED"
              ? {
                  ...failure,
                  status: "cancelled",
                  error_code: "EVALUATION_CANCELLED",
                  error_message: "测评已停止",
                }
              : failure;
        }
        await this.checkExecution(batch);
        turn.status = batch.abort.signal.aborted ? "cancelled" : turn.result.status;
        turn.finished_at = new Date().toISOString();
        if (turn.result.error_code === "EVALUATION_CANCEL_UNCONFIRMED") {
          batch.cancelFailure ??= turn.result;
          batch.abort.abort();
          break;
        }
        if (turn.result.error_code && authenticationCodes.has(turn.result.error_code)) {
          run.status = "failed";
          turn.status = "failed";
          skipPending(run);
          break;
        }
        if (turn.status !== "completed") {
          skipPending(run, group.id);
          break;
        }
        await this.store.saveRun(run.actor.id, run);
      }
      await this.store.saveRun(run.actor.id, run);
      if (run.status === "failed") break;
    }
    await this.checkExecution(batch);
    if (batch.abort.signal.aborted && !batch.cancellation && !batch.cancelFailure)
      await this.requestCancellation(batch, batch.token).catch(() => {});
    await batch.cancellation?.catch(() => undefined);
    if (batch.abort.signal.aborted) {
      await this.finishCancellation(batch);
      return;
    }
    if (run.status !== "failed") run.status = "completed";
    skipPending(run);
    run.finished_at = new Date().toISOString();
    await this.store.saveRun(run.actor.id, run);
  }
}
