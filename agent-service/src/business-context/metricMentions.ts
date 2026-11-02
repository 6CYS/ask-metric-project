import type {FieldResolution} from "./types.js";

export interface MetricMention {text: string; start: number; end: number; resolution: FieldResolution; group?: {id: string}}
export interface MetricMentions {mentions: MetricMention[]; status?: "temporary_error"}
