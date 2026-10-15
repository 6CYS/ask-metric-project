import {describe, expect, it} from "vitest";
import {getResolutionFailureDisposition, isTerminalResolutionFailure} from "../../src/business-context/resolutionFailure.js";

const codes = ["EMPTY_AUTHORIZED_SCOPE", "UNSUPPORTED_QUERY_COMBINATION", "UNSUPPORTED_ORGANIZATION_SCOPE"];

describe("确定解析错误的闭集分级", () => {
  it.each(codes)("%s 明确停止本轮且不改变用户目标", code => {
    const disposition = getResolutionFailureDisposition(code)!;
    expect(disposition.retryable).toBe(false);
    expect(disposition.message).toMatch(/没有当前账号可查看的机构|不支持/);
    expect(disposition.message).not.toContain("重试");
    expect(disposition.instruction).toContain("保持用户原始目标");
    expect(disposition.instruction).toContain("结束本轮");
    expect(disposition.instruction).toContain("不得自动重试、改写字段或切换业务能力绕过限制");
    expect(disposition.instruction).toContain("不得自行缩小或扩大机构范围");
    expect(Object.isFrozen(disposition)).toBe(true);
  });

  it.each(["TEMPORARY_ERROR", "BACKEND_503", "FIELD_INPUT_SCHEMA_INVALID", "METRIC_MENTION_NOT_FOUND",
    "UNKNOWN_ERROR", "toString", "constructor", "__proto__", "empty_authorized_scope", "EMPTY_AUTHORIZED_SCOPE ",
    null, undefined, 422, {code: "EMPTY_AUTHORIZED_SCOPE"}])("未知或可纠错输入不分级：%j", code => {
    expect(getResolutionFailureDisposition(code)).toBeUndefined();
  });

  it.each(codes)("原生 details 的三个明确标记均成立才识别 %s", error_code => {
    const details = {kind: "business_context", status: "error", error_code, retryable: false,
      message: "原生说明，不通过文案推断"};
    const before = structuredClone(details);
    expect(isTerminalResolutionFailure(details)).toBe(true);
    expect(details).toEqual(before);
    expect(isTerminalResolutionFailure(Object.assign(Object.create(null), details))).toBe(true);
  });

  it.each([
    null, undefined, [], "EMPTY_AUTHORIZED_SCOPE",
    {status: "error", error_code: "EMPTY_AUTHORIZED_SCOPE"},
    {status: "error", error_code: "EMPTY_AUTHORIZED_SCOPE", retryable: true},
    {status: "error", error_code: "EMPTY_AUTHORIZED_SCOPE", retryable: "false"},
    {status: "error", error_code: "EMPTY_AUTHORIZED_SCOPE", retryable: null},
    {status: "ARGUMENT_ERROR", error_code: "EMPTY_AUTHORIZED_SCOPE", retryable: false},
    {status: "TEMPORARY_ERROR", error_code: "EMPTY_AUTHORIZED_SCOPE", retryable: false},
    {status: "succeeded", error_code: "EMPTY_AUTHORIZED_SCOPE", retryable: false},
    {status: "error", error_code: "TEMPORARY_ERROR", retryable: false},
    {status: "error", error_code: "UNKNOWN_ERROR", retryable: false},
    {status: "error", code: "EMPTY_AUTHORIZED_SCOPE", retryable: false},
    {status: "error", retryable: false, message: "EMPTY_AUTHORIZED_SCOPE，不能重试"},
    {details: {status: "error", error_code: "EMPTY_AUTHORIZED_SCOPE", retryable: false}},
    Object.create({status: "error", error_code: "EMPTY_AUTHORIZED_SCOPE", retryable: false}),
  ])("不从不完整标记、其他状态或文案猜测终止：%j", details => {
    expect(isTerminalResolutionFailure(details)).toBe(false);
  });
});
