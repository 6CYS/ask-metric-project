import { BackendApiError, type BackendClient } from "./backendClient.js";
import { validateTopicRegistry, type TopicRegistry } from "./inquiry/topics/registry.js";

export interface InquiryTopicSnapshot { version_id: string; registry: TopicRegistry }

export async function databaseInquiryTopicSnapshot(backend: BackendClient, versionId?: string): Promise<InquiryTopicSnapshot> {
  const response = await backend.inquiryTopicSnapshot(versionId);
  if (!response || typeof response !== "object" || Array.isArray(response) ||
    !("version_id" in response) || typeof response.version_id !== "string" || !response.version_id ||
    (versionId && versionId !== response.version_id) || !("document" in response))
    throw new BackendApiError(503, "主题配置响应无效", "TOPIC_CONFIG_INVALID");
  try { return { version_id: response.version_id, registry: validateTopicRegistry(response.document) }; }
  catch { throw new BackendApiError(503, "主题配置引用或预算无效", "TOPIC_CONFIG_INVALID"); }
}
