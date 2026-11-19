"""数值运算语义独立于展示单位；不从数值大小推断单位或比例编码。"""


def is_ordinal_metric(metric: dict) -> bool:
    kind = metric.get("quantity_kind")
    if kind:
        return bool(kind == "ranking")
    # 上游目录按“基础指标名 + 取值口径”组成正式名称；只识别明确的名次口径。
    basis = metric.get("value_basis")
    if basis == "排名":
        return True
    base_name = metric.get("base_name")
    if base_name and base_name.endswith("排名"):
        return True
    if not basis and metric.get("name", "").endswith("排名"):
        return True
    # 历史快照仍遵循当时的单位协议，新取数不再读取数据库单位。
    return metric.get("value_policy") != "source_raw_v1" and metric.get("unit") == "名"


def comparison_encoding_confirmed(metric: dict) -> bool:
    if metric.get("value_policy") == "source_raw_v1":
        # 同一正式口径的原值差额和相对变化不需要缩放。不得解释为百分点。
        return True
    return bool(metric.get("unit")) and (
        metric["unit"] != "%" or metric.get("value_encoding") in {"ratio", "percent"}
    )
