import { describe, expect, it } from "vitest";
import { buildCompositionPieChart } from "../src/analysis/overviewCharts.js";

// 隔离事实只核对已确认组成关系的数值交付，不进入实际问数。
function fixture() {
  return {
    title: "各项存款结构",
    date: "2026-08-27",
    unit: "元",
    total: { ref: "r.total", value: "100" },
    parts: [
      { ref: "r.personal", name: "个人存款", value: "75", display: "75元" },
      { ref: "r.company", name: "对公存款", value: "25", display: "25元" },
    ],
  };
}

describe("已确认完整组成的饼图", () => {
  it("按正式总量计算75/25占比，保留原值、展示值和所有来源", () => {
    const input = fixture(),
      before = structuredClone(input);
    expect(buildCompositionPieChart(input)).toEqual({
      charts: [
        {
          type: "pie",
          title: "各项存款结构",
          date: "2026-08-27",
          unit: "元",
          source_refs: ["r.total", "r.personal", "r.company"],
          points: [
            { name: "个人存款", value: "75", display: "75元", share: "75.00%" },
            { name: "对公存款", value: "25", display: "25元", share: "25.00%" },
          ],
        },
      ],
    });
    expect(input).toEqual(before);
  });

  it("占比按父项总量计算，不将容差内缺口静默归一到分项合计", () => {
    const input = fixture();
    input.parts[1]!.value = "24";
    input.parts[1]!.display = "24元";
    expect(
      buildCompositionPieChart({ ...input, tolerance: "1" }).charts[0]?.points.map(
        (point) => point.share,
      ),
    ).toEqual(["75.00%", "24.00%"]);
    expect(buildCompositionPieChart(input).charts).toEqual([]);
  });

  it("百分比精确四舍五入至两位，不依赖浮点舍入", () => {
    const input = fixture();
    input.total.value = "32";
    input.parts[0]!.value = "1";
    input.parts[0]!.display = "1元";
    input.parts[1]!.value = "31";
    input.parts[1]!.display = "31元";
    expect(buildCompositionPieChart(input).charts[0]?.points.map((point) => point.share)).toEqual([
      "3.13%",
      "96.88%",
    ]);
  });

  it.each([
    ["9007199254740993.0000000000", true],
    ["9007199254740993.0000000001", false],
  ] as const)("精确核对大额%s与1元容差", (value, accepted) => {
    const input = fixture();
    input.total.value = "9007199254741092";
    input.parts[0]!.value = value;
    input.parts[0]!.display = `${value}元`;
    input.parts[1]!.value = "100";
    input.parts[1]!.display = "100元";
    const result = buildCompositionPieChart({ ...input, tolerance: "1", toleranceUnit: "元" });
    expect(result.charts).toHaveLength(accepted ? 1 : 0);
    if (accepted)
      expect(result.charts[0]?.points[0]).toEqual({
        name: "个人存款",
        value,
        display: `${value}元`,
        share: "100.00%",
      });
    else expect(result.notice).toMatch(/合计|总额/u);
  });

  it.each([
    ["75.0001", true],
    ["75.00010000001", false],
  ] as const)("万元数据按1元容差核对%s", (value, accepted) => {
    const input = fixture();
    input.unit = "万元";
    input.parts[0]!.value = value;
    input.parts[0]!.display = `${value}万元`;
    input.parts[1]!.display = "25万元";
    expect(
      buildCompositionPieChart({ ...input, tolerance: "1", toleranceUnit: "元" }).charts,
    ).toHaveLength(accepted ? 1 : 0);
  });

  it("同单位户数使用原始精度核对，不需要货币换算", () => {
    const input = fixture();
    input.unit = "户";
    input.parts[0]!.display = "75户";
    input.parts[1]!.display = "25户";
    expect(buildCompositionPieChart(input).charts[0]).toMatchObject({
      unit: "户",
      points: [
        { value: "75", display: "75户", share: "75.00%" },
        { value: "25", display: "25户", share: "25.00%" },
      ],
    });
  });

  it("合法零分项仍保留，父项不成为扇区", () => {
    const input = fixture();
    input.parts[0]!.value = "100.0000";
    input.parts[0]!.display = "100元";
    input.parts[1]!.value = "0";
    input.parts[1]!.display = "0元";
    expect(buildCompositionPieChart(input).charts[0]?.points).toEqual([
      { name: "个人存款", value: "100.0000", display: "100元", share: "100.00%" },
      { name: "对公存款", value: "0", display: "0元", share: "0.00%" },
    ]);
  });

  it.each(["-1", "-0", "NaN", "Infinity", "1e10000", ""])("无效分项%s不生成图表", (value) => {
    const input = fixture();
    input.parts[0]!.value = value;
    const result = buildCompositionPieChart(input);
    expect(result.charts).toEqual([]);
    expect(result.notice).toBeTypeOf("string");
  });

  it.each(["0", "-1", "NaN", "Infinity"])("无效父项%s不生成图表", (value) => {
    const input = fixture();
    input.total.value = value;
    const result = buildCompositionPieChart(input);
    expect(result.charts).toEqual([]);
    expect(result.notice).toBeTypeOf("string");
  });

  it("全部分项为零时即使落在容差内也不生成空图", () => {
    const input = fixture();
    input.parts.forEach((part) => {
      part.value = "0";
    });
    expect(buildCompositionPieChart({ ...input, tolerance: "100" }).charts).toEqual([]);
  });

  it.each([0, 1, 20, 21])("%s个完整分项按展示边界处理，不截取或补零", (count) => {
    const input = fixture();
    input.total.value = String(count);
    input.parts = Array.from({ length: count }, (_, index) => ({
      ref: `r.part${index}`,
      name: `分类${index}`,
      value: "1",
      display: "1元",
    }));
    const result = buildCompositionPieChart(input);
    expect(result.charts).toHaveLength(count === 20 ? 1 : 0);
    if (count === 20) expect(result.charts[0]?.points).toHaveLength(20);
  });

  it.each(["ref", "name", "total_ref", "empty_ref", "empty_name", "empty_display"])(
    "%s冲突或缺失时拒绝",
    (mode) => {
      const input = fixture();
      if (mode === "ref") input.parts[1]!.ref = input.parts[0]!.ref;
      if (mode === "name") input.parts[1]!.name = input.parts[0]!.name;
      if (mode === "total_ref") input.parts[1]!.ref = input.total.ref;
      if (mode === "empty_ref") input.parts[1]!.ref = "";
      if (mode === "empty_name") input.parts[1]!.name = "";
      if (mode === "empty_display") input.parts[1]!.display = "";
      expect(buildCompositionPieChart(input).charts).toEqual([]);
    },
  );

  it("百分比单位与无法换算的容差单位不能当作可加总组成", () => {
    expect(buildCompositionPieChart({ ...fixture(), unit: "%" }).charts).toEqual([]);
    expect(buildCompositionPieChart({ ...fixture(), toleranceUnit: "户" }).charts).toEqual([]);
    expect(buildCompositionPieChart({ ...fixture(), tolerance: "-1" }).charts).toEqual([]);
  });

  it("容差不能放行超出100%的分项", () => {
    const input = fixture();
    input.parts[0]!.value = "101";
    input.parts[1]!.value = "0";
    expect(buildCompositionPieChart({ ...input, tolerance: "1" }).charts).toEqual([]);
  });
});
