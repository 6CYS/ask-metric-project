import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Protocol

from ask_metric.core.config import Settings

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class NacosInstance:
    service_name: str
    group_name: str
    cluster_name: str
    ip: str
    port: int
    ephemeral: bool
    metadata: dict[str, str]


class NamingClient(Protocol):
    async def register(self, instance: NacosInstance) -> bool: ...

    async def deregister(self, instance: NacosInstance) -> bool: ...

    async def shutdown(self) -> None: ...


NamingClientFactory = Callable[[Settings], Awaitable[NamingClient]]


class _SdkNamingClient:
    def __init__(self, client: object) -> None:
        self._client = client

    async def register(self, instance: NacosInstance) -> bool:
        from v2.nacos import RegisterInstanceParam

        return await self._client.register_instance(
            RegisterInstanceParam(
                service_name=instance.service_name,
                group_name=instance.group_name,
                cluster_name=instance.cluster_name,
                ip=instance.ip,
                port=instance.port,
                ephemeral=instance.ephemeral,
                metadata=instance.metadata,
            )
        )

    async def deregister(self, instance: NacosInstance) -> bool:
        from v2.nacos import DeregisterInstanceParam

        return await self._client.deregister_instance(
            DeregisterInstanceParam(
                service_name=instance.service_name,
                group_name=instance.group_name,
                cluster_name=instance.cluster_name,
                ip=instance.ip,
                port=instance.port,
                ephemeral=instance.ephemeral,
            )
        )

    async def shutdown(self) -> None:
        try:
            await self._client.shutdown()
        except TypeError as exc:
            # nacos-sdk-python 2.0.11 closes its gRPC client before incorrectly
            # awaiting the synchronous updater.stop() return value (None).
            if "NoneType" not in str(exc):
                raise


async def create_naming_client(settings: Settings) -> NamingClient:
    try:
        from v2.nacos import ClientConfigBuilder, GRPCConfig, NacosNamingService
    except ImportError as exc:
        raise RuntimeError(
            "Nacos registration is enabled but nacos-sdk-python is not installed"
        ) from exc

    builder = (
        ClientConfigBuilder()
        .server_address(settings.nacos_server_addr)
        .namespace_id(settings.nacos_namespace)
        .timeout_ms(settings.nacos_request_timeout_ms)
        .cache_dir(str(settings.nacos_cache_dir))
        .log_dir(str(settings.nacos_log_dir))
        .grpc_config(GRPCConfig(grpc_timeout=settings.nacos_request_timeout_ms))
        .log_level(settings.log_level)
    )
    if settings.nacos_username:
        builder.username(settings.nacos_username)
    if settings.nacos_password:
        builder.password(settings.nacos_password)

    sdk_client = await NacosNamingService.create_naming_service(builder.build())
    return _SdkNamingClient(sdk_client)


class NacosRegistry:
    """Register one FastAPI process as one Nacos service instance.

    The Nacos SDK owns connection keepalive and reconnect/redo behavior. This
    class only connects registration to the FastAPI process lifecycle.
    """

    def __init__(
        self,
        settings: Settings,
        client_factory: NamingClientFactory = create_naming_client,
    ) -> None:
        self._settings = settings
        self._client_factory = client_factory
        self._client: NamingClient | None = None
        self._instance = NacosInstance(
            service_name=settings.nacos_service_name,
            group_name=settings.nacos_group,
            cluster_name=settings.nacos_cluster_name,
            ip=settings.nacos_instance_ip,
            port=settings.nacos_instance_port,
            ephemeral=settings.nacos_ephemeral,
            metadata={
                "instanceId": settings.nacos_instance_id,
                "protocol": "http",
                "healthPath": "/health/ready",
                "version": "0.1.0",
            },
        )

    async def start(self) -> None:
        if not self._settings.nacos_enabled:
            logger.info("nacos registration disabled")
            return

        try:
            self._client = await self._client_factory(self._settings)
            registered = await self._client.register(self._instance)
            if not registered:
                raise RuntimeError("Nacos returned an unsuccessful registration response")
        except Exception as exc:
            logger.error(
                "nacos registration failed exception_type=%s",
                type(exc).__name__,
                exc_info=(type(exc), exc, exc.__traceback__),
            )
            if self._settings.nacos_fail_fast:
                await self.stop()
                raise
            return

        logger.info(
            "nacos instance registered service=%s group=%s namespace=%s instance=%s:%s",
            self._instance.service_name,
            self._instance.group_name,
            self._settings.nacos_namespace or "public",
            self._instance.ip,
            self._instance.port,
        )

    async def stop(self) -> None:
        if self._client is None:
            return

        try:
            await self._client.deregister(self._instance)
            logger.info(
                "nacos instance deregistered service=%s instance=%s:%s",
                self._instance.service_name,
                self._instance.ip,
                self._instance.port,
            )
        except Exception as exc:
            logger.error(
                "nacos_deregistration_failed exception_type=%s",
                type(exc).__name__,
                exc_info=(type(exc), exc, exc.__traceback__),
            )
        finally:
            try:
                await self._client.shutdown()
            except Exception as exc:
                logger.error(
                    "nacos_shutdown_failed exception_type=%s",
                    type(exc).__name__,
                    exc_info=(type(exc), exc, exc.__traceback__),
                )
            self._client = None
