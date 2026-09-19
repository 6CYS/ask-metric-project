import type { AssistantMessage } from "@earendil-works/pi-ai";

/** pi 的 input 不含缓存；统一为供应商 prompt_tokens 口径。全零可能是缺失用量。 */
export function modelUsage(usage: AssistantMessage["usage"]) {
  const valid = [usage?.input, usage?.output, usage?.cacheRead, usage?.cacheWrite, usage?.totalTokens]
    .every(value => Number.isSafeInteger(value) && value >= 0);
  const known = valid && usage.totalTokens > 0 && usage.input + usage.cacheRead + usage.cacheWrite > 0;
  return {
    usage_known: known,
    input_tokens: known ? usage.input + usage.cacheRead + usage.cacheWrite : null,
    output_tokens: known ? usage.output : null,
    cache_read_tokens: known ? usage.cacheRead : null,
    cache_write_tokens: known ? usage.cacheWrite : null,
    total_tokens: known ? usage.totalTokens : null,
  };
}
