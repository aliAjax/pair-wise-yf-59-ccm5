// 测试前置：必须在导入 store 前执行，确保从 v2 初始空库开始
const mem = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => { mem.set(k, v); },
  removeItem: (k: string) => { mem.delete(k); },
  clear: () => mem.clear(),
  key: (index: number) => [...mem.keys()][index] ?? null,
  get length() { return mem.size; }
} as Storage;
