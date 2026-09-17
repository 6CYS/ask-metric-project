"""有界数学表达式：AST 白名单限制能力，Decimal 保留十进制，模型不提供业务值。"""

import ast
import re
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal, DecimalException, localcontext
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field
from simpleeval import InvalidExpression, SimpleEval

Name = Annotated[str, Field(pattern=r"^[a-zA-Z][a-zA-Z0-9_]{0,31}$")]


class CalculationError(ValueError):
    pass


class FactBinding(BaseModel):
    model_config = ConfigDict(extra="forbid")
    fact_id: str = Field(min_length=1, max_length=180)


class CalculationScope(BaseModel):
    model_config = ConfigDict(extra="forbid")
    scope_id: str = Field(min_length=1, max_length=128)
    user_question: str = Field(min_length=1, max_length=8000)


class UserConstant(BaseModel):
    model_config = ConfigDict(extra="forbid")
    value: str = Field(pattern=r"^-?\d{1,30}(\.\d{1,20})?$", max_length=52)
    source_text: str = Field(min_length=1, max_length=200)


class CalculationExpression(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Name
    label: str = Field(min_length=1, max_length=80)
    expression: str = Field(min_length=1, max_length=2000)
    display: Literal["decimal", "percent"] = "decimal"
    decimal_places: int = Field(default=2, ge=0, le=8)


class CalculationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    conversation_id: str = Field(min_length=1, max_length=128)
    scope_id: str = Field(min_length=1, max_length=128)
    expressions: list[CalculationExpression] = Field(min_length=1, max_length=10)
    bindings: dict[Name, FactBinding] = Field(min_length=1, max_length=100)
    constants: dict[Name, UserConstant] = Field(default_factory=dict, max_length=20)


def decimal_value(value: str | int | Decimal) -> Decimal:
    # 浮点来源不能靠 Decimal(str(float)) 恢复丢失精度，必须明确拒绝。
    if isinstance(value, (float, bool)) or not isinstance(value, (str, int, Decimal)):
        raise CalculationError("原始数据不是精确十进制，无法参与计算。")
    try:
        result = Decimal(value)
    except (DecimalException, ValueError) as exc:
        raise CalculationError("数值格式无效。") from exc
    if (
        not result.is_finite()
        or len(result.as_tuple().digits) > 60
        or (result and abs(result.adjusted()) > 100)
    ):
        raise CalculationError("数值超出允许范围。")
    return result


@dataclass(frozen=True)
class Quantity:
    value: Decimal
    # 单位指数在乘除时组合；加减只能使用完全相同的单位，不猜单位换算系数。
    units: tuple[tuple[str, int], ...] = ()

    def combine(self, other: "Quantity", op: str) -> "Quantity":
        if op in {"add", "sub"}:
            if self.units != other.units:
                raise CalculationError("加减或聚合的数据单位不一致，请确认计算口径。")
            value = self.value + other.value if op == "add" else self.value - other.value
            units = self.units
        else:
            if op == "div" and not other.value:
                raise CalculationError("分母为零，无法计算。")
            value = self.value * other.value if op == "mul" else self.value / other.value
            powers = dict(self.units)
            for unit, power in other.units:
                powers[unit] = powers.get(unit, 0) + (power if op == "mul" else -power)
            units = tuple(sorted((unit, power) for unit, power in powers.items() if power))
        return Quantity(decimal_value(value), units)


def quantity(value: str | int | Decimal, unit: str) -> Quantity:
    if not unit:
        raise CalculationError("指标缺少正式单位，不能猜测计算口径。")
    # 百分数按比率进入计算，返回时按指定展示格式恢复百分数。
    if unit == "%":
        with localcontext() as context:
            context.prec = 60
            return Quantity(decimal_value(value) / Decimal(100))
    return Quantity(decimal_value(value), ((unit, 1),))


def _aggregate(kind: str, *args: Quantity) -> Quantity:
    if not args or len(args) > 100 or any(item.units != args[0].units for item in args):
        raise CalculationError("聚合至少需要一个值，且所有值单位必须一致。")
    values = [item.value for item in args]
    if kind in {"sum", "avg"}:
        value = sum(values, Decimal(0))
        if kind == "avg":
            value /= Decimal(len(values))
    else:
        value = min(values) if kind == "min" else max(values)
    return Quantity(decimal_value(value), args[0].units)


def evaluate_expression(spec: CalculationExpression, bindings: dict[str, Quantity]) -> dict:
    """只开放纯数学节点；不开放属性、索引、赋值、循环、幂或任意函数。"""
    functions = {
        kind: (lambda *args, kind=kind: _aggregate(kind, *args))
        for kind in ("sum", "avg", "min", "max")
    }
    functions["abs"] = lambda value: Quantity(abs(value.value), value.units)
    try:
        root = ast.parse(spec.expression, mode="eval")
        nodes = list(ast.walk(root))
        allowed = (
            ast.Expression,
            ast.BinOp,
            ast.UnaryOp,
            ast.Call,
            ast.Name,
            ast.Load,
            ast.Add,
            ast.Sub,
            ast.Mult,
            ast.Div,
            ast.UAdd,
            ast.USub,
            ast.Constant,
        )
        if len(nodes) > 300 or any(type(node) not in allowed for node in nodes):
            raise CalculationError("表达式包含不支持的语法或超出复杂度限制。")
        used = set()
        function_nodes = {id(node.func) for node in nodes if isinstance(node, ast.Call)}
        for node in nodes:
            if isinstance(node, ast.Name):
                if node.id in functions and id(node) not in function_nodes:
                    raise CalculationError("数学函数必须以调用形式使用。")
                if node.id not in bindings and node.id not in functions:
                    raise CalculationError("表达式使用了未绑定的变量。")
                if node.id in bindings:
                    used.add(node.id)
            if isinstance(node, ast.Call):
                if (
                    not isinstance(node.func, ast.Name)
                    or node.func.id not in functions
                    or node.keywords
                    or not 1 <= len(node.args) <= 100
                ):
                    raise CalculationError("表达式函数或参数不受支持。")
            if isinstance(node, ast.Constant):
                # 公式仅接受 0、1 这类结构常数；用户系数须带原句单独绑定。
                literal = ast.get_source_segment(spec.expression, node)
                if literal not in {"0", "1"}:
                    raise CalculationError("业务数值须使用数据引用；用户常数须单独绑定来源。")
        if not used:
            raise CalculationError("表达式必须引用已绑定的数据。")
        evaluator = SimpleEval(
            names=bindings,
            functions=functions,
            operators={
                ast.Add: lambda a, b: a.combine(b, "add"),
                ast.Sub: lambda a, b: a.combine(b, "sub"),
                ast.Mult: lambda a, b: a.combine(b, "mul"),
                ast.Div: lambda a, b: a.combine(b, "div"),
                ast.USub: lambda a: Quantity(-a.value, a.units),
                ast.UAdd: lambda a: a,
            },
        )
        evaluator.nodes[ast.Constant] = lambda n: Quantity(
            Decimal(ast.get_source_segment(spec.expression, n))
        )
        with localcontext() as context:
            context.prec = 60
            context.rounding = ROUND_HALF_UP
            result = evaluator.eval(spec.expression, previously_parsed=root.body)
            if not isinstance(result, Quantity):
                raise CalculationError("表达式必须产生单个数值。")
            raw = decimal_value(result.value)
            if spec.display == "percent" and result.units:
                raise CalculationError("只有无量纲比值才能展示为百分比。")
            display_value = raw * 100 if spec.display == "percent" else raw
            rounded = display_value.quantize(Decimal(1).scaleb(-spec.decimal_places))
            if not rounded:
                rounded = abs(rounded)
            unit = (
                "%"
                if spec.display == "percent"
                else "·".join(
                    unit if power == 1 else f"{unit}^{power}" for unit, power in result.units
                )
            )
            return {
                "name": spec.name,
                "label": spec.label,
                "expression": spec.expression,
                "value": str(raw),
                "display_value": format(rounded, "f"),
                "unit": unit,
                "display": spec.display,
                "decimal_places": spec.decimal_places,
                "variables": sorted(used),
            }
    except CalculationError:
        raise
    except (
        SyntaxError,
        DecimalException,
        TypeError,
        ValueError,
        RecursionError,
        InvalidExpression,
    ) as exc:
        raise CalculationError("表达式无效或计算超出允许范围。") from exc


def validate_constant(source: str, value: str, question: str) -> Decimal:
    number = rf"(?<![0-9A-Za-z_.+\-−]){re.escape(value)}(?![0-9A-Za-z_.])"
    if source not in question or not re.search(number, source) or not re.search(number, question):
        raise CalculationError("常数必须逐字来自当前用户问题，不得自行生成换算系数。")
    return decimal_value(value)
