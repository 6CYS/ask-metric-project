import {describe, expect, it} from "vitest";
import type {Entry} from "@earendil-works/pi-agent-core";
import {projectEntries} from "../src/sessionProjection.js";

let sequence = 0;
const entry = (message: Record<string, unknown>): Entry => ({type: "message", id: `clarification-${++sequence}`, seq: sequence,
  timestamp: sequence, message: {timestamp: sequence, ...message}}) as unknown as Entry;
const user = () => entry({role: "user", content: "查询合成机构", businessProtocol: "frame_v1"});
const receipt = (extra: Record<string, unknown> = {}, isError = false) => entry({role: "toolResult", toolName: "resolve_business_turn",
  toolCallId: "resolve", isError, content: [{type: "text", text: '{"status":"NEEDS_CLARIFICATION"}'}],
  details: {kind: "business_context", status: "NEEDS_CLARIFICATION", frame_id: "saved-frame", retryable: false,
    delivery: "frame_clarification_v1", public_answer: "请补充日期。", ...extra}});

describe("保存状态生成的澄清正文投影", () => {
  it("工具回执即结束本轮，快照与重连仍显示正式澄清正文", () => {
    const entries = [user(), receipt()];
    expect(projectEntries(entries).at(-1)).toMatchObject({role: "assistant", text: "请补充日期。", business_protocol: "frame_v1"});
    expect(projectEntries(structuredClone(entries))).toEqual(projectEntries(entries));
  });

  it("旧记录后续真实助手正文替换回执正文，不重复展示", () => {
    const projected = projectEntries([user(), receipt(), entry({role: "assistant", stopReason: "stop", content: [{type: "text", text: "请补充日期。"}]})]);
    expect(projected.filter(message => message.role === "assistant" && message.text)).toHaveLength(1);
  });

  it("真实模型失败仍是失败，不能由澄清回执掩盖", () => {
    const projected = projectEntries([user(), receipt(), entry({role: "assistant", stopReason: "error", errorMessage: "MODEL_TOOL_PROTOCOL_ERROR", content: []})]);
    expect(projected.at(-1)).toMatchObject({role: "assistant", error: expect.any(String)});
    expect(projected.filter(message => message.role === "assistant" && message.text === "请补充日期。")).toEqual([]);
  });

  it.each([{delivery: undefined}, {status: "ARGUMENT_ERROR"}, {kind: "other"}])("非正式交付标记不把工具文字当作回答：%j", extra => {
    expect(projectEntries([user(), receipt(extra)]).filter(message => message.role === "assistant")).toEqual([]);
  });

  it("错误回执不投影成成功交付", () => {
    expect(projectEntries([user(), receipt({}, true)]).filter(message => message.role === "assistant")).toEqual([]);
  });
});

it("显式取消刷新后仍显示停止，实际模型故障保留失败状态",()=>{
 const stopped=projectEntries([user(),entry({role:"assistant",stopReason:"aborted",errorMessage:"模型请求已取消",content:[]})]).at(-1);
 expect(stopped).toMatchObject({text:"已停止生成。"});expect(stopped).not.toHaveProperty("error");
 const failed=projectEntries([user(),entry({role:"assistant",stopReason:"error",errorMessage:"MODEL_FIRST_RESPONSE_TIMEOUT: timeout",content:[]})]).at(-1);
 expect(failed).toHaveProperty("error");expect(failed && "text" in failed ? failed.text : undefined).not.toBe("已停止生成。");
});
