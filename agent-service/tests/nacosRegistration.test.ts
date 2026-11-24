import { afterEach, describe, expect, it, vi } from "vitest";
import { createNacosRegistration } from "../src/nacosRegistration.js";

const enabledEnv = {
  NACOS_REGISTER_ENABLED: "true",
  NACOS_SERVER_ADDR: "nacos-a.example:8848",
  NACOS_NAMESPACE: "ask-metric",
  NACOS_GROUP: "DEFAULT_GROUP",
  NACOS_INSTANCE_IP: "192.0.2.40",
};

const ok = () => Response.json({ code: 0, data: "ok" });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Agent Nacos registration", () => {
  it("默认关闭注册，启用时要求填写可供 Gateway 访问的实例地址", () => {
    expect(createNacosRegistration(8020, () => Promise.resolve(true), {})).toBeUndefined();
    expect(() =>
      createNacosRegistration(8020, () => Promise.resolve(true), {
        ...enabledEnv,
        NACOS_INSTANCE_IP: "0.0.0.0",
      }),
    ).toThrow("NACOS_INSTANCE_IP");
  });

  it("停机时等待在途注册完成，再注销实例", async () => {
    vi.useFakeTimers();
    let complete!: (result: Response) => void;
    const unfinished = new Promise<Response>((resolve) => {
      complete = resolve;
    });
    const request = vi
      .fn<typeof fetch>()
      .mockReturnValueOnce(unfinished)
      .mockImplementation(() => Promise.resolve(ok()));
    const registry = createNacosRegistration(
      8020,
      () => Promise.resolve(true),
      enabledEnv,
      request,
    )!;
    registry.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(1);
    const stopped = registry.stop();
    expect(request).toHaveBeenCalledTimes(1);
    complete(ok());
    await stopped;
    expect(request.mock.calls.map(([, init]) => init?.method)).toEqual(["POST", "DELETE"]);
  });

  it("就绪后注册，按心跳续约，实例过期后完整重注册，停机后不再续约", async () => {
    vi.useFakeTimers();
    let ready = false;
    const request = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => Promise.resolve(ok()))
      .mockImplementationOnce(() =>
        Promise.resolve(Response.json({ code: 21003 }, { status: 404 })),
      )
      .mockImplementation(() => Promise.resolve(ok()));
    const registry = createNacosRegistration(
      8020,
      () => Promise.resolve(ready),
      enabledEnv,
      request,
    )!;

    registry.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(request).not.toHaveBeenCalled();
    ready = true;
    await vi.advanceTimersByTimeAsync(5_000);
    const [url, registration] = request.mock.calls[0]!;
    expect(url).toBe("http://nacos-a.example:8848/nacos/v3/client/ns/instance");
    expect(registration?.method).toBe("POST");
    const fields = registration?.body as URLSearchParams;
    expect(Object.fromEntries(fields)).toMatchObject({
      serviceName: "ask-metric-agent",
      namespaceId: "ask-metric",
      ip: "192.0.2.40",
      port: "8020",
      ephemeral: "true",
      heartBeat: "false",
    });
    expect(JSON.parse(fields.get("metadata")!)).toMatchObject({ healthPath: "/health/ready" });

    await vi.advanceTimersByTimeAsync(5_000);
    expect((request.mock.calls[1]![1]?.body as URLSearchParams).get("heartBeat")).toBe("true");
    expect((request.mock.calls[2]![1]?.body as URLSearchParams).get("heartBeat")).toBe("false");

    await registry.stop();
    expect(request.mock.calls[3]![1]?.method).toBe("DELETE");
    expect(request.mock.calls[3]![0]).toEqual(expect.stringContaining("port=8020"));
    await registry.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("首次节点不可用时切换节点，并复用有效的鉴权令牌", async () => {
    vi.useFakeTimers();
    const request = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("connection failed"))
      .mockResolvedValueOnce(Response.json({ accessToken: "unit-test", tokenTtl: 60 }))
      .mockImplementation(() => Promise.resolve(ok()));
    const registry = createNacosRegistration(
      8020,
      () => Promise.resolve(true),
      {
        ...enabledEnv,
        NACOS_SERVER_ADDR: "nacos-a.example:8848,https://nacos-b.example/custom",
        NACOS_USERNAME: "unit-test",
        NACOS_PASSWORD: "unit-test",
      },
      request,
    )!;
    registry.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(request.mock.calls.map(([url]) => url)).toEqual([
      "http://nacos-a.example:8848/nacos/v1/auth/users/login",
      "https://nacos-b.example/custom/v1/auth/users/login",
      "https://nacos-b.example/custom/v3/client/ns/instance",
      "https://nacos-b.example/custom/v3/client/ns/instance",
    ]);
    expect(new Headers(request.mock.calls[3]![1]?.headers).get("Authorization")).toBe(
      "Bearer unit-test",
    );
    request
      .mockResolvedValueOnce(Response.json({ code: 403 }, { status: 403 }))
      .mockResolvedValueOnce(Response.json({ accessToken: "refreshed", tokenTtl: 60 }));
    await registry.stop();
    expect(request.mock.calls[4]![1]?.method).toBe("DELETE");
    expect(request.mock.calls[5]![0]).toBe("https://nacos-b.example/custom/v1/auth/users/login");
    expect(request.mock.calls[6]![1]?.method).toBe("DELETE");
    expect(new Headers(request.mock.calls[6]![1]?.headers).get("Authorization")).toBe(
      "Bearer refreshed",
    );
  });
});
