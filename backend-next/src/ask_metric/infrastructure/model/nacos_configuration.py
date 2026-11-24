"""按同一 Nacos 版本读取与条件发布 Python 模型配置。"""

from pathlib import Path

from ask_metric.core.errors import ApplicationError
from ask_metric.infrastructure.config_center.nacos import (
    MODEL_DATA_ID,
    ConfigCenterConflict,
    ConfigCenterError,
    NacosConfigStore,
)
from ask_metric.infrastructure.model.configuration import ModelConfigRepository, ModelRuntimeConfig


class NacosModelConfigRepository(ModelConfigRepository):
    def __init__(self, store: NacosConfigStore) -> None:
        super().__init__(Path("unused"), store=store)
        self.center = store
        self.snapshot: tuple[dict, str] | None = None
        self.expected_revision: str | None = None

    def read_document(self) -> dict:
        if self.snapshot is None:
            try:
                self.snapshot = self.center.read_json_with_revision(MODEL_DATA_ID)
            except ConfigCenterError:
                raise ApplicationError(
                    "MODEL_CONFIG_UNAVAILABLE",
                    "请核对 Nacos 中的 Python 模型配置。",
                    status_code=503,
                ) from None
        return self.snapshot[0]

    def load(self) -> ModelRuntimeConfig:
        try:
            return super().load()
        except ValueError:
            raise ApplicationError(
                "MODEL_CONFIG_INVALID",
                "Nacos 中的 Python 模型配置无效。",
                status_code=503,
            ) from None

    @property
    def revision(self) -> str:
        self.read_document()
        assert self.snapshot is not None
        return self.snapshot[1]

    def save(self, config: ModelRuntimeConfig) -> None:
        document = config.model_dump(mode="json")
        try:
            revision = self.center.publish_json(
                MODEL_DATA_ID, document, expected_revision=self.expected_revision or self.revision
            )
        except ConfigCenterConflict:
            raise ApplicationError(
                "CONFIG_VERSION_CONFLICT", "配置已被更新，请刷新后重新编辑。", status_code=409
            ) from None
        except ConfigCenterError:
            raise ApplicationError(
                "MODEL_CONFIG_PUBLISH_FAILED", "Nacos 模型配置发布未确认。", status_code=503
            ) from None
        self.snapshot = document, revision
