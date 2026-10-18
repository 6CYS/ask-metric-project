"""提取可独立核验的目录和日历事实，不调用模型解释业务目标。

片段只用于保持显式并列条件的绑定。无法唯一划分时保留整句，由同一Pi修正提案或澄清。
"""
import re
from datetime import date
from collections.abc import Sequence

from ask_metric.application.field_resolution import source_calendar_constraints, source_organization_codes
from ask_metric.application.metric_candidates import metric_candidate_index
from ask_metric.domain.semantics import MetricCatalogItem, OrganizationCatalogItem


def inspect_goal(question: str, today: date, metrics: Sequence[MetricCatalogItem], organizations: Sequence[OrganizationCatalogItem], *, reference_year: int | None = None) -> dict:
    # 参照年份只在外部未提供时从原文补全；各环节统一使用同一份来源，不再互相覆盖。
    if reference_year is None:
        year = re.search(r"(?<!\d)(\d{4})年", question)
        reference_year = int(year.group(1)) if year else None
    chunks = [part.strip() for part in re.split(r"[；;。\n]|[，,](?!\s*截至(?:今日|今天))", question) if part.strip()]
    index = metric_candidate_index(metrics)
    def calendar_facts(text: str) -> dict:
        result = source_calendar_constraints(text, today, reference_year=reference_year)
        # 算术尾句中的“五月/六月”可指代前面唯一明确的五月末/六月末；不能再次变成整月取数义务。
        spans = index.mentions(text)
        for match in re.finditer(r"计算|求差|求和|相减|相加", text):
            if any(item["start"] <= match.start() < item["end"] for item in spans):
                continue
            head = source_calendar_constraints(text[:match.start()], today, reference_year=reference_year)
            tail = source_calendar_constraints(text[match.start():], today, reference_year=reference_year)
            points = [value["start"] for value in head["ranges"] if value["start"] == value["end"]]
            if points and tail["ranges"] and not tail["unresolved"] and all(value["start"] != value["end"] and
                    sum(value["start"] <= point <= value["end"] for point in points) == 1 for value in tail["ranges"]):
                return head
        return result
    # 只有每个并列项都有唯一机构和日期时才建立独立绑定；共享集合仍保留组合义务。
    bound_chunks = []
    for chunk in chunks:
        parts = re.split(r"以及|与|和", chunk)
        identities = [source_organization_codes(part, organizations) for part in parts]
        calendars = [calendar_facts(part) for part in parts]
        independently_bound = len(parts) > 1 and all(len(orgs) == 1 for orgs in identities) and all(
            len(value["ranges"]) == 1 and not value["unresolved"] for value in calendars)
        named = [index.mentions(part) for part in parts]
        shared = [values for values in named if values]
        same_metrics = shared and all(
            [value["text"] for value in values] == [value["text"] for value in shared[0]] for values in shared)
        if independently_bound and (all(named) or same_metrics):
            shared_text = "、".join(value["text"] for value in shared[0]) if same_metrics else ""
            bound_chunks.extend(part if mentions else part + "：" + shared_text for part, mentions in zip(parts, named))
        else:
            bound_chunks.append(chunk)
    chunks = bound_chunks
    inspected = []
    for part in chunks:
        mentions = index.mentions(part)
        org_codes = source_organization_codes(part, organizations)
        calendar = calendar_facts(part)
        if mentions or org_codes or calendar["ranges"] or calendar["unresolved"]:
            inspected.append({"question": part, "organizations": org_codes, "calendar": calendar, "mentions": mentions})
        elif inspected:
            # 操作限定属于同一业务，不把“取全部记录”等尾部语义丢掉。
            inspected[-1]["question"] += "，" + part
    if not inspected:
        inspected = [{"question": question, "organizations": [], "calendar": {"ranges": [], "unresolved": []}, "mentions": []}]
    # 逗号只是表达边界。互补字段和同一目标的比较总体不另建空指标义务。
    merged = []
    for part in inspected:
        previous = merged[-1] if merged else None
        postfix_org = previous and not previous["organizations"] and not part["mentions"] and (
            not part["calendar"]["ranges"] or not previous["calendar"]["ranges"] or
            part["calendar"] == previous["calendar"])
        comparison = previous and not part["mentions"] and not part["calendar"]["ranges"] and re.search(
            r"(?:在|与|和|同).*(?:中|之间|相比).*(?:排第几|位次|排名|排位)", part["question"])
        if previous and ((not previous["mentions"] and not part["organizations"]) or
                         (not part["mentions"] and not part["organizations"]) or postfix_org or comparison):
            previous = merged.pop()
            part["question"] = previous["question"] + "，" + part["question"]
            part["organizations"] = source_organization_codes(part["question"], organizations)
            part["calendar"] = calendar_facts(part["question"])
            part["mentions"] = index.mentions(part["question"])
        merged.append(part)
    inspected = merged
    # 同一机构/日期在句首统一声明后，可作为后续明确目标的共享事实；多种来源不猜选。
    all_orgs = source_organization_codes(question, organizations)
    all_calendar = calendar_facts(question)
    by_org = {item.code: item.name for item in organizations}
    for part in inspected:
        prefix = []
        if not part["organizations"] and len(all_orgs) == 1:
            part["organizations"] = all_orgs
            prefix.append(by_org[all_orgs[0]])
        if not part["calendar"]["ranges"] and not part["calendar"]["unresolved"] and len(all_calendar["ranges"]) == 1:
            part["calendar"] = all_calendar
            part["calendar_source"] = "shared"
            value = all_calendar["ranges"][0]
            prefix.append(value["start"] if value["start"] == value["end"] else f"{value['start']}至{value['end']}")
        if prefix:
            part["question"] = "、".join(prefix) + "：" + part["question"]
            part["mentions"] = index.mentions(part["question"])
    mentions = index.mentions(question)
    operation_text = ''.join(' ' if any(item["start"] <= position < item["end"] for item in mentions) else character for position, character in enumerate(question))
    operation_text = re.sub(r"(?:不需要|暂不|不要|无需|不做|不)(?:进行)?(?:计算|求和|求差)[^，,；;。\n]*", "", operation_text)
    requires_calculation = bool(re.search(r"计算|相减|相加|求差|求和|差多少|差额|差值|平均值|均值|合计", operation_text))
    return {"question": question, "fragments": inspected, "reference_year": reference_year, "requires_calculation": requires_calculation}
