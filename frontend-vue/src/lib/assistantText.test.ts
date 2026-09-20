import { describe, expect, it } from "vitest"

import { flattenAssistantBlocks, parseAssistantBlocks } from "./assistantText"

describe("parseAssistantBlocks", () => {
  it("纯文本按换行拆段", () => {
    expect(parseAssistantBlocks("第一段。\n第二段。")).toEqual([
      { type: "paragraph", segments: [{ text: "第一段。", bold: false }] },
      { type: "paragraph", segments: [{ text: "第二段。", bold: false }] },
    ])
  })

  it("加粗语法映射为 bold 片段，星号不漏出", () => {
    expect(parseAssistantBlocks("泰州农商行的排名为**第14名**。")).toEqual([
      {
        type: "paragraph",
        segments: [
          { text: "泰州农商行的排名为", bold: false },
          { text: "第14名", bold: true },
          { text: "。", bold: false },
        ],
      },
    ])
  })

  it("无序列表与有序列表解析为列表块", () => {
    expect(parseAssistantBlocks("- 存款余额：100万元\n- 贷款余额：80万元")).toEqual([
      {
        type: "list",
        ordered: false,
        items: [
          [{ text: "存款余额：100万元", bold: false }],
          [{ text: "贷款余额：80万元", bold: false }],
        ],
      },
    ])
    expect(parseAssistantBlocks("1. 第一步\n2. 第二步")).toEqual([
      {
        type: "list",
        ordered: true,
        items: [
          [{ text: "第一步", bold: false }],
          [{ text: "第二步", bold: false }],
        ],
      },
    ])
  })

  it("表格解析出表头、数据行与列对齐", () => {
    const blocks = parseAssistantBlocks("| 机构 | 余额 |\n|:-----|-----:|\n| 泰州 | 100 |")
    expect(blocks).toEqual([
      {
        type: "table",
        header: [[{ text: "机构", bold: false }], [{ text: "余额", bold: false }]],
        rows: [[[{ text: "泰州", bold: false }], [{ text: "100", bold: false }]]],
        aligns: ["left", "right"],
      },
    ])
  })

  it("白名单外语法降级为纯文本：标题去 #、HTML 丢弃、emoji 清除", () => {
    expect(parseAssistantBlocks("## 结论\n<b>加粗</b>正常✅")).toEqual([
      { type: "paragraph", segments: [{ text: "结论", bold: false }] },
      { type: "paragraph", segments: [{ text: "加粗", bold: false }, { text: "正常", bold: false }] },
    ])
  })

  it("流式截断的表格语法不报错，按纯文本降级", () => {
    expect(() => parseAssistantBlocks("| 机构 | 余额 |\n|:---")).not.toThrow()
  })
})

describe("flattenAssistantBlocks", () => {
  it("块序列还原为纯文本，列表带序号、表格按制表符分列", () => {
    const text = flattenAssistantBlocks(parseAssistantBlocks("结论：**第14名**。\n- 甲\n- 乙\n\n| 机构 | 余额 |\n|---|---|\n| 泰州 | 100 |"))
    expect(text).toBe("结论：第14名。\n- 甲\n- 乙\n机构\t余额\n泰州\t100")
  })
})
