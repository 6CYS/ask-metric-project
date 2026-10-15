import type {ResolvedField} from "../business-context/types.js";

/** 给Pi与页面显示当前完整身份；rawValue是动作原文，add/exclude后不能代表最终集合。 */
export function semanticDisplay(field: ResolvedField | undefined): string {
  const names = (field?.resolvedValue as {names?: unknown} | undefined)?.names;
  if (field?.resolutionStatus === "resolved" && Array.isArray(names) && names.every(name => typeof name === "string")) return names.join("、");
  return typeof field?.rawValue === "string" ? field.rawValue : field?.rawValue === undefined ? "" : JSON.stringify(field.rawValue);
}
