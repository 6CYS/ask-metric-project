import { isIP } from "node:net";
import { loginNacos, readNacosConnection } from "./nacosConnection.js";

const heartbeatIntervalMs = 5000;
const deregistrationTimeoutMs = 3000;
const instanceExpired = 21003;
type Operation = "register" | "renew" | "deregister";

export function createNacosRegistration(
  servicePort: number,
  ready: (signal: AbortSignal) => Promise<boolean>,
  env: NodeJS.ProcessEnv = process.env,
  request: typeof fetch = fetch,
) {
  const enabled = (env.NACOS_REGISTER_ENABLED ?? "false").trim().toLowerCase();
  if (enabled === "false" || enabled === "0") return undefined;
  if (enabled !== "true" && enabled !== "1") {
    throw new Error("NACOS_REGISTER_ENABLED 必须为 true/false");
  }
  const ip = env.NACOS_INSTANCE_IP?.trim() ?? "";
  if (!isIP(ip) || ip === "0.0.0.0" || ip === "::") {
    throw new Error("启用 Nacos 注册时必须填写 Gateway 可访问的 NACOS_INSTANCE_IP");
  }
  const port = Number(env.NACOS_INSTANCE_PORT?.trim() || servicePort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("NACOS_INSTANCE_PORT 必须为有效的端口号");
  }
  const connection = readNacosConnection(env);
  const { timeout, servers } = connection;
  const instance = {
    namespaceId: connection.namespace,
    groupName: env.NACOS_GROUP?.trim() || "DEFAULT_GROUP",
    serviceName: env.NACOS_SERVICE_NAME?.trim() || "ask-metric-agent",
    clusterName: env.NACOS_CLUSTER_NAME?.trim() || "DEFAULT",
    ip,
    port: String(port),
    ephemeral: "true",
  };
  const tokens = new Map<string, Awaited<ReturnType<typeof loginNacos>>>();
  let preferredServer = servers[0]!;
  let stopping = false;

  async function publish(operation: Operation, deadline?: AbortSignal): Promise<boolean> {
    const params = new URLSearchParams(instance);
    const deleting = operation === "deregister";
    if (!deleting) params.set("heartBeat", String(operation === "renew"));
    if (operation === "register") {
      params.set("metadata", JSON.stringify({ protocol: "http", healthPath: "/health/ready" }));
    }
    // 优先续约同一个节点，网络失败时才尝试集群中的其他节点。
    for (const server of [
      preferredServer,
      ...servers.filter((value) => value !== preferredServer),
    ]) {
      if (deadline?.aborted || (stopping && !deleting)) break;
      const nodeTimeout = AbortSignal.timeout(timeout);
      const signal = deadline ? AbortSignal.any([nodeTimeout, deadline]) : nodeTimeout;
      try {
        const url = `${server}/v3/client/ns/instance`;
        const send = (token?: string) =>
          request(deleting ? `${url}?${params.toString()}` : url, {
            method: deleting ? "DELETE" : "POST",
            ...(deleting ? {} : { body: params }),
            ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
            signal,
            redirect: "error",
          });
        const cached = tokens.get(server);
        const validToken = cached && cached.expiresAt > Date.now() ? cached.token : undefined;
        const authenticate = async () => {
          const auth = await loginNacos(server, connection, request, signal);
          tokens.set(server, auth);
          return auth.token;
        };
        let response = await send(
          connection.username ? (validToken ?? (await authenticate())) : undefined,
        );
        if (response.status === 401 || response.status === 403) {
          tokens.delete(server);
          if (validToken && (deleting || !stopping)) {
            await response.body?.cancel();
            response = await send(await authenticate());
          }
        }
        const result = (await response.json()) as { code?: number; data?: unknown };
        if (response.ok && result.code === 0 && result.data === "ok") {
          preferredServer = server;
          return true;
        }
        if (result.code === instanceExpired) {
          if (deleting) return true;
          if (operation === "renew") return false;
        }
      } catch {
        /* 失败原因可能包含连接参数，只在进程日志写受控提示。 */
      }
    }
    throw new Error("Nacos 实例操作未确认成功");
  }

  let registered = false;
  let registrationAttempted = false;
  let started = false;
  let failureReported = false;
  let timer: NodeJS.Timeout | undefined;
  let pendingWrite: Promise<boolean> | undefined;
  let shutdown: Promise<void> | undefined;

  async function writeInstance(operation: "register" | "renew") {
    pendingWrite = publish(operation);
    try {
      return await pendingWrite;
    } finally {
      pendingWrite = undefined;
    }
  }

  async function tick() {
    if (registered) registered = await writeInstance("renew");
    if (stopping) return;
    if (!registered && (await ready(AbortSignal.timeout(timeout))) && !stopping) {
      registrationAttempted = true;
      registered = await writeInstance("register");
      console.log("Agent 已注册到 Nacos");
    }
  }

  function schedule() {
    void tick()
      .then(
        () => {
          failureReported = false;
        },
        () => {
          if (!failureReported) console.warn("Agent 的 Nacos 注册或续约失败，将继续尝试");
          failureReported = true;
        },
      )
      .finally(() => {
        if (!stopping) timer = setTimeout(schedule, heartbeatIntervalMs).unref();
      });
  }

  return {
    shutdownTimeoutMs: Math.min(timeout + deregistrationTimeoutMs + 1000, 2_147_483_647),
    start() {
      if (started || stopping) return;
      started = true;
      schedule();
    },
    stop() {
      if (shutdown) return shutdown;
      stopping = true;
      clearTimeout(timer);
      shutdown = (async () => {
        // 等待已发出的注册或续约结束，避免注销后旧请求又恢复实例。
        await pendingWrite?.catch(() => false);
        if (registrationAttempted) {
          try {
            await publish("deregister", AbortSignal.timeout(deregistrationTimeoutMs));
          } catch {
            console.warn("Agent 的 Nacos 注销未确认，等待临时实例超期");
          }
        }
      })();
      return shutdown;
    },
  };
}
