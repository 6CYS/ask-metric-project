/**
 * 原生会话仓库：以 JsonlSessionRepo 管理按认证身份隔离的会话目录。
 * 目录为稳定绝对路径 <dataDir>/native-v1/u_<身份哈希>/；owner 只从后端认证取得，
 * 哈希只用于避免把用户标识直接落盘为路径，不参与权限判断。
 * 单数据根只允许一个写实例（由部署独占锁保证），缓存淘汰只 close、不删除历史。
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  BACKGROUND_CONTEXT,
  JsonlSessionRepo,
  type Context,
  type JsonlSessionMetadata,
  type Session,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";

const REPO_SUBDIR = "native-v1";

export function ownerDirName(userId: string): string {
  return `u_${createHash("sha256").update(userId).digest("hex").slice(0, 32)}`;
}

/**
 * 数据根单写保护：同一数据目录只允许一个写实例。
 * 锁文件记录持有人 PID；持有人存活时拒绝启动，进程崩溃留下的僵死锁自动接管。
 */
export function acquireWriterLock(dataDir: string): () => void {
  const root = resolve(dataDir, REPO_SUBDIR);
  mkdirSync(root, { recursive: true });
  const lockPath = join(root, ".writer.lock");
  try {
    writeFileSync(lockPath, String(process.pid), { flag: "wx" });
  } catch {
    const holder = Number(readFileSync(lockPath, "utf8").trim());
    if (holder && isProcessAlive(holder)) {
      throw new Error(`会话数据根已被进程 ${holder} 占用，拒绝启动（单写保护）`);
    }
    writeFileSync(lockPath, String(process.pid));
  }
  return () => rmSync(lockPath, { force: true });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class NativeSessionStore {
  private readonly repos = new Map<string, JsonlSessionRepo>();
  /** 已打开会话缓存：JsonlSessionRepo 对重复 open 抛错，必须在本层去重复用 */
  private readonly openSessions = new Map<string, Session<JsonlSessionMetadata>>();
  private readonly rootDir: string;

  constructor(dataDir: string) {
    this.rootDir = resolve(dataDir, REPO_SUBDIR);
    mkdirSync(this.rootDir, { recursive: true });
  }

  /** 每个认证身份一个仓库与目录；仓库实例在进程内复用 */
  private repoFor(ownerUserId: string): JsonlSessionRepo {
    let repo = this.repos.get(ownerUserId);
    if (!repo) {
      const ownerRoot = resolve(this.rootDir, ownerDirName(ownerUserId));
      mkdirSync(ownerRoot, { recursive: true });
      repo = new JsonlSessionRepo({
        fileSystem: new NodeExecutionEnv({ cwd: ownerRoot }),
        sessionsRoot: ownerRoot,
      });
      this.repos.set(ownerUserId, repo);
    }
    return repo;
  }

  async list(ownerUserId: string, context: Context = BACKGROUND_CONTEXT): Promise<JsonlSessionMetadata[]> {
    return this.repoFor(ownerUserId).list(undefined, context);
  }

  async create(ownerUserId: string, context: Context = BACKGROUND_CONTEXT): Promise<Session<JsonlSessionMetadata>> {
    const session = await this.repoFor(ownerUserId).create({ cwd: this.rootDir }, context);
    this.openSessions.set(this.key(ownerUserId, session.metadata.id), session);
    return session;
  }

  async open(
    ownerUserId: string,
    metadata: JsonlSessionMetadata,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<Session<JsonlSessionMetadata>> {
    const key = this.key(ownerUserId, metadata.id);
    // 同进程内重复打开必须复用同一对象：仓库层对已打开会话直接抛错
    const cached = this.openSessions.get(key);
    if (cached) return cached;
    const session = await this.repoFor(ownerUserId).open(metadata, context);
    this.openSessions.set(key, session);
    return session;
  }

  private key(ownerUserId: string, sessionId: string): string {
    return `${ownerUserId}/${sessionId}`;
  }

  /** 关闭并从缓存移除；会话已被 harness 关闭时静默跳过 */
  async release(ownerUserId: string, sessionId: string, context: Context = BACKGROUND_CONTEXT): Promise<void> {
    const key = this.key(ownerUserId, sessionId);
    const session = this.openSessions.get(key);
    if (!session) return;
    this.openSessions.delete(key);
    await session.close(context).catch(() => undefined);
  }

  /** 按 id 查找当前身份的会话元数据；不存在返回 undefined，不泄露其他身份的会话 */
  async findMetadata(
    ownerUserId: string,
    sessionId: string,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<JsonlSessionMetadata | undefined> {
    const items = await this.list(ownerUserId, context);
    return items.find((item) => item.id === sessionId);
  }

  async delete(ownerUserId: string, metadata: JsonlSessionMetadata, context: Context = BACKGROUND_CONTEXT): Promise<void> {
    // 仓库要求删除前会话处于关闭状态
    await this.release(ownerUserId, metadata.id, context);
    return this.repoFor(ownerUserId).delete(metadata, context);
  }

  /** 进程关闭时关闭全部会话与仓库；只释放句柄，不删除任何历史数据 */
  async close(): Promise<void> {
    const sessions = [...this.openSessions.values()];
    this.openSessions.clear();
    await Promise.all(sessions.map((session) => session.close(BACKGROUND_CONTEXT).catch(() => undefined)));
    const repos = [...this.repos.values()];
    this.repos.clear();
    await Promise.all(repos.map((repo) => repo.close(BACKGROUND_CONTEXT).catch(() => undefined)));
  }
}
