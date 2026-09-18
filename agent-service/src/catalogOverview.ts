import { Type, StringEnum } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { BackendClient } from "./backendClient.js";

const parameters = Type.Object({
  catalog: StringEnum(["metrics", "organizations"], { description: "指标目录或当前账号可查询的机构目录" }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, default: 8 })),
});

export interface CatalogOverview {
  catalog: "metrics" | "organizations";
  total: number;
  examples: Array<{ name: string; unit?: string | null }>;
  examples_only: boolean;
  data_availability: string;
}

export function createCatalogOverviewTool(client: BackendClient): AgentTool<typeof parameters> {
  return {
    name: "catalog_overview", label: "查看目录概览",
    description: "介绍能查询哪些指标、有哪些机构时使用，一次返回目录数量及有限示例。具体名称匹配用目录检索工具，实际取数用查询工具。示例不是全部目录，不代表指定日期有数据。",
    parameters,
    execute: async (_id, params) => {
      const overview = await client.catalogOverview(params.catalog as "metrics" | "organizations", params.limit ?? 8);
      return { content: [{ type: "text", text: JSON.stringify(overview) }],
        details: { kind: "catalog_overview", status: "succeeded", ...overview } };
    },
  };
}
