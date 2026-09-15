"""部署已确认的单位口径；排名优先于比率，无法识别时不猜金额单位。"""
from __future__ import annotations

import re


class MetricUnitError(ValueError):
    def __init__(self, names: list[str]):
        self.names = names
        super().__init__(f"{len(names)} 个指标缺少已确认单位")


def infer_metric_unit(name: str) -> str | None:
    if name.endswith("排名"):
        return "名"
    if re.search(r"增幅|增速|比率|占比|率", name):
        return "%"
    if re.search(r"客户数|客户数量|户数", name):
        return "户"
    if re.search(r"机构数|机构数量", name):
        return "个"
    if re.search(r"数量(?:当日数|全省均值|成长类均值|拓展类均值|提升类均值|进取类均值|"
                 r"较上季|较上月|较全省均值|较同期|较同期期末|较层级均值|较年初)?$", name):
        return "个"
    if name.startswith("代销业务规模"):
        return "个"
    if name.startswith(("净息差额_内部管理", "净息差额_外部管理", "财富业务总额_开门红考核")):
        return "元"
    if re.search(r"数量|笔数|人数|次数|张数|天数|期限", name):
        return None
    if re.search(r"金额|余额|利润|收入|支出|存款|贷款|资产|负债|成本|费用|资本", name):
        return "元"
    return None
