"""测试会话级合成配置：机构范围 6 项为必填配置，测试进程统一提供合成值。

仅填充缺失项，不覆盖真实环境已设置的取值。
"""

import os

for _key, _value in {
    "SIT_ORG_CORPORATION_CODE_MAX": "134",
    "SIT_ORG_EXCLUDED_CORPORATION_CODE": "086",
    "SIT_ORG_HEAD_OFFICE_CORPORATION_CODE": "000",
    "SIT_ORG_LEGAL_ENTITY_HIER_CODE": "3",
    "SIT_ORG_HEAD_OFFICE_HIER_CODE": "1",
    "SIT_ORG_EXPECTED_COUNT": "61",
}.items():
    os.environ.setdefault(_key, _value)
