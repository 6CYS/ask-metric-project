import {SemanticConflict} from "./service.js";

const invalid = (message: string): never => {throw new SemanticConflict({code: "CALCULATION_NOT_DETERMINED", category: "semantic", field: "calculation", message, remediation: "pi"});};
export interface Formula {expression: string; labels: string[]; display: "decimal" | "percent"; constants: Record<string, {value: string; source_text: string}>}
/** 只解释算式结构，业务来源使用普通步骤名称；数值与事实ID始终由宿主从正式结果绑定。 */
export function parseFormula(text: string, available: string[], userQuestion = ""): Formula {
  const percent = /^\s*percent\((.*)\)\s*$/su.exec(text);
  if (percent) text = percent[1]!;
  const constants: Formula["constants"] = {};
  const labels: string[] = [], tokens: string[] = [];
  const pattern = /\s+|`([^`]+)`|[“"]([^”"]+)[”"]|(?:sum|avg|min|max|abs)\b|[()+*/,-]|\d+(?:\.\d+)?/gy;
  let position = 0;
  while (position < text.length) {
    pattern.lastIndex = position;
    const match = pattern.exec(text);
    if (!match) invalid("算式使用步骤名称的引号引用、四则运算或sum/avg/min/max/abs；业务数值不能手工填入。");
    position = pattern.lastIndex;
    if (!match![0].trim()) continue;
    const label = match![1] ?? match![2];
    if (label) {
      if (available.filter(name => name === label).length !== 1) invalid(`计算来源“${label}”没有唯一对应的任务步骤，请明确步骤名称。`);
      if (!labels.includes(label)) labels.push(label);
      tokens.push(`v${labels.indexOf(label)}`);
    } else if (/^\d/u.test(match![0]) && !["0", "1"].includes(match![0])) {
      const value = match![0];
      const escaped = value.replace(/\./gu, "\\.");
      const source = new RegExp(`(?<![\\d.])${escaped}(?![\\d.])`, "u").exec(userQuestion);
      if (!source) invalid("算式中的业务常量必须由当前用户原句明确提供，不能补造数值。");
      const name = `c${Object.keys(constants).length}`; constants[name] = {value, source_text: source![0]}; tokens.push(name);
    } else tokens.push(match![0]);
  }
  let at = 0;
  const expression = (): void => {term(); while (["+", "-"].includes(tokens[at] ?? "")) {at++; term();}};
  const term = (): void => {factor(); while (["*", "/"].includes(tokens[at] ?? "")) {at++; factor();}};
  const factor = (): void => {
    const token = tokens[at++];
    if (token === "+" || token === "-") return factor();
    if (token === "(") {expression(); if (tokens[at++] !== ")") invalid("计算括号不完整。"); return;}
    if (/^(sum|avg|min|max|abs)$/u.test(token ?? "")) {
      if (tokens[at++] !== "(") invalid("聚合函数需要括号。");
      expression(); let count = 1;
      while (tokens[at] === ",") {at++; expression(); count++;}
      if (tokens[at++] !== ")" || token === "abs" && count !== 1) invalid("计算函数参数不完整。"); return;
    }
    if (!/^(v\d+|c\d+|0|1)$/u.test(token ?? "")) invalid("计算操作数不完整。");
  };
  expression();
  if (at !== tokens.length || !labels.length) invalid("计算必须明确引用正式查询步骤，不能提交孤立常量或不完整算式。");
  if (tokens.join(" ").length > 2000 || Object.keys(constants).length > 20) invalid("计算表达式超出当前受控容量，请拆分计算步骤。");
  return {expression: tokens.join(" "), labels, display: percent ? "percent" : "decimal", constants};
}
