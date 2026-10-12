# 指标单位映射

`metric-units.json` 原样取自存量 `ask-metric-UAT-完整部署-20260916(1).zip` 内
`uat-20260916/metric-catalog-linux-x86_64.tar.gz` 的 `data/metric-units.json`。

SHA-256：`76563a9c81d5722550eef0488b51f506d27fefd8c5e7f44d90b6f7cb76761266`。

映射按正式指标完整名称匹配，仅用于主数据同步时确认原始单位；预览发现新增指标缺单位时，
应由数据负责人补齐，再用 `--units` 指定审核文件，不能默认推断所有指标为金额。
不包含机构或指标别名自动导入；别名清单须在独立补录阶段审核后显式传入。
