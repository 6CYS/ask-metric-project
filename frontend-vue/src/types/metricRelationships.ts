export type MetricRelationKind = "classification" | "composition" | "ratio"

export interface MetricRelationFields {
  kind: MetricRelationKind
  status: "draft" | "approved" | "retired"
  parent: string
  children: string[]
  source: string
}

export interface MetricRelation extends MetricRelationFields {
  id: string
  origin: "managed" | "topic"
  editable: boolean
  topic?: string
}

export interface MetricRelationshipIssue {
  id: string
  title: string
  message: string
  metric_codes: string[]
}

export interface MetricRelationList {
  items: MetricRelation[]
  revision: string
  warnings: string[]
  issues?: MetricRelationshipIssue[]
}

export type MetricRelationWrite = MetricRelationFields & { revision: string }
export type MetricRelationWriteResult = { item: MetricRelation; revision: string }
