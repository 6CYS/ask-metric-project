import type {HarnessEvent, LaneWatchEvent} from "@earendil-works/pi-agent-core";
import type {AssistantMessage} from "@earendil-works/pi-ai";
import type {AskMetricRequestContext} from "./requestContext.js";
import {CONVERSATION_REPLY} from "./tools/turnContract.js";

export type AnswerStreamMode = NonNullable<AskMetricRequestContext["answerStream"]>;
export type AnswerResetReason = "tool_call" | "retry" | "error" | "superseded";
export type AnswerStreamData = {call_seq: number; mode: "text" | "reply"; text: string}
  | {call_seq: number; reason: AnswerResetReason};

/** 观察投影无业务副作用；累计文本允许丢帧，最终快照才是正式回答。 */
export class AnswerStreamProjector {
  private stream: AnswerStreamMode | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending = "";
  private sent = "";
  private lastSentAt = -Infinity;
  private blocked = false;
  private endedWithTool = false;
  private closed = false;
  private disabled = false;

  constructor(private readonly send: (type: "answer_delta" | "answer_reset", data: AnswerStreamData) => void,
    private readonly throttleMs = 80) {}

  onWatchEvent(event: HarnessEvent | LaneWatchEvent, stream: AnswerStreamMode | undefined): void {
    this.guard(() => {
      if (!stream) return;
      if (stream.callSeq !== this.stream?.callSeq) {
        if (this.endedWithTool) this.reset("superseded");
        this.clearCall(stream);
      }
      if (stream.mode === "none" || !this.stream) return;
      if (event.type !== "message_update" && event.type !== "message_end") return;
      const message = event.message;
      if (message.role !== "assistant") return;
      const content: AssistantMessage["content"] = message.content;
      const calls = content.filter(block => block.type === "toolCall");
      if (event.type === "message_end") {
        this.endedWithTool = calls.length > 0;
        if (["error", "aborted"].includes(message.stopReason)) {
          this.reset("error");
          this.blocked = true;
          return;
        }
      }
      if (this.blocked) return;
      // 本地 watch 保留原生 event，远程 watch 只保留累计 message 与 frame；两者均只读。
      // 同时检查累计调用，防止共享 accumulator 已更新而 toolcall_start 尚未被消费。
      if (stream.mode === "text") {
        if (calls.length) {
          this.reset("tool_call");
          this.blocked = true;
          return;
        }
        if (event.type === "message_end" || (event.frame?.type ?? ("event" in event ? event.event.type : undefined)) === "text_delta") {
          this.queue(content.filter(block => block.type === "text").map(block => block.text).join(""));
        }
      } else {
        if (calls.length > 1) {
          this.reset("superseded");
          this.blocked = true;
          return;
        }
        const call = calls[0];
        if (call?.name === CONVERSATION_REPLY && typeof call.arguments.answer === "string"
          && call.arguments.answer.length > this.pending.length) this.queue(call.arguments.answer);
      }
      if (event.type === "message_end") this.flush();
    });
  }

  /** 原生 before_request 在重试前通知，撤回同一次调用的上一尝试。 */
  retry(callSeq: number): void {
    this.guard(() => {
      if (this.stream?.callSeq !== callSeq) return;
      this.reset("retry");
      this.clearCall(this.stream);
    });
  }

  close(): void {
    this.closed = true;
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private clearCall(stream: AnswerStreamMode): void {
    this.clearTimer();
    this.stream = stream;
    this.pending = this.sent = "";
    this.lastSentAt = -Infinity;
    this.blocked = this.endedWithTool = false;
  }

  private queue(text: string): void {
    if (!text.trim() || text === this.pending) return;
    this.pending = text;
    const remaining = this.throttleMs - (performance.now() - this.lastSentAt);
    if (remaining <= 0) this.flush();
    else if (!this.timer) this.timer = setTimeout(() => this.guard(() => this.flush()), remaining);
  }

  private flush(): void {
    this.clearTimer();
    if (!this.stream || this.stream.mode === "none" || this.blocked || !this.pending || this.sent === this.pending) return;
    this.send("answer_delta", {call_seq: this.stream.callSeq, mode: this.stream.mode, text: this.pending});
    this.sent = this.pending;
    this.lastSentAt = performance.now();
  }

  private reset(reason: AnswerResetReason): void {
    this.clearTimer();
    if (this.stream && this.sent) this.send("answer_reset", {call_seq: this.stream.callSeq, reason});
    this.pending = this.sent = "";
  }

  private guard(action: () => void): void {
    if (this.closed || this.disabled) return;
    try { action(); } catch {
      // 只记录错误类型，原始模型文本/参数不进入诊断日志。失败后继续原快照路径。
      try { this.reset("error"); } catch { /* 发送器也可能失效。 */ }
      this.disabled = true;
      this.clearTimer();
      console.warn(JSON.stringify({event: "answer_stream_failed", call_seq: this.stream?.callSeq}));
    }
  }
}
