/** 模型调用契约错误不属于用户业务条件，不能保存为新焦点或冲掉候选。 */
export class BusinessInputError extends Error {
  constructor(readonly code: string, readonly field: string, readonly correction: string) {
    super(code);
  }
}
