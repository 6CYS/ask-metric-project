import {describe, expect, it} from "vitest";
import {projectBusinessToolReceipt, turnArgumentHint} from "../../src/business-context/turnDialect.js";

describe("受控业务协议方言", () => {
  it("关闭时逐字保持服务端说明与回执", () => {
    const hint = "fieldChanges=[]，baseReference=current，executionMode=execute，rawValue";
    const receipt = {message: hint};
    expect(turnArgumentHint(hint, false)).toBe(hint);
    expect(projectBusinessToolReceipt(receipt, false)).toBe(receipt);
  });

  it("纠错重提范围只涉及报错调用，不否定本轮此前已保存的Frame", () => {
    const receipt = {status: "ARGUMENT_ERROR", message: "请修正 time。", focus_preserved: true};
    const projected = projectBusinessToolReceipt(receipt, true) as typeof receipt & {retry_instruction: string};
    expect(projected.retry_instruction).toContain("这次参数校验失败的调用没有应用");
    expect(projected.retry_instruction).toContain("该报错调用承载的本轮全部变化");
    expect(projected.retry_instruction).toContain("同次调用其他有效的 set/remove/clear");
    expect(projected.retry_instruction).not.toContain("本轮各字段变化都尚未保存");
    expect(projected).toEqual(projectBusinessToolReceipt(projected, true));
    expect(receipt).not.toHaveProperty("retry_instruction");
  });

  it("纠错说明给出实际可用的空分组、来源和字段值写法", () => {
    expect(turnArgumentHint("不能直接执行上轮 Frame；fieldChanges=[]，executionMode=execute，baseReference=current。", true))
      .toBe("不能直接执行上轮 Frame；不提交 set/remove/clear/retain，mode=execute，base=current。");
    const hint = turnArgumentHint("capabilityHint；fieldHint；rawValue；未改变则省略或 retain；operation=remove", true);
    expect(hint).toBe("capability；字段名；字段值；未改变则省略或列入 retain 数组；使用 remove 分组");
  });

  it("仅转换完整Frame的Delta、续接和Schema说明，不深入原始值或结果摘要", () => {
    const raw = {baseReference: "原始业务字段", text: "capabilityHint executionMode fieldChanges"};
    const frame = {frameId: "f", executionMode: "execute", fields: {metrics: {rawValue: raw}},
      delta: {capabilityHint: "metric_query", baseReference: null, executionMode: "execute", fieldChanges: [
        {fieldHint: "metrics", operation: "set", rawValue: raw}]},
      continuation: {baseReference: {frameId: "f"}, instruction: "未变化字段省略或 retain"}, resultSummary: raw};
    const receipt = {baseReference: {frameId: "f"}, frame, frames: [{ordinal: 1, frame}], schemas: [{capability: "metric_query",
      fields: {metrics: {description: "operation=remove，rawValue 传值", inputSchema: {enum: ["baseReference"]}}}}]};
    const before = JSON.stringify(receipt);
    const projected = projectBusinessToolReceipt(receipt, true) as typeof receipt & {base: unknown};
    expect(projected).not.toHaveProperty("baseReference");
    expect(projected.base).toEqual({frameId: "f"});
    expect(projected.frame).toMatchObject({mode: "execute", delta: {capability: "metric_query", base: null, mode: "execute", set: {metrics: raw}},
      continuation: {base: {frameId: "f"}, instruction: "未变化字段省略或列入 retain 数组"}, fields: frame.fields, resultSummary: raw});
    expect(projected.frame).not.toHaveProperty("executionMode");
    expect(projected.frame.continuation).not.toHaveProperty("baseReference");
    expect(projected.frames[0]!.frame).toEqual(projected.frame);
    expect(projected.schemas[0]!.fields.metrics).toEqual({description: "使用 remove 分组，字段值 传值", inputSchema: {enum: ["baseReference"]}});
    expect(JSON.stringify(receipt)).toBe(before);
  });

  it("无法无损转换的历史Delta保留，未知结构不猜测", () => {
    const receipt = {frame: {delta: {executionMode: "execute", fieldChanges: [{fieldHint: "time", operation: "set"}]}}, frames: ["opaque"]};
    expect(projectBusinessToolReceipt(receipt, true)).toEqual(receipt);
  });
});
