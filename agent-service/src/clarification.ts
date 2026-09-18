/** 目录选择仅作为待澄清任务的补充；目录真实性及权限仍由后端复核。 */
export interface ClarificationSelection {
  clarification_id: string;
  entities: Array<{ kind: "metric" | "organization"; code: string; name: string }>;
}

export function parseClarificationSelection(value: unknown, message: string): ClarificationSelection | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") throw new Error("无效的澄清选择");
  const input = value as Record<string, unknown>;
  if (typeof input.clarification_id !== "string" || !input.clarification_id || input.clarification_id.length > 200
      || !Array.isArray(input.entities) || input.entities.length > 100) throw new Error("无效的澄清选择");
  const entities: ClarificationSelection["entities"] = [];
  for (const raw of input.entities) {
    if (!raw || typeof raw !== "object") throw new Error("无效的目录选择");
    const entity = raw as Record<string, unknown>;
    if ((entity.kind !== "metric" && entity.kind !== "organization")
        || typeof entity.code !== "string" || !entity.code || entity.code.length > 200
        || typeof entity.name !== "string" || !entity.name || entity.name.length > 500
        || !message.includes(entity.name)) throw new Error("目录选择与输入正文不一致，请重新选择");
    entities.push({ kind: entity.kind, code: entity.code, name: entity.name });
  }
  return { clarification_id: input.clarification_id, entities };
}

export function clarificationAnswer(message: string, selection?: ClarificationSelection): string | Record<string, unknown> {
  if (!selection?.entities.length) return message;
  const metrics = selection.entities.filter((item) => item.kind === "metric").map(({ code, name }) => ({ code, name }));
  const orgs = selection.entities.filter((item) => item.kind === "organization").map(({ name }) => name);
  return {
    set: { ...(metrics.length ? { metrics } : {}), ...(orgs.length ? { orgs } : {}) },
    catalog_selection_mode: "append", text: message,
  };
}
