import {toCompactTurnArgs, toContextDelta} from "./turnArgs.js";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const COMPACT_ARGUMENT_RETRY_INSTRUCTION = "原焦点未改变表示这次参数校验失败的调用没有应用，该报错调用承载的字段变化尚未保存。纠正后的调用需重新提交该报错调用承载的本轮全部变化：只修正错误字段，保留同次调用其他有效的 set/remove/clear 及原先选择的 base（有 retry_reference 时沿用该引用）。不能只提交修正项而丢掉同次调用其他变化，也不能用 retain 代替该报错调用中的新 set；retain 仅继承来源中的旧值。";

/** 仅用于服务端生成的协议说明；用户原话、字段值及查询数据不能传入此函数。 */
export function turnArgumentHint(text: string, compactTurnArgs: boolean): string {
  if (!compactTurnArgs) return text;
  return text
    .replace(/fieldChanges\s*必须为空数组/g, "set/remove/clear/retain 必须省略或为空")
    .replace(/fieldChanges\s*=\s*\[\]/g, "不提交 set/remove/clear/retain")
    .replace(/operation\s*=\s*remove/g, "使用 remove 分组")
    .replace(/operation\s*=\s*clear/g, "使用 clear 数组")
    .replace(/operation\s*=\s*retain/g, "使用 retain 数组")
    .replace(/operation\s*=\s*set/g, "使用 set 分组")
    .replace(/省略 metrics 或 retain/g, "省略 metrics 或在 retain 中列出 metrics")
    .replace(/省略或 retain/g, "省略或列入 retain 数组")
    .replace(/capabilityHint/g, "capability")
    .replace(/baseReference/g, "base")
    .replace(/executionMode/g, "mode")
    .replace(/fieldChanges/g, "set/remove/clear/retain")
    .replace(/fieldHint/g, "字段名")
    .replace(/rawValue/g, "字段值");
}

function projectedHints(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    keys.includes(key) && typeof item === "string" ? turnArgumentHint(item, true) : item]));
}

function projectedIssues(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map(issue => record(issue) ? projectedHints(issue, ["message"]) : issue);
}

/** 能力字段的说明是受控协议；inputSchema 和业务枚举值保持原样。 */
export function projectCapabilitySchema(schema: unknown, compactTurnArgs: boolean): unknown {
  if (!compactTurnArgs || !record(schema) || !record(schema.fields)) return schema;
  return {...schema, fields: Object.fromEntries(Object.entries(schema.fields).map(([name, definition]) => [name,
    record(definition) ? projectedHints(definition, ["description", "validation", "input"]) : definition]))};
}

function projectFrame(frame: unknown): unknown {
  if (!record(frame)) return frame;
  const output = {...frame};
  if (record(frame.delta)) {
    try { output.delta = toCompactTurnArgs(toContextDelta(frame.delta)); }
    catch { /* 非法或无法无损表示的历史参数保留原样，不修补权威记录。 */ }
  }
  if (Object.hasOwn(frame, "executionMode")) {
    output.mode = frame.executionMode;
    delete output.executionMode;
  }
  if (record(frame.continuation)) {
    const continuation = projectedHints(frame.continuation, ["instruction"]);
    if (Object.hasOwn(continuation, "baseReference")) {
      continuation.base = continuation.baseReference;
      delete continuation.baseReference;
    }
    output.continuation = continuation;
  }
  if (Object.hasOwn(frame, "instruction")) output.instruction = typeof frame.instruction === "string"
    ? turnArgumentHint(frame.instruction, true) : frame.instruction;
  if (Object.hasOwn(frame, "issues")) output.issues = projectedIssues(frame.issues);
  return output;
}

/**
 * 业务工具发送副本只投影已知协议路径。字段 rawValue、resultSummary、查询 data 和
 * current_user_input 都是业务数据，禁止递归替换其中恰好同名的键或字符串。
 */
export function projectBusinessToolReceipt(receipt: unknown, compactTurnArgs: boolean): unknown {
  if (!compactTurnArgs || !record(receipt)) return receipt;
  const output = {...receipt};
  for (const [legacy, compact] of [["executionMode", "mode"], ["baseReference", "base"], ["capabilityHint", "capability"]] as const) {
    if (Object.hasOwn(receipt, legacy)) {
      output[compact] = receipt[legacy];
      delete output[legacy];
    }
  }
  if (Object.hasOwn(receipt, "frame")) output.frame = projectFrame(receipt.frame);
  if (Array.isArray(receipt.frames)) output.frames = receipt.frames.map(entry => record(entry) && Object.hasOwn(entry, "frame")
    ? {...entry, frame: projectFrame(entry.frame)} : entry);
  if (Array.isArray(receipt.schemas)) output.schemas = receipt.schemas.map(schema => projectCapabilitySchema(schema, true));
  if (Object.hasOwn(receipt, "issues")) output.issues = projectedIssues(receipt.issues);
  // ARGUMENT_ERROR 的 field/message 来自 BusinessInputError；成功结果正文不能按协议文案处理。
  if (receipt.status === "ARGUMENT_ERROR") {
    Object.assign(output, projectedHints(output, ["field", "message", "reference_hint"]));
    // 发送副本独立给出重提契约，不能把“焦点保持不变”误读成本轮其他变化已保存。
    output.retry_instruction = COMPACT_ARGUMENT_RETRY_INSTRUCTION;
  } else if (receipt.status === "TEMPORARY_ERROR") {
    Object.assign(output, projectedHints(output, ["message", "reference_hint"]));
  }
  return output;
}
