import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { DatasetInput, EvaluationDataset, EvaluationRun, EvaluationTurn } from "./types.js";

// 运行记录同时冻结问题集与逐轮状态，并允许补充复核；读写必须遵守同一容量契约。
const MAX_STORED_JSON_BYTES = 8 * 1024 * 1024;

export class EvaluationError extends Error {
  constructor(
    public readonly status: 400 | 404 | 409 | 503,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "EvaluationError";
  }
}

export function evaluationRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new EvaluationError(400, "EVALUATION_INPUT_INVALID", "请求结构无效");
  }
  return value as Record<string, unknown>;
}

export function evaluationText(
  value: unknown,
  label: string,
  limit: number,
  allowEmpty = false,
): string {
  if (typeof value !== "string" || value.length > limit || (!allowEmpty && !value.trim())) {
    throw new EvaluationError(400, "EVALUATION_INPUT_INVALID", `${label}无效或超过长度限制`);
  }
  return value.trim();
}

export function evaluationIdentity(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) {
    throw new EvaluationError(400, "EVALUATION_ID_INVALID", "资源标识无效");
  }
  return value;
}

export function evaluationVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new EvaluationError(400, "EVALUATION_VERSION_INVALID", "问题集版本无效");
  }
  return value;
}

export function parseDatasetInput(value: unknown): DatasetInput {
  const input = evaluationRecord(value);
  const name = evaluationText(input.name, "问题集名称", 200);
  const description = evaluationText(input.description, "问题集说明", 2_000, true);
  if (!Array.isArray(input.groups) || !input.groups.length || input.groups.length > 100) {
    throw new EvaluationError(400, "EVALUATION_GROUPS_INVALID", "问题集需要 1 到 100 组问题");
  }
  const groupIds = new Set<string>();
  const turnIds = new Set<string>();
  let count = 0;
  const groups = input.groups.map((raw: unknown) => {
    const group = evaluationRecord(raw);
    const id = evaluationIdentity(group.id);
    if (groupIds.has(id))
      throw new EvaluationError(400, "EVALUATION_DUPLICATE_ID", "问题组标识重复");
    groupIds.add(id);
    if (!Array.isArray(group.turns) || !group.turns.length) {
      throw new EvaluationError(400, "EVALUATION_TURNS_INVALID", "每组至少需要一轮问题");
    }
    const turns = group.turns.map((row: unknown) => {
      const question = evaluationRecord(row);
      const turnId = evaluationIdentity(question.id);
      if (turnIds.has(turnId))
        throw new EvaluationError(400, "EVALUATION_DUPLICATE_ID", "问题标识重复");
      turnIds.add(turnId);
      if (++count > 100)
        throw new EvaluationError(400, "EVALUATION_TURN_LIMIT", "每批最多支持 100 轮问题");
      return {
        id: turnId,
        question: evaluationText(question.question, "问题", 4_000),
        expected: evaluationText(question.expected, "人工期望", 8_000, true),
      };
    });
    return { id, name: evaluationText(group.name, "问题组名称", 200), turns };
  });
  return { name, description, groups };
}

export function evaluationHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function storageError(): EvaluationError {
  return new EvaluationError(503, "EVALUATION_STORAGE_UNAVAILABLE", "测评存储暂不可用");
}

function ensureDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw storageError();
}

function atomicWrite(path: string, value: unknown): void {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > MAX_STORED_JSON_BYTES) {
    throw new EvaluationError(400, "EVALUATION_STORAGE_LIMIT", "测评记录超过存储容量限制");
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, serialized, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

function readJson(path: string): unknown {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_STORED_JSON_BYTES)
    throw storageError();
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function storedDataset(value: unknown): EvaluationDataset {
  const row = evaluationRecord(value);
  return {
    ...parseDatasetInput(row),
    id: evaluationIdentity(row.id),
    version: evaluationVersion(row.version),
    updated_at: evaluationText(row.updated_at, "更新时间", 50),
  };
}

function isStoredTurn(value: unknown): value is EvaluationTurn {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === "string" &&
    typeof row.group_id === "string" &&
    typeof row.question === "string" &&
    typeof row.expected === "string" &&
    ["pending", "running", "completed", "failed", "cancelled", "skipped"].includes(
      String(row.status),
    )
  );
}

function isStoredRun(value: unknown): value is EvaluationRun {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (
    !["running", "cancelling", "completed", "failed", "cancelled", "interrupted"].includes(
      String(row.status),
    )
  )
    return false;
  if (!Array.isArray(row.turns) || row.turns.length > 100 || !row.turns.every(isStoredTurn))
    return false;
  const actor = evaluationRecord(row.actor);
  return (
    [
      "id",
      "name",
      "dataset_hash",
      "version_label",
      "data_label",
      "model",
      "config_hash",
      "created_at",
    ].every((name) => typeof row[name] === "string") &&
    ["id", "name", "org_code", "role_code"].every((name) => typeof actor[name] === "string")
  );
}

function storedRun(value: unknown): EvaluationRun {
  if (!isStoredRun(value)) throw storageError();
  storedDataset(value.dataset);
  evaluationIdentity(value.id);
  return value;
}

function frozenRun(run: EvaluationRun): string {
  return JSON.stringify({
    id: run.id,
    name: run.name,
    dataset: run.dataset,
    dataset_hash: run.dataset_hash,
    version_label: run.version_label,
    data_label: run.data_label,
    model: run.model,
    config_hash: run.config_hash,
    actor: run.actor,
    created_at: run.created_at,
  });
}

