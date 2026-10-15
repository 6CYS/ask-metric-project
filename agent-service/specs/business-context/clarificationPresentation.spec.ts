import {expect, it} from "vitest";
import {renderFrameClarification} from "../../src/business-context/clarificationPresentation.js";
import type {BusinessFrame} from "../../src/business-context/types.js";

const frame: BusinessFrame = {frameId: "f", operationFrameId: "f", sessionId: "s", turnId: "t", requestId: "r",
  capability: "metric_query", createdAt: "2026-10-13", status: "clarifying", fields: {},
  delta: {executionMode: "execute", fieldChanges: []}, issues: []};

it("混合提案同时展示已保存候选和没有候选的新增项", () => {
  const text = renderFrameClarification({...frame, fields: {organizations: {
    resolutionStatus: "needs_confirmation", source: "explicit",
    candidates: [{value: "合成机构乙全称", code: "B", metadata: {rawValueIndex: 1}}],
    metadata: {extractedRawValues: ["A", "合成简称乙", "未知机构丙"], referenceAdditionIssues: [
      {index: 1, raw: "合成简称乙", status: "needs_confirmation"}, {index: 2, raw: "未知机构丙", status: "not_found"},
    ]},
  }}, issues: [{field: "organizations", reason: "needs_confirmation"}]});
  expect(text).toContain("1. 合成机构乙全称");
  expect(text).toContain("新增机构「未知机构丙」尚未确定");
  expect(text).not.toContain("新增机构「合成简称乙」尚未确定");
});

it("没有候选时只询问未决字段，不从原文编造确认名单", () => {
  const text = renderFrameClarification({...frame, fields: {organizations: {
    rawValue: "以上三家", resolutionStatus: "not_found", source: "explicit", candidates: [],
  }}, issues: [{field: "organizations", reason: "not_found"}]});
  expect(text).toBe("尚未确定机构，请提供具体的机构。");
  expect(text).not.toContain("请确认");
});

it("引用数量或来源冲突采用保存的诊断，不展示内部Frame引用", () => {
  const text = renderFrameClarification({...frame, fields: {organizations: {
    resolutionStatus: "not_found", source: "explicit",
    metadata: {referenceIssue: {code: "HISTORY_REFERENCE_COUNT_MISMATCH", message: "所选来源合并后共有3家，与要求的4家不一致，请明确来源。"}},
  }}, issues: [{field: "organizations", reason: "not_found"}]});
  expect(text).toBe("机构：所选来源合并后共有3家，与要求的4家不一致，请明确来源。");
  expect(text).not.toContain("HISTORY_REFERENCE_COUNT_MISMATCH");
});

it("保留原Frame时同时交付受控恢复原因和原候选，不用旧问题遮蔽来源故障", () => {
  const pending = {...frame, fields: {organizations: {resolutionStatus: "needs_confirmation" as const, source: "explicit" as const,
    candidates: [{code: "A", value: "合成机构甲"}]}}, issues: [{field: "organizations", reason: "needs_confirmation" as const}]};
  const before = JSON.stringify(pending);
  const message = "所选历史操作尚未完成，请确认可用的来源后再继续。";
  const text = renderFrameClarification(pending, message);
  expect(text.startsWith(message)).toBe(true);
  expect(text).toContain("1. 合成机构甲");
  expect(JSON.stringify(pending)).toBe(before);
});
