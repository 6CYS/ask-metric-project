import type {OrganizationScopeInput} from "./types.js";

/** 只选择范围解析入口，原表达完整交后端核验；不能截取量词后丢掉排除或地域限定。 */
export function organizationScopeInput(raw: unknown): OrganizationScopeInput | undefined {
  if (raw && typeof raw === "object" && !Array.isArray(raw) && "kind" in raw)
    return raw as OrganizationScopeInput;
  if (typeof raw !== "string") return;
  const text = raw.normalize("NFKC").trim();
  if (/下辖|下属/u.test(text)) {
    const parentName = text.split(/(?:的)?(?:下辖|下属)/u)[0]?.replace(/^(?:查询|查看|分析|查)/u, "").trim();
    return {kind: "children_of", parentName: parentName ?? "", sourceText: raw};
  }
  if (/(?:各家|各个|所有|全部|每家|每个|全省|省内|权限|可查看|能查看|可见)|^各/u.test(text)
    && /农商|农村商业银行|银行|各行/u.test(text))
    return {kind: "authorized_cohort", cohort: "rural_commercial_banks", sourceText: raw};
}
