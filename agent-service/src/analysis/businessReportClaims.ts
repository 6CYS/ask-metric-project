interface ClaimEvidence {ref: string; value?: string}

/** 只接受专项回执中的正式比较量；用十进制文本取符号，避免浮点下溢把微小变化判为零。 */
export function overviewComparisonSign(atom: ClaimEvidence | undefined): -1 | 0 | 1 | undefined {
  if (!atom || !/(?:^|\.)(?:mom|yoy|ytd)\.(?:difference|rate)$/u.test(atom.ref)
    || atom.value === undefined || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(atom.value)) return undefined;
  const mantissa = atom.value.split(/e/iu)[0]!;
  return /[1-9]/u.test(mantissa) ? mantissa.startsWith("-") ? -1 : 1 : 0;
}
