/** GoldenDB 使用 MySQL 协议；事务只覆盖存储操作，绝不跨模型调用持有行锁。 */
import { createPool, type PoolConnection } from "mysql2/promise";

export type SqlRow = Record<string, unknown>;
export interface SessionSql {
  query(sql: string, parameters?: readonly unknown[]): Promise<SqlRow[]>;
  execute(sql: string, parameters?: readonly unknown[]): Promise<void>;
  now(): Promise<number>;
}
export interface SessionDatabase extends SessionSql {
  transaction<T>(run: (sql: SessionSql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

function connectionSql(connection: PoolConnection): SessionSql {
  return {
    async query(sql, parameters = []) {
      const [rows] = await connection.query(sql, [...parameters]);
      return rows as SqlRow[];
    },
    async execute(sql, parameters = []) {
      await connection.query(sql, [...parameters]);
    },
    async now() {
      const [rows] = await connection.query(
        "SELECT CAST(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000 AS UNSIGNED) AS now_ms",
      );
      return Number((rows as SqlRow[])[0]!.now_ms);
    },
  };
}

export function mysqlSessionDatabase(url: string): SessionDatabase {
  const parsed = new URL(url.replace(/^mysql\+pymysql:/u, "mysql:"));
  if (parsed.protocol !== "mysql:" || !parsed.hostname || !parsed.pathname.slice(1))
    throw new Error("AGENT_SESSION_DATABASE_URL 必须指定 MySQL 协议、主机及数据库");
  // 不接受 URL 中未识别的驱动选项；TLS 等通过独立明确配置扩展，避免误以为已生效。
  for (const key of parsed.searchParams.keys()) {
    if (key !== "charset") throw new Error("AGENT_SESSION_DATABASE_URL 包含不支持的连接参数");
  }
  const pool = createPool({
    host: parsed.hostname,
    port: Number(parsed.port || 3306),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: decodeURIComponent(parsed.pathname.slice(1)),
    charset: "utf8mb4",
    connectionLimit: 5,
    waitForConnections: true,
    queueLimit: 100,
    connectTimeout: 10_000,
    supportBigNumbers: true,
    bigNumberStrings: true,
    enableKeepAlive: true,
  });
  async function using<T>(run: (sql: SessionSql) => Promise<T>): Promise<T> {
    const connection = await pool.getConnection();
    try {
      return await run(connectionSql(connection));
    } finally {
      connection.release();
    }
  }
  return {
    query: (sql, parameters) => using((client) => client.query(sql, parameters)),
    execute: (sql, parameters) => using((client) => client.execute(sql, parameters)),
    now: () => using((client) => client.now()),
    async transaction(run) {
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const result = await run(connectionSql(connection));
        await connection.commit();
        return result;
      } catch (error) {
        await connection.rollback().catch(() => undefined);
        throw error;
      } finally {
        connection.release();
      }
    },
    close: () => pool.end(),
  };
}
