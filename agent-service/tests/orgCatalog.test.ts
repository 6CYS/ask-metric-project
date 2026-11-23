import { describe, expect, it, vi } from "vitest";
import { orgCatalog } from "../src/business-context/orgCatalog.js";
import type { AskMetricRequestContext } from "../src/requestContext.js";

describe("机构目录请求", () => {
  it("把当前请求的取消信号传给后端", async () => {
    const signal = new AbortController().signal;
    const backend = {
      orgCatalog: vi.fn((options?: { signal?: AbortSignal }) => {
        void options;
        return Promise.resolve({ items: [] });
      }),
    };
    const request = {
      backend,
      requestId: "request-1",
      sessionId: "session-1",
      operationId: "operation-1",
    } as unknown as AskMetricRequestContext;
    await orgCatalog(request, signal);

    expect(backend.orgCatalog).toHaveBeenCalledWith({ signal });
  });
});
