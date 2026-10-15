import {Type, validateToolArguments} from "@earendil-works/pi-ai";
import {BACKGROUND_CONTEXT, value, type AgentHarnessTool, type JsonlSessionMetadata, type OpenOperation, type Session} from "@earendil-works/pi-agent-core";
import {isFixedTurnArgs, fixedTurnParameters} from "./business-context/fixedTurnArgs.js";
import {createResolveBusinessTurnTool} from "./tools/businessContext.js";
import type {AskMetricRequestContext} from "./requestContext.js";

interface TrustedCall {operationId: string; callId: string; raw: unknown; validated: unknown; executor: AgentHarnessTool<AskMetricRequestContext>}
interface StoredOperation {at: string; batch?: {assistantEntryId: string; calls: Array<{sourceIndex: number; status: string}>}}
interface Association {operationId: string; toolProtocol?: string}
const fingerprint = (value: unknown): string => JSON.stringify(value);

/**
 * 只为打开前已保存、尚未执行的旧调用建立一次性桥接。私有联合 Schema 仅供 SDK 恢复校验，
 * 每次模型请求的公开参数仍强制为 fixedTurnParameters；新输出不能借旧格式执行。
 */
export class FixedTurnCompatibility {
  private readonly trusted = new Map<string, TrustedCall>();
  private readonly legacy = [createResolveBusinessTurnTool(), createResolveBusinessTurnTool({compactTurnArgs: true})];

  async capture(session: Session<JsonlSessionMetadata>, open: readonly OpenOperation[]): Promise<void> {
    for (const operation of open) {
      if (operation.lane !== "main" || operation.kind !== "run") continue;
      const requestId = (await session.getValue(value<string>("askmetric", `operation/${operation.operationId}`), BACKGROUND_CONTEXT))?.value;
      const association = requestId ? (await session.getValue(value<Association>("askmetric", `request/${requestId}`), BACKGROUND_CONTEXT))?.value : undefined;
      if (!association || association.operationId !== operation.operationId || association.toolProtocol === "fixed_v1") continue;
      const state = (await session.getValue(value<StoredOperation>("pi.op.state", operation.operationId), BACKGROUND_CONTEXT))?.value;
      if (state?.at !== "tools" || !state.batch) continue;
      const entry = await session.getEntry(state.batch.assistantEntryId, BACKGROUND_CONTEXT);
      if (entry?.type !== "message" || entry.message.role !== "assistant") continue;
      for (const pending of state.batch.calls) {
        // effect_pending 的未知副作用由原生 replay=never 处理，不能擅自重发。
        if (pending.status !== "planned") continue;
        const call = entry.message.content[pending.sourceIndex];
        if (call?.type !== "toolCall" || call.name !== "resolve_business_turn" || isFixedTurnArgs(call.arguments)) continue;
        const executor = this.legacy[Object.hasOwn(call.arguments, "mode") ? 1 : 0]!;
        try {
          const raw = structuredClone(call.arguments);
          const prepared = executor.prepareArguments?.(structuredClone(raw)) ?? structuredClone(raw);
          const validated = validateToolArguments(executor, {...call, arguments: prepared});
          this.trusted.set(`${operation.operationId}:${call.id}`, {operationId: operation.operationId, callId: call.id, raw, validated, executor});
        } catch { /* 非法旧调用保留原生失败语义，不补造参数或授予执行许可。 */ }
      }
    }
  }

  /** 第一次新的模型请求开始即关闭旧白名单，不能授权模型仿造旧调用。 */
  close(): void {this.trusted.clear();}

  wrap(tool: AgentHarnessTool<AskMetricRequestContext>): AgentHarnessTool<AskMetricRequestContext> {
    if (tool.name !== "resolve_business_turn") return tool;
    return {...tool, parameters: Type.Union([fixedTurnParameters, ...this.legacy.map(item => item.parameters)]),
      prepareArguments: args => {
        if (isFixedTurnArgs(args)) return args;
        if (args && typeof args === "object" && Object.hasOwn(args, "protocol_version")) return tool.prepareArguments?.(args) ?? args;
        const original = [...this.trusted.values()].find(call => fingerprint(call.raw) === fingerprint(args));
        if (!original) throw new Error("FIXED_TURN_ARGUMENTS_REQUIRED: 请使用唯一固定业务入口Schema。");
        return structuredClone(original.validated) as Record<string, unknown>;
      },
      execute: async (callId, args, update, request, invocation, context) => {
        if (isFixedTurnArgs(args)) return tool.execute(callId, args, update, request, invocation, context);
        const key = `${request.operationId}:${callId}`, original = this.trusted.get(key);
        if (!original || invocation.operationId !== original.operationId || fingerprint(args) !== fingerprint(original.validated)) {
          throw new Error("LEGACY_TURN_NOT_TRUSTED: 旧调用只允许原操作与原callId恢复。");
        }
        this.trusted.delete(key);
        // 原旧参数执行，不经过 fixed→Delta 回转，保留 retain、目标声明与既有幂等命令键。
        return original.executor.execute(callId, structuredClone(original.validated) as Record<string, unknown>, update, request, invocation, context);
      }};
  }
}

/** provider 实际发送边界：内部恢复联合不能成为模型可见协议。 */
export function fixedPublicToolDefinitions(payload: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(payload.tools)) return payload;
  return {...payload, tools: payload.tools.map(raw => {
    if (!raw || typeof raw !== "object") return raw;
    const definition = raw as {name?: string; parameters?: unknown; function?: {name?: string; parameters?: unknown}};
    if (definition.function?.name === "resolve_business_turn") return {...definition,
      function: {...definition.function, parameters: fixedTurnParameters}};
    return definition.name === "resolve_business_turn" ? {...definition, parameters: fixedTurnParameters} : raw;
  })};
}
