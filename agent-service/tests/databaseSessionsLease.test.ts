import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { sessionMetadata } from "../src/databaseSessionStorage.js";
import { DatabaseSessionStore } from "../src/databaseSessions.js";
import type { SessionDatabase, SessionSql } from "../src/sessionDatabase.js";

it("租约事务未提交时不缓存写入会话，后续打开可重新取得租约", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "shared-session-lease-"));
  const row = {
    session_id: "lease-test",
    created_ms: 100,
    modified_ms: 100,
    lease_owner: null,
    lease_token: 0,
    lease_until_ms: 0,
  };
  const sql: SessionSql = {
    query: () => Promise.resolve([row]),
    execute: () => Promise.resolve(),
    now: () => Promise.resolve(100),
  };
  let attempts = 0;
  const database: SessionDatabase = {
    ...sql,
    async transaction(run) {
      attempts += 1;
      const result = await run(sql);
      if (attempts === 1) throw new Error("commit failed");
      return result;
    },
    close: () => Promise.resolve(),
  };
  const store = new DatabaseSessionStore(dataDir, database);
  const metadata = sessionMetadata(row);
  try {
    await expect(store.open("owner", metadata)).rejects.toThrow("commit failed");
    expect(store.isWriter(metadata.id)).toBe(false);
    await expect(store.open("owner", metadata)).resolves.toMatchObject({ metadata });
    expect(attempts).toBe(2);
    expect(store.isWriter(metadata.id)).toBe(true);
  } finally {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