/** 服务沿用数据根单写锁；每个账号、问题集与批次分别保存，更新以原子替换提交。 */
export class EvaluationStore {
  readonly root: string;
  constructor(dataDir: string) {
    this.root = resolve(dataDir, "evaluation-v1");
    this.io(() => ensureDirectory(this.root));
  }

  private io<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (error instanceof EvaluationError) throw error;
      throw storageError();
    }
  }

  private directory(ownerId: string, kind: "datasets" | "runs"): string {
    if (!ownerId.trim()) throw new EvaluationError(400, "EVALUATION_OWNER_INVALID", "用户身份无效");
    const owner = join(this.root, createHash("sha256").update(ownerId).digest("hex"));
    ensureDirectory(owner);
    const directory = join(owner, kind);
    ensureDirectory(directory);
    return directory;
  }

  listDatasets(ownerId: string): EvaluationDataset[] {
    return this.io(() =>
      readdirSync(this.directory(ownerId, "datasets"))
        .filter((name) => name.endsWith(".json"))
        .map((name) => storedDataset(readJson(join(this.directory(ownerId, "datasets"), name))))
        .sort((left, right) => right.updated_at.localeCompare(left.updated_at)),
    );
  }

  getDataset(ownerId: string, id: string): EvaluationDataset {
    evaluationIdentity(id);
    return this.io(() => {
      try {
        return storedDataset(readJson(join(this.directory(ownerId, "datasets"), `${id}.json`)));
      } catch (error) {
        if (missing(error))
          throw new EvaluationError(404, "EVALUATION_DATASET_NOT_FOUND", "问题集不存在");
        throw error;
      }
    });
  }

  createDataset(ownerId: string, value: unknown): EvaluationDataset {
    const input = parseDatasetInput(value);
    const dataset = {
      ...input,
      id: randomUUID(),
      version: 1,
      updated_at: new Date().toISOString(),
    };
    this.io(() =>
      atomicWrite(join(this.directory(ownerId, "datasets"), `${dataset.id}.json`), dataset),
    );
    return structuredClone(dataset);
  }

  updateDataset(ownerId: string, id: string, version: number, value: unknown): EvaluationDataset {
    evaluationVersion(version);
    const input = parseDatasetInput(value);
    const current = this.getDataset(ownerId, id);
    if (current.version !== version)
      throw new EvaluationError(
        409,
        "EVALUATION_VERSION_CONFLICT",
        "问题集版本已变化，请刷新后重试",
      );
    const next = { ...input, id, version: version + 1, updated_at: new Date().toISOString() };
    this.io(() => atomicWrite(join(this.directory(ownerId, "datasets"), `${id}.json`), next));
    return structuredClone(next);
  }

  listRuns(ownerId: string): EvaluationRun[] {
    return this.io(() =>
      readdirSync(this.directory(ownerId, "runs"))
        .filter((name) => name.endsWith(".json"))
        .map((name) => storedRun(readJson(join(this.directory(ownerId, "runs"), name))))
        .sort((left, right) => right.created_at.localeCompare(left.created_at)),
    );
  }

  getRun(ownerId: string, id: string): EvaluationRun {
    evaluationIdentity(id);
    return this.io(() => {
      try {
        const run = storedRun(readJson(join(this.directory(ownerId, "runs"), `${id}.json`)));
        if (run.actor.id !== ownerId)
          throw new EvaluationError(404, "EVALUATION_RUN_NOT_FOUND", "测评批次不存在");
        return run;
      } catch (error) {
        if (missing(error))
          throw new EvaluationError(404, "EVALUATION_RUN_NOT_FOUND", "测评批次不存在");
        throw error;
      }
    });
  }

  saveRun(ownerId: string, run: EvaluationRun): void {
    evaluationIdentity(run.id);
    if (run.actor.id !== ownerId)
      throw new EvaluationError(404, "EVALUATION_RUN_NOT_FOUND", "测评批次不存在");
    this.io(() => {
      const path = join(this.directory(ownerId, "runs"), `${run.id}.json`);
      try {
        const previous = storedRun(readJson(path));
        if (frozenRun(previous) !== frozenRun(run))
          throw new EvaluationError(409, "EVALUATION_RUN_IMMUTABLE", "测评输入快照不可修改");
      } catch (error) {
        if (!missing(error)) throw error;
      }
      atomicWrite(path, run);
    });
  }

  recoverInterruptedRuns(): void {
    this.io(() => {
      for (const owner of readdirSync(this.root, { withFileTypes: true })) {
        if (!/^[a-f0-9]{64}$/.test(owner.name)) continue;
        if (!owner.isDirectory() || owner.isSymbolicLink()) throw storageError();
        const directory = join(this.root, owner.name, "runs");
        let names: string[];
        try {
          names = readdirSync(directory);
        } catch (error) {
          if (missing(error)) continue;
          throw error;
        }
        for (const name of names.filter((entry) => entry.endsWith(".json"))) {
          const path = join(directory, name);
          const run = storedRun(readJson(path));
          if (run.status !== "running" && run.status !== "cancelling") continue;
          const now = new Date().toISOString();
          run.status = "interrupted";
          run.finished_at = now;
          for (const turn of run.turns) {
            if (turn.status === "pending") {
              turn.status = "skipped";
              turn.finished_at = now;
            } else if (turn.status === "running") {
              turn.status = "failed";
              turn.finished_at = now;
              turn.result = {
                status: "failed",
                run_status: null,
                user_entry_id: turn.result?.user_entry_id ?? null,
                operation_id: turn.result?.operation_id ?? null,
                answer_status: null,
                error_code: "EVALUATION_INTERRUPTED",
                error_message: "服务重启中断本轮，未自动重跑",
                timings_ms: {},
              };
            }
          }
          atomicWrite(path, run);
        }
      }
    });
  }
}
