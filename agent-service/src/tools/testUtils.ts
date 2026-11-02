/**
 * 工具单测辅助：内存版命令桥接/历史桥接与请求上下文工厂。
 * 只服务测试，不进入运行链路。
 */
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/pi-agent-core";
import type { BackendClient, BackendUser } from "../backendClient.js";
import type {
  AskMetricRequestContext,
  CommandBridge,
  HistoryBridge,
  WriteCommandRecord,
} from "../requestContext.js";

export const TEST_ACTOR: BackendUser = {
  id: "user-1",
  username: "user1",
  display_name: "测试用户",
  org_code: "3200",
  org_name: "测试机构",
  role_code: "USER",
};

export class MemoryCommandBridge implements CommandBridge {
  record: WriteCommandRecord | undefined;
  conversationId: string | null = null;

  async getWriteCommand(): Promise<WriteCommandRecord | undefined> {
    return this.record;
  }

  async setWriteCommand(record: WriteCommandRecord): Promise<void> {
    this.record = record;
  }

  async getConversationId(): Promise<string | null> {
    return this.conversationId;
  }

  async setConversationId(conversationId: string): Promise<void> {
    this.conversationId = conversationId;
  }
}

export const emptyHistory: HistoryBridge = {
  async list() {
    return { entries: [], next_before_seq: null, has_more: false };
  },
  async read() {
    return null;
  },
};

export function testRequestContext(
  backend: BackendClient,
  bridge: MemoryCommandBridge,
  overrides: Partial<AskMetricRequestContext> = {},
): AskMetricRequestContext {
  return {
    actor: TEST_ACTOR,
    backend,
    originalMessage: "查询存款余额",
    promptFingerprint: "fp-test",
    sessionId: "session-1",
    requestId: "req-1",
    operationId: "op-1",
    commands: bridge,
    history: emptyHistory,
    ...overrides,
  };
}

/** 以原生六参数调用工具；返回值保持宽松类型，便于测试直接读 content/details */
export async function runTool(
  tool: { execute: unknown },
  params: unknown,
  request: AskMetricRequestContext,
  context: Context = BACKGROUND_CONTEXT,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const execute = tool.execute as (
    toolCallId: string,
    params: unknown,
    onUpdate: () => void,
    toolContext: AskMetricRequestContext,
    invocation: {
      invocationId: string;
      operationId: string;
      turnId: string;
      getMemo: () => Promise<undefined>;
      setMemo: () => Promise<void>;
    },
    context: Context,
  ) => Promise<{ content: unknown; details?: unknown }>;
  return execute(
    "tc-1",
    params,
    () => {},
    request,
    {
      invocationId: "inv-1",
      operationId: request.operationId,
      turnId: "turn-1",
      getMemo: async () => undefined,
      setMemo: async () => undefined,
    },
    context,
  );
}

export function receiptJson(result: { content: unknown }): Record<string, unknown> {
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}
