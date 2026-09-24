/** 新入口验收语料：所有机构、指标值均为隔离合成数据，不能用于生产事实验证。 */
import type {OrganizationScope, QueryOperation} from "../src/business-context/types.js";

export const metrics = [
  {code: "M1", name: "信贷客户数量当日数", unit: "户"},
  {code: "M2", name: "合成贷款余额", unit: "元"},
  {code: "M3", name: "合成贷款余额排名", unit: "名"},
  {code: "M4", name: "合成收入金额当日数", unit: "元"},
  {code: "M5", name: "合成收入金额较上月增幅", unit: "%"},
  {code: "M6", name: "合成收入金额较同期增幅", unit: "%"},
];
export const organizations = [
  {code: "P0", name: "合成省联社", parent: null, kind: "province"},
  {code: "O1", name: "合成甲农商行", parent: "P0", kind: "rural_commercial_bank"},
  {code: "O2", name: "合成乙农商行", parent: "P0", kind: "rural_commercial_bank"},
  {code: "O3", name: "合成丙农商行", parent: "P0", kind: "rural_commercial_bank"},
  {code: "B1", name: "合成甲一支行", parent: "O1", kind: "branch"},
  {code: "B2", name: "合成甲二支行", parent: "O1", kind: "branch"},
  {code: "B3", name: "合成乙一支行", parent: "O2", kind: "branch"},
  {code: "X1", name: "合成权限外农商行", parent: "P0", kind: "rural_commercial_bank"},
];
export const defaultVisible = ["P0", "O1", "O2", "O3", "B1", "B2", "B3"];
export const cohort: OrganizationScope = {kind: "authorized_cohort", cohort: "rural_commercial_banks"};
export const rank = (top_n = 3, order: "asc" | "desc" = "desc"): QueryOperation => ({kind: "ranking", order, top_n});
export interface Expectation {
  queryCount: 0 | 1;
  status?: "success" | "clarifying";
  metricCodes?: string[];
  orgCodes?: string[];
  scope?: OrganizationScope;
  operation?: QueryOperation;
  time?: {start: string; end: string};
  selection?: "exact" | "latest_in_range" | "all_in_range";
  /** 未知名称不能改成可授权集合，即使后续没有真正执行查询。 */
  noScopeCalls?: boolean;
  issueField?: string;
}
export interface AcceptanceTurn {text: string; expect: Expectation; reopen?: boolean}
export interface AcceptanceCase {id: string; group: string; turns: AcceptanceTurn[]; visible?: string[]}
const date = (end = "2026-04-30", start = end) => ({start, end});
const expected = (extra: Partial<Expectation> = {}): Expectation => ({queryCount: 1, status: "success", metricCodes: ["M1"], scope: cohort,
  operation: rank(), time: date(), selection: "exact", ...extra});
const one = (id: string, group: string, text: string, expect = expected(), visible?: string[]): AcceptanceCase =>
  ({id, group, turns: [{text, expect}], ...(visible ? {visible} : {})});
const noQuery = (extra: Partial<Expectation> = {}): Expectation => ({queryCount: 0, ...extra});
const explicit = (codes = ["O1"], extra: Partial<Expectation> = {}): Expectation => ({queryCount: 1, status: "success", metricCodes: ["M1"],
  orgCodes: codes, operation: {kind: "value"}, time: date(), selection: "exact", noScopeCalls: true, ...extra});
