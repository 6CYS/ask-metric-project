import {expect, it} from "vitest"
import {createSSRApp} from "vue"
import {renderToString} from "@vue/server-renderer"
import ChatProvisionalAnswer from "./ChatProvisionalAnswer.vue"
import {applyProvisionalAnswer, clearProvisionalAnswer} from "@/lib/provisionalAnswer"

it("流式正文按 markdown 显示，撤回/正式快照/失败后移除临时气泡，不提供复制或导出", async () => {
  const render = (text?: string) => renderToString(createSSRApp(ChatProvisionalAnswer, {text}))
  const current = applyProvisionalAnswer({status: "pending", content: ""},
    {type: "answer_delta", call_seq: 1, mode: "reply", text: "你好，**用户**。"})
  const html = await render(current.provisionalContent)
  expect(html).toContain("<strong>用户</strong>")
  expect(html).toContain("data-provisional-answer")
  expect(html).not.toContain("<button")
  const reset = applyProvisionalAnswer(current, {type: "answer_reset", call_seq: 1, reason: "tool_call"})
  expect(await render(reset.provisionalContent)).not.toContain("data-provisional-answer")
  expect(await render(clearProvisionalAnswer(current).provisionalContent)).not.toContain("data-provisional-answer")
});
