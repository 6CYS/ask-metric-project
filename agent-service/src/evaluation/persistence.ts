import type {
  EvaluationDataset,
  EvaluationRun,
  EvaluationReview,
  EvaluationTurn,
} from "./types.js";

type Result<T> = T | Promise<T>;
/** 文件实现保留同步存储契约；服务统一等待提交完成，数据库实现不使用内存镜像代替持久化。 */
export interface EvaluationPersistence {
  readonly shared?: boolean;
  listDatasets(owner: string): Result<EvaluationDataset[]>;
  getDataset(owner: string, id: string): Result<EvaluationDataset>;
  createDataset(owner: string, input: unknown): Result<EvaluationDataset>;
  updateDataset(
    owner: string,
    id: string,
    version: number,
    input: unknown,
  ): Result<EvaluationDataset>;
  deleteDataset(owner: string, id: string, version: number): Result<void>;
  listRuns(owner: string): Result<EvaluationRun[]>;
  getRun(owner: string, id: string): Result<EvaluationRun>;
  saveRun(owner: string, run: EvaluationRun): Result<void>;
  deleteRun(owner: string, id: string): Result<void>;
  recoverInterruptedRuns(): Result<void>;
  reviewTurn?(
    owner: string,
    runId: string,
    turnId: string,
    review: EvaluationReview,
  ): Promise<EvaluationTurn>;
  startExecution?(owner: string, run: EvaluationRun): Promise<void>;
  maintainExecution?(
    run: EvaluationRun,
  ): Promise<{ cancelRequested: boolean; cancelConfirmed: boolean }>;
  requestExecutionCancellation?(
    owner: string,
    id: string,
  ): Promise<{ run: EvaluationRun; canFinalize: boolean }>;
  confirmExecutionCancellation?(owner: string, id: string): Promise<void>;
  endExecution?(run: EvaluationRun): Promise<void>;
}
