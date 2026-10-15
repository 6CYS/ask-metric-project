import type {AskMetricRequestContext} from "../requestContext.js";
import {availableReferences} from "./contextMemory.js";

/** 只识别用户明确的业务查询序号，不从机构数量、日期或最近N轮推断身份。 */
export function referencedQueryNumbers(question: string): number[] {
  const digits: Record<string, number> = {零:0,〇:0,一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};
  const values = [...question.matchAll(/第([零〇一二两三四五六七八九十百\d]+)次(?:业务)?查询/gu)].map(match => {
    const text=match[1]!; if (/^\d+$/u.test(text)) return Number(text);
    let value=0,digit=0;
    for(const char of text){if(char==="十"||char==="百"){value+=(digit||1)*(char==="十"?10:100);digit=0;}else digit=digits[char]??NaN;}
    return value+digit;
  });
  return [...new Set(values.filter(value=>Number.isSafeInteger(value)&&value>0))];
}

/** 序号来自用户，引用身份来自原生账本，条件发送前仍检查当前权限。 */
export async function requestedHistory(request: AskMetricRequestContext) {
  const ordinals=referencedQueryNumbers(request.originalMessage);
  if(!ordinals.length)return [];
  const rows=(await request.semanticTasks!.historyCatalog()).filter(row=>ordinals.includes(row.query_number));
  return availableReferences(request,rows);
}
