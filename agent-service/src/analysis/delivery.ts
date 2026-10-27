import {BackendApiError, type BackendClient} from "../backendClient.js";

/** 正常成文与中断交付共用策略；范围、权限和服务异常不降级成文案问题。 */
export async function deliverAnalysisReport(backend: BackendClient, payload: Record<string, unknown>, signal?: AbortSignal) {
  const prepared = {...payload, retain_valid: true};
  try {return await backend.analysisReport(prepared, {signal});}
  catch (error) {
    if (signal?.aborted || payload.fallback || !(error instanceof BackendApiError) || error.status !== 422
      || !["ANALYSIS_REPORT_NUMBER", "ANALYSIS_REPORT_CAUSE", "ANALYSIS_REPORT_DIRECTION",
        "ANALYSIS_REPORT_SUMMARY", "ANALYSIS_REPORT_REFERENCE", "ANALYSIS_REPORT_COVERAGE"].includes(error.code ?? "")) throw error;
    // 兼容仍返回逐段错误的服务端：不再要求模型重复提交，交由同一正式入口保留有效内容。
    return backend.analysisReport({...prepared, fallback: true}, {signal});
  }
}
