/**
 * 旧自建 JSON 会话的只读展示：原文件只读保留，不导入原生、不从旧历史续跑。
 * 切换后旧会话不可再提问；无法解析的文件跳过不展示。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ProjectedMessage } from "./sessionProjection.js";

/** 旧持久化格式（SessionStore）的最小只读视图 */
export interface LegacySession {
  id: string;
  userId: string;
  username: string;
  title: string;
  createdAt: number;
  lastActiveAt: number;
  messages: unknown[];
}

export function listLegacySessions(dir: string, userId: string): LegacySession[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const sessions: LegacySession[] = [];
  for (const entry of entries) {
    // 原生会话在 native-v1 子目录，这里只读旧 JSON 快照文件
    if (!entry.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(readFileSync(join(dir, entry), "utf8")) as LegacySession;
      if (typeof raw.id === "string" && raw.userId === userId && Array.isArray(raw.messages)) {
        sessions.push(raw);
      }
    } catch {
      // 单个文件损坏不影响其余会话
    }
  }
  return sessions;
}

export function getLegacySession(dir: string, userId: string, sessionId: string): LegacySession | undefined {
  return listLegacySessions(dir, userId).find((session) => session.id === sessionId);
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return (content as Array<{ type?: string; text?: string }>)
      .filter((block) => block?.type === "text")
      .map((block) => block.text ?? "")
      .join("")
      .trim();
  }
  return "";
}

/** 旧消息列表 → 页面消息；entry_id 以旧序号合成，仅供展示对齐 */
export function projectLegacyMessages(session: LegacySession): ProjectedMessage[] {
  const messages: ProjectedMessage[] = [];
  session.messages.forEach((raw, index) => {
    const message = raw as {
      role?: string;
      content?: unknown;
      timestamp?: number;
      toolName?: string;
      details?: unknown;
      isError?: boolean;
    };
    const entryId = `legacy-${index}`;
    const timestamp = message.timestamp ?? null;
    if (message.role === "user") {
      messages.push({ role: "user", text: textOf(message.content), timestamp, entry_id: entryId });
    } else if (message.role === "assistant") {
      const tools = Array.isArray(message.content)
        ? (message.content as Array<{ type?: string; name?: string }>)
            .filter((block) => block?.type === "toolCall")
            .map((block) => block.name ?? "")
        : [];
      messages.push({ role: "assistant", text: textOf(message.content), tools, timestamp, entry_id: entryId });
    } else if (message.role === "toolResult") {
      messages.push({
        role: "tool",
        tool: message.toolName ?? "",
        tool_call_id: "",
        details: message.details ?? null,
        is_error: Boolean(message.isError),
        timestamp,
        entry_id: entryId,
      });
    }
  });
  return messages;
}
