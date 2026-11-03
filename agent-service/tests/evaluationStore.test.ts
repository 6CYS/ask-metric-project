import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EvaluationStore } from "../src/evaluation/store.js";

const input = {
  name: "隔离问题集",
  description: "仅测试存储边界",
  groups: [
    { id: "g1", name: "第一组", turns: [{ id: "q1", question: "第一问", expected: "核对条件" }] },
  ],
};

describe("EvaluationStore", () => {
  let root: string;
  let store: EvaluationStore;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "evaluation-store-"));
    store = new EvaluationStore(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("persists an owner-isolated dataset and rejects stale edits", () => {
    const saved = store.createDataset("owner-a", input);
    const reopened = new EvaluationStore(root);
    expect(reopened.getDataset("owner-a", saved.id).name).toBe("隔离问题集");
    expect(reopened.listDatasets("owner-b")).toEqual([]);
    expect(() => reopened.getDataset("owner-b", saved.id)).toThrow("问题集不存在");
    const updated = reopened.updateDataset("owner-a", saved.id, 1, { ...input, name: "新版本" });
    expect(updated.version).toBe(2);
    expect(() => reopened.updateDataset("owner-a", saved.id, 1, input)).toThrow("版本已变化");
    expect(reopened.getDataset("owner-a", saved.id).name).toBe("新版本");
    expect(readdirSync(join(root, "evaluation-v1"))).not.toContain("owner-a");
    const entries = readdirSync(join(root, "evaluation-v1"), { recursive: true });
    expect(entries.some((entry) => String(entry).endsWith(".tmp"))).toBe(false);
  });

  it("does not allow an API caller to escape the storage directory", () => {
    expect(() => store.getDataset("owner-a", "../../secret")).toThrow();
    expect(() => store.updateDataset("owner-a", "../secret", 1, input)).toThrow();
    expect(store.listDatasets("owner-a")).toEqual([]);
  });

  it("rejects duplicate question identities and more than 100 turns before writing", () => {
    expect(() =>
      store.createDataset("owner-a", { ...input, groups: [input.groups[0], input.groups[0]] }),
    ).toThrow();
    expect(() =>
      store.createDataset("owner-a", {
        ...input,
        groups: [
          {
            id: "g1",
            name: "组",
            turns: Array.from({ length: 101 }, (_, index) => ({
              id: `q${index}`,
              question: "问题",
              expected: "",
            })),
          },
        ],
      }),
    ).toThrow("100");
    expect(() =>
      store.createDataset("owner-a", {
        ...input,
        groups: [{ id: "g", name: "组", turns: [{ id: "q", question: " ", expected: "" }] }],
      }),
    ).toThrow();
    expect(store.listDatasets("owner-a")).toEqual([]);
  });

  it("returns independent snapshots rather than writable references", () => {
    const saved = store.createDataset("owner-a", input);
    saved.name = "篡改返回值";
    const persisted = store.getDataset("owner-a", saved.id);
    expect(persisted.name).toBe("隔离问题集");
    const owner = readdirSync(join(root, "evaluation-v1"))[0];
    expect(owner).toBeTruthy();
    const files = readdirSync(join(root, "evaluation-v1", String(owner), "datasets"));
    expect(
      JSON.parse(
        readFileSync(
          join(root, "evaluation-v1", String(owner), "datasets", String(files[0])),
          "utf8",
        ),
      ),
    ).toMatchObject({ version: 1 });
  });
});
