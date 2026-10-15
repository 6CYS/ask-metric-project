-- REVIEW ONLY: generated offline with non-secret test settings; no connection or apply.
-- FROM revision 0005_metric_source_structure must match the deployed application database.
-- Running upgrade 0005_metric_source_structure -> 0006_analysis_constraints

CREATE TABLE analysis_constraint_snapshots (
    id VARCHAR(128) NOT NULL,
    conversation_id VARCHAR(128) NOT NULL,
    owner_user_id VARCHAR(128) NOT NULL,
    analysis_id VARCHAR(128) NOT NULL,
    constraint_version INTEGER NOT NULL,
    snapshot_hash VARCHAR(64) NOT NULL,
    snapshot_json JSON NOT NULL,
    status VARCHAR(32) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT now(),
    PRIMARY KEY (id),
    FOREIGN KEY(conversation_id) REFERENCES chat_conversations (id) ON DELETE CASCADE,
    CONSTRAINT uq_analysis_constraint_version UNIQUE (conversation_id, analysis_id, constraint_version),
    CONSTRAINT analysis_constraint_version_check CHECK (constraint_version >= 1)
);

CREATE INDEX ix_analysis_constraints_owner ON analysis_constraint_snapshots (owner_user_id, conversation_id);

UPDATE backend_next_goldendb_alembic_version SET version_num='0006_analysis_constraints' WHERE backend_next_goldendb_alembic_version.version_num = '0005_metric_source_structure';

