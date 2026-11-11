import type { HarnessEvent, LaneWatchEvent } from "@earendil-works/pi-agent-core";
import { BackendApiError } from "./backendClient.js";
import type { AskMetricRequestContext } from "./requestContext.js";
import { normalizeReportParagraphs } from "./analysis/narrative.js";
import { completeSentenceBoundary } from "./answerSentenceBoundary.js";
import type { BusinessReportChart } from "./analysis/reportCharts.js";

export type AnswerStreamMode = NonNullable<AskMetricRequestContext["answerStream"]>;
export type AnswerResetReason = "tool_call" | "retry" | "error" | "superseded";
export type AnswerStreamPreview = string | { text: string; charts?: BusinessReportChart[] };
export type AnswerStreamData =
  | { call_seq: number; mode: "text" | "reply"; text: string; charts?: BusinessReportChart[] }
  | { call_seq: number; reason: AnswerResetReason };

/** 普通正文可按完整句子交付；Markdown 块仍等待空行或同级列表下一项。 */
export function completeAnswerPrefix(source: string, ended: boolean): string {
  const text = normalizeReportParagraphs(source);
  let fence: { character: string; length: number } | undefined;
  let listIndent: number | undefined;
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
    } else if (!fence) {
      if (!line.trim() && index < lines.length - 1) {
        boundary = offset;
        listIndent = undefined;
      } else {
        const item = /^( {0,3})(?:[-+*]|\d{1,9}[.)])[ \t]+\S/u.exec(line);
        if (item) {
          const indent = item[1]!.length;
          // 下一同级项确认前项结束；子列表和普通续行不提前截断父项。
          if (listIndent !== undefined && indent <= listIndent) boundary = offset;
          listIndent = Math.min(listIndent ?? indent, indent);
        }
      }
    }
    offset += line.length + 1;
  }
  if (!ended && !fence && listIndent === undefined) {
    const start = boundary;
    const tail = text.slice(start);
    // 块类型检测忽略引用内的协议分隔符；句界扫描仍读取原文中的完整引用。
    const structure = tail.replace(/\{\{[^{}]+\}\}/gu, "").replace(/\{\{[^{}]*$/u, "");
    if (!/^(?: {4}|\t| {0,3}(?:#{1,6}(?:[ \t]|$)|>|(?:=+|-+)[ \t]*$))|\|/mu.test(structure)) {
      boundary = start + completeSentenceBoundary(tail);
    }
  }
  const prefix = text.slice(0, ended && !fence ? text.length : boundary).trimEnd();
  return prefix.lastIndexOf("{{") > prefix.lastIndexOf("}}") ? "" : prefix;
}

/** 只读观察投影：完整片段经正式报告的同源核验后才发布，最终快照覆盖临时正文。 */
export class AnswerStreamProjector {
  private stream: AnswerStreamMode | undefined;
  private source = "";
  private pending = "";
  private processed = "";
  private sent = "";
  private sentCharts: string | undefined;
  private rejectedPrefix = "";
  private transientFailures = 0;
  private generation = 0;
  private draftRevision = 0;
  private controller: AbortController | undefined;
  private inFlight = false;
  private blocked = false;
  private closed = false;

  constructor(
    private readonly send: (type: "answer_delta" | "answer_reset", data: AnswerStreamData) => void,
    private readonly render: (
      body: string,
      signal: AbortSignal,
    ) => Promise<AnswerStreamPreview | null | undefined>,
    private readonly compileDraft?: (
      arguments_: Record<string, unknown>,
      ended: boolean,
    ) => Promise<string | undefined>,
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
    const ended = event.type === "message_end";
    const revision = ++this.draftRevision,
      generation = this.generation;
    if (call.arguments.report !== undefined && this.compileDraft) {
      void this.compileDraft(structuredClone(call.arguments), ended)
        .then((compiled) => {
          if (
            this.closed ||
            this.blocked ||
            this.generation !== generation ||
            this.draftRevision !== revision ||
            compiled === undefined
          )
            return;
          this.acceptBody(compiled, ended);
        })
        .catch(() => {
          // 不完整结构等待下一片段；正式调用仍返回具体格式错误，不绕过校验。
        });
      return;
    }
    this.acceptBody(body, ended);
  }

  private acceptBody(body: string, ended: boolean): void {
    const prefix = completeAnswerPrefix(body, ended);
    if (
      this.pending &&
      !prefix.startsWith(this.pending) &&
      (!this.pending.startsWith(prefix) || !body.startsWith(this.source))
    )
      this.reset("superseded");
    this.source = body;
    // 原文仅追加时，后续 Markdown 可能让候选边界退回；已核验前文仍有效。
    if (!prefix.trim() || this.pending.startsWith(prefix)) return;
    if (
      this.rejectedPrefix &&
      (prefix === this.rejectedPrefix || prefix.startsWith(this.rejectedPrefix + "\n\n"))
    )
      return;
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
    this.source = this.pending = this.processed = "";
  }

  private reset(reason: AnswerResetReason): void {
    this.invalidate();
    if (this.stream && this.sent)
      this.send("answer_reset", { call_seq: this.stream.callSeq, reason });
    this.sent = "";
    this.sentCharts = undefined;
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
      const preview = await this.render(body, controller.signal);
      if (this.closed || generation !== this.generation || controller.signal.aborted) return;
      this.transientFailures = 0;
      // 历史回答的标题可能先于引用到达；等待依据，不把未完整的前缀永久判错。
      if (preview === null) return;
      const text = typeof preview === "string" ? preview : preview?.text;
      const charts = typeof preview === "object" ? preview.charts : undefined;
      const chartIdentity = charts === undefined ? this.sentCharts : JSON.stringify(charts);
      if (!text?.trim()) {
        // 后续段落不能修复已拒绝的段落；同段补齐依据后仍需核验累计正文。
        this.rejectedPrefix = body;
        if (this.pending === body || this.pending.startsWith(body + "\n\n"))
          this.processed = this.pending;
      } else if (text !== this.sent || chartIdentity !== this.sentCharts) {
        this.send("answer_delta", {
          call_seq: stream.callSeq,
          mode,
          text,
          ...(charts === undefined ? {} : { charts }),
        });
        this.sent = text;
        this.sentCharts = chartIdentity;
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
