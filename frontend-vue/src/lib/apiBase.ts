// 生产部署的接口前缀同时适用于 Python 与 Agent，保留行内网关子路径。
// 开发环境的服务地址只用于 Vite 代理，浏览器仍发送同源请求。
export const backendApiBase = import.meta.env.DEV
  ? ""
  : (import.meta.env.VITE_BACKEND_NEXT_BASE_URL ?? "").replace(/\/+$/, "")

// 网关部署可复用一期 /api/ 入口；单体和开发环境沿用独立 Agent 代理。
const agentApiPath = import.meta.env.DEV
  ? "/agent-api"
  : (import.meta.env.VITE_AGENT_API_PATH || "/agent-api").replace(/\/+$/, "")

export const agentApiBase = `${backendApiBase}${agentApiPath}`