const original = "查询2026年4月末各家农商行信贷客户数量当日数前3名。";
export const cases: AcceptanceCase[] = [
  one("original", "equivalent_scope", original),
  one("authorized", "equivalent_scope", "查询我有权限查看的各家农商行，2026年4月30日信贷客户数量当日数最多的3家。"),
  one("within_access", "equivalent_scope", "在账号可查看的农商行范围内，按2026年4月末信贷客户数量当日数由高到低列出前3家。"),
  one("top_english", "equivalent_scope", "2026-04-30各家农商行的信贷客户数量当日数，取Top 3，数量高的在前。"),
  one("top_chinese", "equivalent_scope", "2026年4月末，各家农商行信贷客户数量当日数最高的三家是哪几家？"),
  one("ascending", "ranking", "查询2026年4月末各家农商行信贷客户数量当日数最低的3家。", expected({operation: rank(3, "asc")})),
  one("top_one", "ranking", "查询2026年4月末各家农商行信贷客户数量当日数最高的1家。", expected({operation: rank(1)})),
  one("top_five", "ranking", "查询2026年4月末各家农商行信贷客户数量当日数前5名。", expected({operation: rank(5)})),
  one("march_end", "date", "查询2026年3月末各家农商行信贷客户数量当日数前3名。", expected({time: date("2026-03-31")})),
  one("leap_day", "date", "查询2024年2月末各家农商行信贷客户数量当日数前3名。", expected({time: date("2024-02-29")})),
  one("year_end", "date", "查询2025年末各家农商行信贷客户数量当日数前3名。", expected({time: date("2025-12-31")})),
  one("explicit_day", "date", "查询2026年4月15日各家农商行信贷客户数量当日数前3名。", expected({time: date("2026-04-15")})),
  one("latest_in_month", "date", "查询各家农商行2026年4月范围内最后一个有数据日期的信贷客户数量当日数前3名。", expected({time: date("2026-04-30", "2026-04-01"), selection: "latest_in_range"})),
  one("scope_value", "value", "查询2026年4月末各家农商行信贷客户数量当日数，全部展示，不排名。", expected({operation: {kind: "value"}})),
  one("explicit_value", "explicit", "查询合成甲农商行2026年4月末信贷客户数量当日数。", explicit()),
  one("explicit_rank_no_children", "explicit", "只查合成甲农商行本级2026年4月末信贷客户数量当日数，按数值降序取前3名，不包含下属机构。", explicit(["O1"], {operation: rank()})),
  one("explicit_two", "explicit", "只查询合成甲农商行和合成乙农商行2026年4月末信贷客户数量当日数。", explicit(["O1", "O2"])),
  one("explicit_two_rank", "explicit", "仅比较合成甲农商行和合成乙农商行2026年4月末信贷客户数量当日数，取数值最高的1家，不含支行。", explicit(["O1", "O2"], {operation: rank(1)})),
  one("branch_explicit", "explicit", "查询合成甲一支行2026年4月末信贷客户数量当日数。", explicit(["B1"])),
  one("province_explicit", "explicit", "查询合成省联社本级2026年4月末信贷客户数量当日数。", explicit(["P0"])),
  one("children_value", "children", "查询合成甲农商行下属支行2026年4月末信贷客户数量当日数。", expected({scope: {kind: "children_of", parent_code: "O1"}, operation: {kind: "value"}})),
  one("children_rank", "children", "查询合成甲农商行下属支行2026年4月末信贷客户数量当日数前3名。", expected({scope: {kind: "children_of", parent_code: "O1"}})),
  one("children_other_parent", "children", "查询合成乙农商行下属支行2026年4月末信贷客户数量当日数前1名。", expected({scope: {kind: "children_of", parent_code: "O2"}, operation: rank(1)})),
  one("metric_name_ranking", "metric", "查询合成甲农商行2026年4月末的指标“合成贷款余额排名”。", explicit(["O1"], {metricCodes: ["M3"]})),
  one("metric_name_plus_operation", "metric", "按2026年4月末“合成贷款余额排名”指标值从低到高，取各家农商行前3家。", expected({metricCodes: ["M3"], operation: rank(3, "asc")})),
  one("multiple_value_metrics", "metric", "查询合成甲农商行2026年4月末的信贷客户数量当日数和合成贷款余额，两个指标都要，不排名。", explicit(["O1"], {metricCodes: ["M1", "M2"]})),
  one("shared_prefix_metrics", "metric", "查询合成甲农商行2026年4月30日合成收入金额当日数和较上月增幅。", explicit(["O1"], {metricCodes: ["M4", "M5"]})),
  one("shared_prefix_four_metrics", "metric", "查询合成甲农商行2026年4月30日合成收入金额当日数、较上月增幅、较同期增幅、合成贷款余额。", explicit(["O1"], {metricCodes: ["M4", "M5", "M6", "M2"]})),
  {id: "shared_prefix_four_confirm", group: "metric", turns: [
    {text: "查询合成甲农商行2026年4月30日合成收入金额当日数、较上月增幅、较同期增幅、合成贷款余。",
      expect: noQuery({status: "clarifying", issueField: "metrics"})},
    {text: "选第一个，请继续刚才的四指标查询。",
      expect: explicit(["O1"], {metricCodes: ["M4", "M5", "M6", "M2"]})},
  ]},
  one("unknown_org", "negative", "查询合成不存在农商行2026年4月末信贷客户数量当日数。", noQuery({status: "clarifying", noScopeCalls: true, issueField: "organizations"})),
  one("unknown_rank_org", "negative", "查询合成不存在农商行2026年4月末信贷客户数量当日数前3名。", noQuery({status: "clarifying", noScopeCalls: true, issueField: "organizations"})),
  one("unknown_parent", "negative", "查询合成不存在农商行下属支行2026年4月末信贷客户数量当日数前3名。", noQuery({status: "clarifying", issueField: "organizations"})),
  one("forbidden_org", "negative", "查询合成权限外农商行2026年4月末信贷客户数量当日数。", noQuery({noScopeCalls: true})),
  one("forbidden_parent", "negative", "查询合成权限外农商行下属支行2026年4月末信贷客户数量当日数。", noQuery()),
  one("missing_date", "negative", "查询各家农商行信贷客户数量当日数前3名，日期尚未确定，请先问我日期。", noQuery({status: "clarifying", issueField: "time"})),
  one("missing_metric", "negative", "查询2026年4月末各家农商行前3名，具体按哪个指标排序尚未确定。", noQuery({status: "clarifying", issueField: "metrics"})),
  one("multiple_metrics_rank_ambiguous", "negative", "查询2026年4月末各家农商行信贷客户数量当日数和合成贷款余额前3名，尚未确定用哪个指标排名，请先确认。", noQuery()),
  one("daily_ranking_unsupported", "negative", "查询2026年4月每天各家农商行信贷客户数量当日数前3名，必须逐日排名，不能只取月末或最后有值日。", noQuery()),
  one("restricted_cohort", "permission", original, expected(), ["O2", "B3"]),
  one("empty_cohort", "permission", original, noQuery(), ["P0", "B1"]),
  {id: "cancel_ranking", group: "multiturn", turns: [{text: original, expect: expected()}, {text: "取消排名，其他条件不变，展示全部。", expect: expected({operation: {kind: "value"}})}]},
  {id: "change_topn", group: "multiturn", turns: [{text: original, expect: expected()}, {text: "改成前2名，其他条件不变。", expect: expected({operation: rank(2)})}]},
  {id: "change_order", group: "multiturn", turns: [{text: original, expect: expected()}, {text: "改查最低的2家，其他条件不变。", expect: expected({operation: rank(2, "asc")})}]},
  {id: "change_date_keep_rank", group: "multiturn", turns: [{text: original, expect: expected()}, {text: "改查2026年5月末，其他条件不变。", expect: expected({time: date("2026-05-31")})}]},
  {id: "reopen_keep_scope", group: "multiturn", turns: [{text: original, expect: expected()}, {text: "改成前2名，其他条件不变。", reopen: true, expect: expected({operation: rank(2)})}]},
  {id: "scope_to_explicit", group: "multiturn", turns: [{text: original, expect: expected()}, {text: "取消排名，只查询合成甲农商行本级，其他条件不变。", expect: explicit()}]},
  {id: "explicit_to_scope", group: "multiturn", turns: [{text: "查询合成甲农商行2026年4月末信贷客户数量当日数。", expect: explicit()}, {text: "改成账号权限内各家农商行的前3名，其他条件不变。", expect: expected()}]},
];
