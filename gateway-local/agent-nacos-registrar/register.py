"""为没有内置 Nacos naming 的 Agent 进程维持一个临时实例注册。"""

from __future__ import annotations

import asyncio
import os
import signal

from v2.nacos import (
    ClientConfigBuilder,
    GRPCConfig,
    NacosNamingService,
    RegisterInstanceParam,
)


async def main() -> int:
    server_addr = os.environ.get("NACOS_ADDR", "nacos:8848")
    service_name = os.environ.get("NACOS_SERVICE_NAME", "ask-metric-agent")
    group_name = os.environ.get("NACOS_GROUP", "DEFAULT_GROUP")
    cluster_name = os.environ.get("NACOS_CLUSTER_NAME", "DEFAULT")
    instance_ip = os.environ.get("NACOS_INSTANCE_IP", "172.31.240.21")
    instance_port = int(os.environ.get("NACOS_INSTANCE_PORT", "8020"))
    interval = max(3, int(os.environ.get("NACOS_REGISTER_INTERVAL_SECONDS", "5")))
    stopping = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stopping.set)

    builder = (
        ClientConfigBuilder()
        .server_address(server_addr)
        .namespace_id("public")
        .timeout_ms(5_000)
        .cache_dir("/tmp/ask-metric-nacos/cache")
        .log_dir("/tmp/ask-metric-nacos/logs")
        .grpc_config(GRPCConfig(grpc_timeout=5_000))
        .log_level("WARN")
    )
    client = await NacosNamingService.create_naming_service(builder.build())
    instance = RegisterInstanceParam(
        service_name=service_name,
        group_name=group_name,
        cluster_name=cluster_name,
        ip=instance_ip,
        port=instance_port,
        ephemeral=True,
        metadata={
            "protocol": "http",
            "healthPath": "/health/ready",
            "version": "local",
        },
    )
    try:
        while not stopping.is_set():
            try:
                registered = await client.register_instance(instance)
                if not registered:
                    print("Nacos 注册未确认成功", flush=True)
            except Exception as exc:
                print(f"Nacos 注册失败: {type(exc).__name__}", flush=True)
            try:
                await asyncio.wait_for(stopping.wait(), timeout=interval)
            except asyncio.TimeoutError:
                pass
    finally:
        try:
            await client.deregister_instance(instance)
        except Exception:
            pass
        try:
            await client.shutdown()
        except TypeError:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
