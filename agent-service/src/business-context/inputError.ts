import type {FieldInputCorrection} from "./types.js";

/** 只有用户补充才能恢复时，结束当前回合；不能把这类错误继续交给模型改参数。 */
export interface InputRecovery {action: "ask_user"; message: string}

/** 模型调用契约错误不属于用户业务条件，不能保存为新焦点或冲掉候选。 */
export class BusinessInputError extends Error {
  constructor(readonly code: string, readonly field: string, readonly correction: string,
    readonly baseReference?: {frameId: string}, readonly recovery?: InputRecovery,
    readonly corrections?: FieldInputCorrection[]) {
    super(code);
  }
}
