/**
 * HTTPS/localhost 优先使用异步剪贴板 API；HTTP 部署或浏览器拒绝权限时，
 * 回退到当前用户点击事件内的隐藏 textarea 复制，兼容直接通过云服务器 IP 访问。
 */
export async function copyText(text: string) {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      // 企业策略、浏览器权限或 iframe 策略可能拒绝 Clipboard API，继续尝试兼容方案。
    }
  }

  const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const selection = document.getSelection()
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : []
  const textarea = document.createElement("textarea")
  textarea.value = text
  textarea.readOnly = true
  textarea.setAttribute("aria-hidden", "true")
  textarea.style.position = "fixed"
  textarea.style.inset = "0 auto auto -9999px"
  textarea.style.opacity = "0"
  document.body.appendChild(textarea)
  textarea.focus({ preventScroll: true })
  textarea.select()

  let copied = false
  try {
    copied = document.execCommand("copy")
  } finally {
    textarea.remove()
    activeElement?.focus({ preventScroll: true })
    if (selection) {
      selection.removeAllRanges()
      ranges.forEach((range) => selection.addRange(range))
    }
  }
  if (!copied) throw new Error("CLIPBOARD_UNAVAILABLE")
}
