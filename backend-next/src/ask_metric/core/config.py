from functools import lru_cache
from pathlib import Path, PurePosixPath
from typing import Annotated

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy.engine import make_url

from ask_metric.core.config_crypto import decrypt_config_value, load_config_sm4_key

try:  # NoDecode was added after the minimum supported settings release.
    from pydantic_settings import NoDecode
except ImportError:  # pragma: no cover - compatibility with pydantic-settings 2.6

    class NoDecode:
        pass


PROJECT_DIR = Path(__file__).resolve().parents[3]


def _local_database_url(username: str, database: str) -> str:
    authority = f"{username}@localhost:3306"
    return f"mysql+pymysql:{'/' * 2}{authority}/{database}?charset=utf8mb4"


def _local_web_origin(port: int) -> str:
    return f"http{':' + '/' * 2}localhost:{port}"


DEFAULT_APP_DATABASE_URL = _local_database_url("ask_metric_app", "ask_metric_app")
DEFAULT_QUERY_DATABASE_URL = _local_database_url("metric_readonly", "business_metrics")


class Settings(BaseSettings):
    app_name: str = "Ask Metric Backend Next"
    app_env: str = "development"
    log_level: str = "INFO"
    log_file_enabled: bool | None = None
    log_console_enabled: bool | None = None
    log_directory: Path = Path("/home/appuser/log")
    log_data_center_id: str = "-"
    log_zone_id: str = "-"
    log_max_bytes: int = Field(default=50 * 1024 * 1024, gt=0)
    log_retention_days: int = Field(default=3, gt=0, le=365)
    log_max_line_bytes: int = Field(default=200 * 1024, gt=0, le=200 * 1024)
    # 全局流水号规范变量；缺失时使用规范定义的兜底值。
    app_node_code: str = "8888888"
    app_idc: str = "888"
    app_unit: str = "8"
    host: str = "127.0.0.1"
    port: int = 8010
    nacos_enabled: bool = False
    nacos_server_addr: str = Field(default_factory=str)
    nacos_namespace: str = "public"
    nacos_group: str = "DEFAULT_GROUP"
    nacos_service_name: str = "ask-metric-python"
    nacos_cluster_name: str = "DEFAULT"
    nacos_instance_ip: str = Field(default_factory=str)
    nacos_instance_port: int = Field(default=8010, gt=0, le=65_535)
    nacos_instance_id: str = "ask-metric-01"
    nacos_username: str = ""
    nacos_password: str = Field(default_factory=str, repr=False)
    nacos_ephemeral: bool = True
    nacos_request_timeout_ms: int = Field(default=5_000, gt=0)
    nacos_fail_fast: bool = False
    nacos_cache_dir: Path = PROJECT_DIR / ".runtime" / "nacos" / "cache"
    nacos_log_dir: Path = PROJECT_DIR / ".runtime" / "nacos" / "logs"
    app_database_url: str = DEFAULT_APP_DATABASE_URL
    query_database_url: str = DEFAULT_QUERY_DATABASE_URL
    app_database_dialect: str = "mysql"
    query_database_dialect: str = "mysql"
    metric_catalog_database_url: str | None = None
    org_catalog_database_url: str | None = None
    sit_fact_table: str = "ads_lake.adm_rmt_pub_gnrl_drv_indcr_tab"
    sit_metric_config_table: str = "ads_lake.adm_rmt_pub_drv_indcr_cnfgon_infotab"
    sit_org_table: str = "ads_lake.fdm_pub_org_inf_all"
    sit_fact_metric_code_field: str = "indcr_no"
    sit_fact_source_metric_code_field: str = "orig_indcr_no"
    sit_fact_value_basis_field: str = "indcr_nm"
    sit_fact_org_code_field: str = "org_no"
    sit_fact_data_date_field: str = "data_dt"
    sit_fact_value_field: str = "indcvl"
    sit_fact_increment_field: str = "indcvl_incrrng"
    sit_fact_batch_sequence_field: str = "btch_seq_no"
    sit_metric_config_code_field: str = "indcr_no"
    sit_metric_config_name_field: str = "indcr_nm"
    sit_metric_config_effective_date_field: str = "eff_dt"
    sit_metric_config_version_field: str = "indcr_ver_no"
    sit_metric_config_batch_field: str = "btch_seq_no"
    sit_org_code_field: str = "org_no"
    sit_org_name_field: str = "org_chn_nm"
    sit_org_corporation_code_field: str = "corpt_no"
    sit_org_hierarchy_field: str = "org_hier_code"
    sit_metric_fact_snapshot_field: str = "etl_date"
    sit_org_snapshot_field: str = "etl_date"
    sit_org_corporation_code_max: str = "134"
    sit_org_excluded_corporation_code: str = "086"
    sit_org_head_office_corporation_code: str = "000"
    sit_org_legal_entity_hier_code: str = "3"
    sit_org_head_office_hier_code: str = "1"
    sit_org_expected_count: int = Field(default=61, gt=0)
    # Compatibility-only switches retained for existing environment files. Runtime
    # metric queries always filter by sit_fact_data_date_field; load/snapshot dates
    # are never constrained to the requested business-date range.
    sit_partition_mode: str = "none"
    sit_batch_order: str = "etl_date DESC, btch_seq_no DESC"
    sit_metric_active_order: str = "eff_dt,indcr_ver_no,btch_seq_no"
    sit_latest_partition_lookback_days: int = Field(default=1095, gt=0, le=3650)
    query_session_init_statements: Annotated[list[str], NoDecode] = Field(default_factory=list)
    cors_origins: Annotated[list[str], NoDecode] = Field(
        default_factory=lambda: [_local_web_origin(5173)]
    )
    # 正式目录中获全省查询范围的机构编码；默认关闭，按环境明确配置。
    province_query_org_codes: list[str] = Field(default_factory=list)
    sql_echo: bool = False
    backend_next_allow_schema_changes: bool = False
    backend_next_allow_non_test_database: bool = False
    continuation_token_secret: str = Field(default_factory=str, repr=False)
    continuation_token_ttl_seconds: int = 86_400
    model_config_path: Path = PROJECT_DIR / "config" / "model-config.json"
    model_secret_env_path: Path = PROJECT_DIR / ".env"
    prompt_config_path: Path = PROJECT_DIR / "config" / "prompts.json"
    semantic_config_path: Path = PROJECT_DIR / "config" / "semantic-config.json"
    query_template_config_path: Path = PROJECT_DIR / "config" / "query-templates.json"
    sql_resource_dir: Path = PROJECT_DIR / "resources" / "sql"
    config_history_dir: Path = PROJECT_DIR / ".runtime" / "config-history"
    test_center_data_dir: Path = PROJECT_DIR / ".runtime" / "test-center"
    test_center_baseline_path: Path = (
        PROJECT_DIR / "resources" / "testing" / "accuracy-baseline.json"
    )
    query_result_limit: int = Field(default=1000, gt=0, le=10_000)
    query_statement_timeout_ms: int = Field(default=30_000, gt=0, le=600_000)
    model_admin_write_enabled: bool | None = None
    model_admin_token_required: bool | None = None
    model_admin_token: str = Field(default_factory=str, repr=False)
    trusted_proxy_token: str = Field(default_factory=str, repr=False)
    # Digital Rural Commercial Bank unified SSO (disabled by default).
    sso_enabled: bool = False
    sso_portal_url: str = ""
    sso_org_code_mapping: dict[str, str] = Field(default_factory=dict)
    sso_user_info_url: str = ""
    sso_timeout_seconds: float = Field(default=10.0, gt=0, le=60)
    sso_source_system: str = "jsrcb"
    jwt_secret: str = Field(default_factory=str, repr=False)
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = Field(default=480, gt=0)
    jwt_issuer: str = "ask-metric"
    jwt_audience: str = "ask-metric-web"
    # 登录国密传输：SM2 私钥（64 位 hex）。开发/测试缺省时使用进程级临时密钥，
    # 生产环境必须显式配置，且不得提交到 Git。
    sm2_private_key: str = Field(default_factory=str, repr=False)
    ask_metric_config_sm4_key_file: Path | None = None
    database_pool_size: int = Field(default=10, gt=0)
    database_max_overflow: int = Field(default=20, ge=0)
    database_pool_timeout: float = Field(default=30, gt=0)
    database_pool_recycle: int = Field(default=1800, ge=0)
    model_max_connections: int = Field(default=20, gt=0)
    model_max_keepalive_connections: int = Field(default=10, gt=0)
    model_max_concurrency: int = Field(default=8, gt=0)
    model_concurrency_wait_seconds: float = Field(default=30, gt=0)
    metric_catalog_cache_ttl_seconds: float = Field(default=60, gt=0)
    max_conversations_per_user: int = Field(default=500, gt=0, le=1000)

    model_config = SettingsConfigDict(
        env_file=PROJECT_DIR / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    @model_validator(mode="before")
    @classmethod
    def decrypt_sensitive_configuration(cls, value: object) -> object:
        if not isinstance(value, dict):
            return value
        decrypted = dict(value)
        encrypted_fields = [
            field_name
            for field_name in (
                "nacos_password",
                "app_database_url",
                "query_database_url",
                "metric_catalog_database_url",
                "org_catalog_database_url",
                "continuation_token_secret",
                "model_admin_token",
                "trusted_proxy_token",
                "jwt_secret",
                "sm2_private_key",
            )
            if isinstance(decrypted.get(field_name), str)
            and str(decrypted[field_name]).startswith("ENC[SM4:v1:")
        ]
        configured_key_file = decrypted.get("ask_metric_config_sm4_key_file")
        if not encrypted_fields:
            return decrypted
        if configured_key_file:
            configured_key = load_config_sm4_key(
                environ={}, key_file=Path(configured_key_file)
            )
            for field_name in encrypted_fields:
                decrypted[field_name] = decrypt_config_value(
                    str(decrypted[field_name]), configured_key
                )
            return decrypted
        for field_name in encrypted_fields:
            decrypted[field_name] = decrypt_config_value(str(decrypted[field_name]))
        return decrypted

    @field_validator("log_level", mode="before")
    @classmethod
    def normalize_log_level(cls, value: object) -> object:
        if not isinstance(value, str):
            return value
        normalized = value.strip().upper()
        if normalized == "WARN":
            normalized = "WARNING"
        if normalized not in {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}:
            raise ValueError("LOG_LEVEL is unsupported")
        return normalized

    @field_validator("app_node_code")
    @classmethod
    def validate_app_node_code(cls, value: str) -> str:
        import re

        normalized = value.strip()
        if not re.fullmatch(r"[A-Za-z0-9]{7}", normalized):
            raise ValueError("APP_NODE_CODE must contain exactly 7 letters or digits")
        return normalized

    @field_validator("app_idc")
    @classmethod
    def validate_app_idc(cls, value: str) -> str:
        normalized = value.strip()
        if len(normalized) != 3 or not normalized.isdigit():
            raise ValueError("APP_IDC must contain exactly 3 digits")
        return normalized

    @field_validator("app_unit")
    @classmethod
    def validate_app_unit(cls, value: str) -> str:
        normalized = value.strip()
        if len(normalized) != 1 or not normalized.isdigit():
            raise ValueError("APP_UNIT must contain exactly 1 digit")
        return normalized

    @field_validator("sso_portal_url")
    @classmethod
    def validate_sso_portal_url(cls, value: str) -> str:
        from urllib.parse import urlsplit

        value = value.strip()
        if value:
            url = urlsplit(value)
            if url.scheme not in {"http", "https"} or not url.netloc or url.username:
                raise ValueError("sso_portal_url must be an HTTP(S) platform address")
        return value

    @field_validator("cors_origins", mode="before")
    @classmethod
    def parse_cors_origins(cls, value: object) -> object:
        if isinstance(value, str):
            return [item.strip() for item in value.split(",") if item.strip()]
        return value


    @field_validator("query_session_init_statements", mode="before")
    @classmethod
    def parse_session_statements(cls, value: object) -> object:
        if isinstance(value, str):
            return [item.strip() for item in value.split("||") if item.strip()]
        return value

    @field_validator("app_database_dialect", "query_database_dialect", mode="before")
    @classmethod
    def normalize_database_dialect(cls, value: object) -> object:
        if not isinstance(value, str):
            return value
        normalized = value.strip().lower()
        if normalized in {"goldendb", "goldendb/mysql"}:
            return "mysql"
        return normalized

    @field_validator("sit_fact_table", "sit_metric_config_table", "sit_org_table")
    @classmethod
    def validate_table_name(cls, value: str) -> str:
        import re

        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*){0,2}", value):
            raise ValueError("SIT table settings must be qualified SQL identifiers")
        return value

    @field_validator(
        "sit_metric_fact_snapshot_field",
        "sit_org_snapshot_field",
        "sit_fact_metric_code_field",
        "sit_fact_source_metric_code_field",
        "sit_fact_value_basis_field",
        "sit_fact_org_code_field",
        "sit_fact_data_date_field",
        "sit_fact_value_field",
        "sit_fact_increment_field",
        "sit_fact_batch_sequence_field",
        "sit_metric_config_code_field",
        "sit_metric_config_name_field",
        "sit_metric_config_effective_date_field",
        "sit_metric_config_version_field",
        "sit_metric_config_batch_field",
        "sit_org_code_field",
        "sit_org_name_field",
        "sit_org_corporation_code_field",
        "sit_org_hierarchy_field",
    )
    @classmethod
    def validate_source_field_name(cls, value: str) -> str:
        import re

        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", value):
            raise ValueError("SIT snapshot fields must be SQL identifiers")
        return value

    @field_validator("sit_batch_order")
    @classmethod
    def normalize_batch_order(cls, value: str) -> str:
        import re

        match = re.fullmatch(
            r"\s*([A-Za-z_][A-Za-z0-9_]*)\s+(ASC|DESC)\s*,\s*"
            r"([A-Za-z_][A-Za-z0-9_]*)\s+(ASC|DESC)\s*",
            value,
            re.IGNORECASE,
        )
        if not match:
            raise ValueError("SIT_BATCH_ORDER must contain two safe field/direction pairs")
        return (
            f"{match.group(1)} {match.group(2).upper()}, "
            f"{match.group(3)} {match.group(4).upper()}"
        )

    @model_validator(mode="after")
    def require_production_token_secret(self) -> "Settings":
        environment = self.app_env.lower()
        if self.log_file_enabled is None:
            self.log_file_enabled = environment not in {"development", "test"}
        if self.log_console_enabled is None:
            self.log_console_enabled = environment in {"development", "test"}
        if environment not in {"development", "test"}:
            if not self.log_file_enabled:
                raise ValueError("LOG_FILE_ENABLED must be true outside development and test")
            if not (
                self.log_directory.is_absolute()
                or PurePosixPath(str(self.log_directory).replace("\\", "/")).is_absolute()
            ):
                raise ValueError("LOG_DIRECTORY must be an absolute path in production")
        if self.model_admin_write_enabled is None:
            self.model_admin_write_enabled = environment == "development"
        if self.model_admin_token_required is None:
            self.model_admin_token_required = environment != "development"
        if (
            environment not in {"development", "test"}
            and (
                not self.continuation_token_secret.strip()
                or self.continuation_token_secret.startswith("development-only")
            )
        ):
            raise ValueError("CONTINUATION_TOKEN_SECRET must be changed outside development")
        if (
            self.model_admin_write_enabled
            and self.model_admin_token_required
            and not self.model_admin_token
        ):
            raise ValueError("MODEL_ADMIN_TOKEN is required when model config writes are enabled")
        if self.sso_enabled and not self.sso_user_info_url.strip():
            raise ValueError("SSO_USER_INFO_URL is required when SSO_ENABLED is true")
        if (
            self.model_admin_write_enabled
            and not self.model_admin_token_required
            and environment not in {"development", "test"}
        ):
            raise ValueError(
                "MODEL_ADMIN_TOKEN_REQUIRED can only be false in development or test"
            )
        supported_database_dialects = {"mysql", "inceptor"}
        if self.app_database_dialect != "mysql":
            raise ValueError("APP_DATABASE_DIALECT must be mysql, goldendb, or goldendb/mysql")
        if self.query_database_dialect not in supported_database_dialects:
            raise ValueError(
                "QUERY_DATABASE_DIALECT must be mysql, inceptor, goldendb, or goldendb/mysql"
            )
        app_url_backend = make_url(self.app_database_url).get_backend_name()
        if app_url_backend in supported_database_dialects:
            if app_url_backend != self.app_database_dialect:
                raise ValueError("APP_DATABASE_URL backend must match APP_DATABASE_DIALECT")
        query_url_backend = make_url(self.query_database_url).get_backend_name()
        if query_url_backend == "mysql" and self.query_database_dialect == "mysql":
            if query_url_backend != self.query_database_dialect:
                raise ValueError("QUERY_DATABASE_URL backend must match QUERY_DATABASE_DIALECT")
        if self.sit_partition_mode not in {"data_date", "none"}:
            raise ValueError("SIT_PARTITION_MODE must be data_date or none")
        ordered_fields = [part.split()[0] for part in self.sit_batch_order.split(",")]
        if ordered_fields != [
            self.sit_metric_fact_snapshot_field,
            self.sit_fact_batch_sequence_field,
        ]:
            raise ValueError(
                "SIT_BATCH_ORDER fields must match snapshot and batch-sequence field settings"
            )
        if (
            self.app_env.lower() not in {"development", "test"}
            and (
                not self.jwt_secret.strip()
                or self.jwt_secret.startswith("development-only")
            )
        ):
            raise ValueError("JWT_SECRET must be changed outside development")
        if self.app_env.lower() not in {"development", "test"} and not self.sm2_private_key.strip():
            raise ValueError("SM2_PRIVATE_KEY must be configured outside development")
        if self.model_max_keepalive_connections > self.model_max_connections:
            raise ValueError("MODEL_MAX_KEEPALIVE_CONNECTIONS cannot exceed MODEL_MAX_CONNECTIONS")
        if self.nacos_enabled:
            required_nacos_settings = {
                "NACOS_SERVER_ADDR": self.nacos_server_addr,
                "NACOS_SERVICE_NAME": self.nacos_service_name,
                "NACOS_GROUP": self.nacos_group,
                "NACOS_INSTANCE_IP": self.nacos_instance_ip,
            }
            if environment not in {"development", "test"}:
                required_nacos_settings.update(
                    {
                        "NACOS_USERNAME": self.nacos_username,
                        "NACOS_PASSWORD": self.nacos_password,
                    }
                )
            missing = [name for name, value in required_nacos_settings.items() if not value.strip()]
            if missing:
                raise ValueError(f"{', '.join(missing)} must be set when NACOS_ENABLED=true")
        return self


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
