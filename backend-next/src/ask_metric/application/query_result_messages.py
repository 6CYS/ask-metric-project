"""正常空结果的事实说明，只使用已经核验的查询范围，不推测缺数原因。"""

from datetime import date


def empty_query_notice(org_names, metric_name, start=None, end=None, dates=None):
    days = sorted({str(day) for day in dates or []})

    def display(day):
        value = date.fromisoformat(str(day))
        return f"{value.year}年{value.month}月{value.day}日"

    if days:
        period = "、".join(display(day) for day in days)
    elif start and end:
        period = display(start) if start == end else f"{display(start)}至{display(end)}"
    elif end:
        period = f"截至{display(end)}的已检查范围内"
    else:
        period = "已检查的时间范围内"
    organizations = "、".join(org_names) if len(org_names) <= 5 else f"所选{len(org_names)}家机构"
    return {"org_names": list(org_names), "metric_name": metric_name, "period": period,
            "message": f"查询已完成，未查到{organizations}在{period}的{metric_name}记录。"}


def completed_empty_message(results):
    """只有全部步骤都正常查完且无有效值时，才生成成功空结果；不掩盖错误或未执行项。"""
    notices = [item for step in results for item in step.get("empty_results", [])]
    messages = {item["message"] for item in notices}
    if not notices or any(
        step.get("execution_error") or step.get("facts") or step.get("calculations")
        or step.get("observations") or not step.get("empty_results")
        or any(task["status"] != "succeeded" for task in step["tasks"])
        or any(gap not in messages for gap in step["gaps"])
        for step in results
    ):
        return None
    groups = {}
    for notice in notices:
        key = (tuple(notice["org_names"]), notice["period"])
        groups.setdefault(key, []).append(notice["metric_name"])
    return "\n\n".join(
        "查询已完成，未查到"
        + ("、".join(names) if len(names) <= 5 else f"所选{len(names)}家机构")
        + f"在{period}的{'、'.join(dict.fromkeys(metrics))}记录。"
        for (names, period), metrics in groups.items()
    )
