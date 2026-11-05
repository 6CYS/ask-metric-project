type InlineFrame =
  | { kind: "pair"; close: string }
  | { kind: "emphasis"; marker: string; remaining: number; length: number; canClose: boolean };

const pairs: Readonly<Record<string, string>> = {
  "(": ")",
  "（": "）",
  "“": "”",
  "‘": "’",
  "{": "}",
};
const punctuation = /[\p{P}\p{S}]/u;
const asciiPunctuation = /[!-/:-@[-`{-~]/u;

function runEnd(text: string, start: number): number {
  let end = start + 1;
  while (text[end] === text[start]) end += 1;
  return end;
}

/** 与 Markdown 的左右邻接规则一致；单词内部下划线不打开强调。 */
function delimiterSides(text: string, start: number, end: number) {
  const before =
    (text.codePointAt(start - 2) ?? 0) > 0xffff
      ? text.slice(start - 2, start)
      : (text[start - 1] ?? "\n");
  const after = String.fromCodePoint(text.codePointAt(end) ?? 10);
  const beforeSpace = /\s/u.test(before),
    afterSpace = /\s/u.test(after);
  const beforePunctuation = punctuation.test(before),
    afterPunctuation = punctuation.test(after);
  const left = !afterSpace && (!afterPunctuation || beforeSpace || beforePunctuation);
  const right = !beforeSpace && (!beforePunctuation || afterSpace || afterPunctuation);
  return text[start] === "_"
    ? { open: left && (!right || beforePunctuation), close: right && (!left || afterPunctuation) }
    : { open: left, close: right };
}

function codeSpanEnd(text: string, start: number): number {
  const end = runEnd(text, start),
    length = end - start;
  for (let index = end; index < text.length;) {
    if (text[index] !== "`") {
      index += 1;
      continue;
    }
    const next = runEnd(text, index);
    if (next - index === length) return next;
    index = next;
  }
  return -1;
}

/** 链接标签与地址作为整体跳过，其中标点不构成正文句界。 */
function balancedEnd(text: string, start: number, open: string, close: string): number {
  let depth = 1;
  let quoted: string | undefined;
  for (let index = start + 1; index < text.length; index += 1) {
    if (text[index] === "\\" && asciiPunctuation.test(text[index + 1] ?? "")) index += 1;
    else if (quoted) {
      if (text[index] === quoted) quoted = undefined;
    } else if (open === "[" && text[index] === "`") {
      const end = codeSpanEnd(text, index);
      if (end < 0) return -1;
      index = end - 1;
    } else if (open === "(" && text[index] === "<") quoted = ">";
    else if (open === "(" && /["']/u.test(text[index] ?? "") && /\s/u.test(text[index - 1] ?? ""))
      quoted = text[index];
    else if (text[index] === open) depth += 1;
    else if (text[index] === close && --depth === 0) return index + 1;
  }
  return -1;
}

/** 只选择格式已闭合的句界；不解释业务语义，也不代替报告核验。 */
export function completeSentenceBoundary(text: string): number {
  const stack: InlineFrame[] = [];
  let boundary = 0,
    sentenceEnded = false;
  for (let index = 0; index < text.length;) {
    const character = text[index]!;
    const top = stack.at(-1);
    if (character === "\\" && asciiPunctuation.test(text[index + 1] ?? "")) {
      index += 2;
      sentenceEnded = false;
      continue;
    }
    if (text.startsWith("{{", index)) {
      const end = text.indexOf("}}", index + 2);
      if (end < 0) break;
      index = end + 2;
      sentenceEnded = false;
      continue;
    }
    if (character === "`") {
      const end = codeSpanEnd(text, index);
      if (end < 0) break;
      index = end;
      sentenceEnded = false;
      continue;
    }
    if (character === "[") {
      const labelEnd = balancedEnd(text, index, "[", "]");
      if (labelEnd < 0 || text[labelEnd] !== "(") break;
      const destinationEnd = balancedEnd(text, labelEnd, "(", ")");
      if (destinationEnd < 0) break;
      index = destinationEnd;
      sentenceEnded = false;
      continue;
    }
    // HTML/自动链接与引用式链接仍沿用完整块边界，避免猜测未到达的定义。
    if (character === "<" || character === "]") break;
    if (character === "*" || character === "_" || character === "~") {
      const end = runEnd(text, index),
        length = end - index;
      // 多波浪线可能组成嵌套删除线，保守沿用块边界，不把未闭合格式当普通文字。
      if (character === "~" && length > 2) break;
      const sides = delimiterSides(text, index, end);
      let remaining = length;
      if (character !== "~" || length === 2) {
        while (remaining && sides.close) {
          const opening = stack.at(-1);
          if (opening?.kind !== "emphasis" || opening.marker !== character) break;
          // 双向分隔符的三倍数规则防止把嵌套强调误判为外层闭合。
          if (
            character !== "~" &&
            (opening.canClose || sides.open) &&
            (opening.length + length) % 3 === 0 &&
            (opening.length % 3 !== 0 || length % 3 !== 0)
          )
            break;
          const used = Math.min(opening.remaining, remaining);
          opening.remaining -= used;
          remaining -= used;
          if (!opening.remaining) stack.pop();
        }
        if (remaining && sides.open) {
          stack.push({
            kind: "emphasis",
            marker: character,
            remaining,
            length,
            canClose: sides.close,
          });
          sentenceEnded = false;
        } else if (remaining) sentenceEnded = false;
      } else sentenceEnded = false;
      index = end;
    } else if (top?.kind === "pair" && top.close === character) {
      stack.pop();
      index += 1;
    } else if (pairs[character] || character === '"') {
      stack.push({ kind: "pair", close: pairs[character] ?? character });
      sentenceEnded = false;
      index += 1;
    } else {
      if (!/\s/u.test(character)) sentenceEnded = /[。！？]/u.test(character);
      index += 1;
    }
    if (sentenceEnded && !stack.length) boundary = index;
  }
  return boundary;
}
