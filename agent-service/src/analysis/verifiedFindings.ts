/** 短引用只改变模型视图；判断与计算依据始终使用服务端不可变回执中的原子。 */
export interface FindingAtom {ref: string; type?: string; judgment_kind?: string; input_refs?: string[]}
export interface VerifiedFindings {
  version: string; boundary: string;
  items: Array<{ref: string; kind: string; text: string; evidence_refs: string[]; date?: string; org_code?: string}>;
}

export function analysisEvidenceAliases(owner: string, atoms: readonly FindingAtom[]) {
  const aliases = new Map<string, string>();
  atoms.filter(atom => atom.type !== "observation")
    .forEach((atom, index) => aliases.set(`${owner}.v${index + 1}`, atom.ref));
  atoms.filter(atom => atom.judgment_kind)
    .forEach((atom, index) => aliases.set(`${owner}.j${index + 1}`, atom.ref));
  return aliases;
}

export function verifiedFindingsView(findings: VerifiedFindings | undefined, aliases: Map<string, string>) {
  if (!findings) return undefined;
  const names = new Map([...aliases].map(([alias, ref]) => [ref, alias]));
  return {...findings, items: findings.items.map(item => ({ref: names.get(item.ref) ?? item.ref,
    kind: item.kind, text: item.text, ...(item.date ? {date: item.date} : {}),
    ...(item.org_code ? {org_code: item.org_code} : {}),
    evidence_refs: item.evidence_refs.map(ref => names.get(ref) ?? ref)}))};
}

export function expandFindingRefs(refs: string[], atoms: Map<string, FindingAtom>) {
  const result = new Set(refs), visiting = new Set<string>(), checked = new Set<string>();
  const visit = (ref: string) => {
    if (!atoms.has(ref) || visiting.has(ref)) throw new Error("判断证据链不完整，请重新取数。");
    if (checked.has(ref)) return;
    visiting.add(ref);
    for (const parent of atoms.get(ref)?.input_refs ?? []) {result.add(parent); visit(parent);}
    visiting.delete(ref); checked.add(ref);
  };
  refs.forEach(visit);
  return [...result];
}
