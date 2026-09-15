/**
 * 会话持久化：每个会话一个 JSON 文件，原子写入（临时文件 + 改名）。
 * 保存完整 AgentMessage 列表（pi 上下文可序列化），重启后恢复会话与工具结果明细。
 * 存储目录由 AGENT_DATA_DIR 指定，生产位于持久状态目录，随升级保留。
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export interface PersistedSession {
  id: string;
  userId: string;
  username: string;
  /** 会话标题：取首条用户提问，截断 24 字；随消息持久化更新 */
  title: string;
  createdAt: number;
  lastActiveAt: number;
  messages: AgentMessage[];
}

const DEFAULT_SESSION_TITLE = "问数会话";

/** 用户消息文本提取：pi 会把提示词规整为内容块数组，兼容字符串与块两种形态 */
export function messageText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return (content as Array<{ type?: string; text?: string }>)
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("")
      .trim();
  }
  return "";
}

/** 从消息列表推导会话标题；无用户消息时用默认标题 */
export function deriveSessionTitle(messages: AgentMessage[]): string {
  const firstUser = messages.find(
    (m) => (m as { role?: string }).role === "user",
  ) as { content?: unknown } | undefined;
  const text = messageText(firstUser?.content);
  return text ? text.slice(0, 24) : DEFAULT_SESSION_TITLE;
}

const SAFE_SESSION_ID = /^[0-9a-f-]{36}$/;

export class SessionStore {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private pathOf(sessionId: string): string {
    if (!SAFE_SESSION_ID.test(sessionId)) {
      throw new Error("非法会话标识");
    }
    return join(this.dir, `${sessionId}.json`);
  }

  loadAll(): PersistedSession[] {
    const sessions: PersistedSession[] = [];
    for (const entry of readdirSync(this.dir)) {
      if (!entry.endsWith(".json")) continue;
      try {
        const raw = JSON.parse(readFileSync(join(this.dir, entry), "utf8")) as PersistedSession;
        if (typeof raw.id === "string" && Array.isArray(raw.messages)) {
          // 兼容早期无标题的会话文件
          raw.title = raw.title || deriveSessionTitle(raw.messages);
          sessions.push(raw);
        }
      } catch {
        // 单个会话文件损坏不影响其余会话；跳过并保留文件供排查
        console.warn(`跳过无法解析的会话文件: ${entry}`);
      }
    }
    return sessions;
  }

  save(session: PersistedSession): void {
    const target = this.pathOf(session.id);
    const tmp = join(this.dir, `.${session.id}.${randomUUID()}.tmp`);
    writeFileSync(tmp, JSON.stringify(session), { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, target);
  }

  delete(sessionId: string): void {
    rmSync(this.pathOf(sessionId), { force: true });
  }
}
