/**
 * 全局发送器：面板不持有 ctx，由插件 apply 注册「当前会话发送」实现。
 * 识别文本通过这里直接发送到当前会话（自动发送）。
 */
export type TextSender = (text: string) => Promise<string | null>

let sender: TextSender | null = null

export function setTextSender(next: TextSender | null): void {
  sender = next
}

/** 发送识别文本；null 成功，否则返回面向面板的中文错误说明。 */
export async function sendRecognizedText(text: string): Promise<string | null> {
  if (sender === null) return '发送功能未就绪'
  return sender(text)
}