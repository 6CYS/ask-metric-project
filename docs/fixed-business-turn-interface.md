# 固定业务请求接口

模型的业务提交入口只有 `resolve_business_turn`，公开协议版本为 `protocol_version:1`。参数结构来自 `agent-service/src/business-context/fixedTurnArgs.ts`，直接作为工具的 `function.parameters` 发送并在调用入口强制验证。新模型不再提交旧 `fieldIntents`、`fieldChanges` 或 compact 分组。旧 Delta、Frame、原生记录及合法在途操作在内部兼容，历史事实不改写。

## 根字段与动作

根对象只允许 `protocol_version`、`capability`、`base`、`mode`、`changes` 五个字段，均必填。能力只允许当前已支持的指标查询、覆盖查询和有界公式计算；没有自主分析能力。`base=null` 为独立问题，`base="current"` 继承当前焦点，闭合选择器定位明确历史。来源不自动补成 current。

`changes` 的字段名由能力注册表限定；值是有明确动作的闭合结构。`set` 携带相应字段的类型化 `value`；`confirm` 携带本轮 `source_text` 与 `decision=select/accept`；`inherit` 声明未变化；`clear` 清除；`remove` 只用于已支持的指标移除；`clarify` 保存用户尚未明确的业务条件。不能在一项动作里混装其它动作的键。每次所需的机构动作仍须显式声明，避免把用户的新机构目标默认为继承。

原文依据与用户明确数量在同一个字段动作中表达一次，内部适配器生成既有 Delta 与数量声明。`expected_count=null` 表示本轮未限定集合数量，不表示清除已有数量约束。字段省略、显式继承和清除分别处理；正常 ranking 的 `top_n` 必须是整数，未知条数用 clarify，不填 null 或前 10 名。

## 请求示例

以下均为合成名称及日期，只说明格式，不代表正式数据或默认口径。

精准查询：

```json
{"protocol_version":1,"capability":"metric_query","base":null,"mode":"execute","changes":{"organizations":{"action":"set","source_text":"合成甲行","expected_count":null,"value":{"kind":"name","name":"合成甲行"}},"metrics":{"action":"set","value":{"fromQuestion":true}},"time":{"action":"set","value":"2026年7月31日"}}}
```

只修改日期，指标与机构继续关联原焦点：

```json
{"protocol_version":1,"capability":"metric_query","base":"current","mode":"execute","changes":{"organizations":{"action":"inherit"},"time":{"action":"set","value":"2026年8月31日"}}}
```

排名条件尚未明确时保存其它条件：

```json
{"protocol_version":1,"capability":"metric_query","base":"current","mode":"execute","changes":{"organizations":{"action":"inherit"},"operation":{"action":"clarify","source_text":"排名"}}}
```

按名称或编号选择待确认指标，服务端决定真实候选：

```json
{"protocol_version":1,"capability":"metric_query","base":"current","mode":"execute","changes":{"organizations":{"action":"inherit"},"metrics":{"action":"confirm","source_text":"选择第2项","decision":"select"}}}
```

## 类型与完整性

指标设置仍由完整原文匹配，模型不自行生成正式编码。机构值的 `kind` 只允许单个名称、名称集合、正式范围或明确历史组合；历史来源、combine、新增项及未决项替换有固定结构。组织 scope/history 的原文和数量从字段动作恢复到内部旧结构，不重复向模型索取。

计算的 bindings/constants 使用固定记录数组，变量名是 `name` 数据值，不作为任意 JSON 键；重复变量名在入口拒绝。用户常量继续用字符串保存数值精度。数组、索引、枚举及上下界按当前能力约束校验，拒绝校验器把字符串、0、false 等隐式转换为其它类型。

固定 Schema 负责接口形状；权限、目录、口径、原文依据、数量与执行状态仍由原服务核验。合法结构不授权默认业务条件，也不能代替模型语义验收。当前 SDK 的网关约束生成对子 Schema 有额外限制，本轮没有通过真实模型验证该能力，因此不以 `strict=true` 或“保证模型永远不会生成错形”作为交付承诺。

## 会话兼容与验证

旧模型参数只在可信已持久化的在途操作恢复中使用原执行器；按 operation、callId 和原参数核对，保留原命令幂等身份。新模型输出不得借兼容层继续提交旧格式。历史发送副本能无损投影时转换到固定格式；不能转换的旧调用以成对的历史数据说明呈现，不把旧形状继续当新调用示范。用户原文、指标跨度、正式编码、结果值和 JSONL 权威记录保持原样。

`AGENT_COMPACT_TURN_ARGS` 不再选择新模型的参数协议，保留旧配置读取用于兼容。关闭它不会回退新入口。无需数据库迁移或依赖变更；回退代码须处理新旧在途操作边界，不能整体重置用户已有工作树。
