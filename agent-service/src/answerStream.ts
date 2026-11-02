import type { HarnessEvent, LaneWatchEvent } from "@earendil-works/pi-agent-core";
import { BackendApiError } from "./backendClient.js";
import type { AskMetricRequestContext } from "./requestContext.js";
import { normalizeReportParagraphs } from "./analysis/narrative.js";

export type AnswerStreamMode = NonNullable<AskMetricRequestContext["answerStream"]>;
export type AnswerResetReason = "tool_call" | "retry" | "error" | "superseded";
export type AnswerStreamData =
  | { call_seq: number; mode: "text" | "reply"; text: string }
  | { call_seq: number; reason: AnswerResetReason };

/** Markdown 空行作为展示边界，围栏和未闭合引用留给后续片段；不判断业务语义。 */
export function completeAnswerPrefix(source: string, ended: boolean): string {
  const text = normalizeReportParagraphs(source);
  let fence: { character: string; length: number } | undefined;
  let boundary = 0,
    offset = 0;
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (marker) {
      const delimiter = marker[1]!;
      if (!fence) fence = { character: delimiter[0]!, length: delimiter.length };
      else if (
        delimiter[0] === fence.character &&
        delimiter.length >= fence.length &&
        !marker[2]!.trim()
      )
        fence = undefined;
    } else if (!fence && !line.trim() && index < lines.length - 1) boundary = offset;
    offset += line.length + 1;
  }
  const prefix = text.slice(0, ended && !fence ? text.length : boundary).trimEnd();
  return prefix.lastIndexOf("{{") > prefix.lastIndexOf("}}") ? "" : prefix;
}

/** 只读观察投影：完整段落经正式报告的同源核验后才发布，最终快照覆盖临时正文。 */
export class AnswerStreamProjector {
  private stream: AnswerStreamMode | undefined;
  private pending = "";
  private processed = "";
  private sent = "";
  private rejectedPrefix = "";
  private transientFailures = 0;
  private generation = 0;
  private controller: AbortController | undefined;
  private inFlight = false;
  private blocked = false;
  private closed = false;

  constructor(
    private readonly send: (type: "answer_delta" | "answer_reset", data: AnswerStreamData) => void,
    private readonly render: (body: string, signal: AbortSignal) => Promise<string | undefined>,
  ) {}

  onWatchEvent(event: HarnessEvent | LaneWatchEvent, stream: AnswerStreamMode | undefined): void {
    if (this.closed || !stream) return;
    if (stream.callSeq !== this.stream?.callSeq) {
      this.reset("superseded");
      this.stream = stream;
      this.blocked = false;
    }
    if (event.type === "retry_start") {
      this.retry(stream.callSeq);
      return;
    }
    if (event.type === "tool_start") {
      if (event.toolName !== "analysis_answer") {
        this.reset("tool_call");
        this.blocked = true;
        return;
      }
      // 报告执行已开始，保留已发布段落，但不允许晚到预览覆盖正式回执。
      this.invalidate();
      this.blocked = true;
      return;
    }
    if (stream.mode === "none") {
      this.reset("error");
      this.blocked = true;
      return;
    }
    if (this.blocked) return;
    if (event.type !== "message_update" && event.type !== "message_end") return;
    const message = event.message;
    if (message.role !== "assistant") return;
    if (event.type === "message_end" && ["error", "aborted"].includes(message.stopReason)) {
      this.reset("error");
      this.blocked = true;
      return;
    }
    const calls = message.content.flatMap((block) => (block.type === "toolCall" ? [block] : []));
    // 普通 assistant 文本可能仍是查询计划。仅展示明确的报告正文参数，
    // 自然正文的旧兼容路径继续由正式回执交付，不用词语过滤猜测通道。
    const call = calls[0];
    if (!call || !call.name) return;
    if (calls.length !== 1 || call.name !== "analysis_answer") {
      this.reset("tool_call");
      this.blocked = true;
      return;
    }
    const body = typeof call.arguments.body === "string" ? call.arguments.body : "";
    const prefix = completeAnswerPrefix(body, event.type === "message_end");
    if (!prefix.trim() || prefix === this.pending) return;
    if (
      this.rejectedPrefix &&
      (prefix === this.rejectedPrefix || prefix.startsWith(this.rejectedPrefix + "\n\n"))
    )
      return;
    if (this.pending && !prefix.startsWith(this.pending + "\n\n")) this.reset("superseded");
    this.pending = prefix;
    this.scheduleFlush();
  }

  retry(callSeq: number): void {
    if (this.closed || this.stream?.callSeq !== callSeq) return;
    this.reset("retry");
    this.blocked = false;
  }

  close(): void {
    this.closed = true;
    this.invalidate();
  }

  private invalidate(): void {
    this.generation += 1;
    this.controller?.abort();
    this.pending = this.processed = "";
  }

  private reset(reason: AnswerResetReason): void {
    this.invalidate();
    if (this.stream && this.sent)
      this.send("answer_reset", { call_seq: this.stream.callSeq, reason });
    this.sent = "";
    this.rejectedPrefix = "";
    this.transientFailures = 0;
  }

  private scheduleFlush(): void {
    void this.flush().catch(() => {
      this.close();
      console.warn(
        JSON.stringify({ event: "answer_stream_failed", call_seq: this.stream?.callSeq }),
      );
    });
  }

  private async flush(): Promise<void> {
    if (
      this.closed ||
      this.blocked ||
      this.inFlight ||
      !this.stream ||
      this.stream.mode === "none" ||
      !this.pending ||
      this.pending === this.processed
    )
      return;
    const mode = this.stream.mode;
    const body = this.pending,
      generation = this.generation,
      stream = this.stream;
    const controller = new AbortController();
    this.controller = controller;
    this.inFlight = true;
    this.processed = body;
    try {
      const text = await this.render(body, controller.signal);
      if (this.closed || generation !== this.generation || controller.signal.aborted) return;
      this.transientFailures = 0;
      if (!text?.trim()) {
        // 完整段落已被拒绝，追加后文不能修复它；等待改写或新模型尝试。
        this.rejectedPrefix = body;
        this.processed = this.pending;
      } else if (text !== this.sent) {
        this.send("answer_delta", { call_seq: stream.callSeq, mode, text });
        this.sent = text;
      }
    } catch (error) {
      if (!this.closed && generation === this.generation && !controller.signal.aborted) {
        const temporary =
          !(error instanceof BackendApiError) ||
          error.status >= 500 ||
          [408, 429].includes(error.status) ||
          error.code === "ANALYSIS_RUNNING";
        if (temporary) {
          // 只在下一个完整片段到达时再试一次，不增加定时重试或阻塞正式交付。
          this.transientFailures += 1;
          this.processed = this.pending;
          if (this.transientFailures >= 2) this.blocked = true;
        } else {
          this.reset("error");
          this.blocked = true;
        }
      }
    } finally {
      this.inFlight = false;
      if (this.controller === controller) this.controller = undefined;
      // 等待期间只保留最新累计前缀，避免逐 token 请求或无界队列。
      if (!this.closed && !this.blocked && this.pending !== this.processed) this.scheduleFlush();
    }
  }
}
