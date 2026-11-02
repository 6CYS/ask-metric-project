import {createHash} from "node:crypto";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export const businessKey = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
