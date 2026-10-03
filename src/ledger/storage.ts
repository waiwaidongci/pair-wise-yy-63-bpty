import { applyEdits, computeEffects, resolveCell } from './engine';
import {
  cellKey, tokenKind,
  type CellEffect, type EditOp, type ReleaseSnapshot, type Revision, type RootState, type Token
} from './types';
import { initialTokens } from './seed';

const LEDGER_KEY = 'yy63-ledger-v2';
const ACTOR_KEY = 'yy63-actor';

/** 模拟写入失败：URL 带 ?fail=概率（0~1），便于演示按操作号恢复 */
const FAIL_RATE = (() => {
  if (typeof location === 'undefined') return 0;
  const match = location.search.match(/[?&]fail=([\d.]+)/);
  return match ? Math.min(1, Math.max(0, parseFloat(match[1]))) : 0;
})();

const LATENCY_MS = 140;

function nowTs() { return Date.now(); }

export function getActor(): string {
  if (typeof localStorage === 'undefined') return '设计系统维护员';
  let actor = localStorage.getItem(ACTOR_KEY);
  if (!actor) {
    actor = `标签页 ${Math.floor(1000 + Math.random() * 9000)}`;
    localStorage.setItem(ACTOR_KEY, actor);
  }
  return actor;
}

function seed(): RootState {
  const tokens = structuredClone(initialTokens);
  const root: Revision = {
    rev: 0, parent: -1, opId: 'genesis', actor: 'system', tabId: 'system',
    ts: nowTs(), message: '初始品牌主题基线', edits: {}, effects: []
  };
  return { rev: 0, tokens, cellMeta: {}, revisions: [root], outbox: [], releases: [] };
}

function readRaw(): RootState {
  const raw = localStorage.getItem(LEDGER_KEY);
  if (!raw) {
    const state = seed();
    localStorage.setItem(LEDGER_KEY, JSON.stringify(state));
    return state;
  }
  return JSON.parse(raw) as RootState;
}

function writeRaw(state: RootState) {
  localStorage.setItem(LEDGER_KEY, JSON.stringify(state));
  // 同文档不会触发 storage 事件，手动广播给同页订阅者
  listeners.forEach((fn) => fn(state));
}

const listeners = new Set<(state: RootState) => void>();

/** 跨标签页订阅：storage 事件 + 同文档手动广播 */
export function subscribeLedger(fn: (state: RootState) => void): () => void {
  listeners.add(fn);
  const onStorage = (event: StorageEvent) => {
    if (event.key === LEDGER_KEY && event.newValue) fn(JSON.parse(event.newValue));
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(fn);
    window.removeEventListener('storage', onStorage);
  };
}

export function readLedger(): RootState {
  return readRaw();
}

export type CommitConflict = {
  cell: string;
  base: string;
  yours: string;
  theirs: string;
  kind: ReturnType<typeof tokenKind>;
};

export type CommitResult =
  | { ok: true; revision: Revision; rebased: boolean }
  | { ok: false; reason: 'conflict'; conflicts: CommitConflict[]; serverRev: number }
  | { ok: false; reason: 'duplicate'; revision: Revision }
  | { ok: false; reason: 'write-failed'; error: string };

/**
 * 提交一笔编辑操作（乐观并发）。
 * - expectedParent：标签页所基于的主线修订号；落后即冲突，本层值不动
 * - opId 幂等：已应用的操作不能重复
 * - 模拟写入失败：调用方应把 op 放进 outbox，稍后按操作号恢复
 */
export function commitEdit(op: EditOp, expectedParent: number): CommitResult {
  const state = readRaw();

  // 操作号幂等
  const existed = state.revisions.find((revision) => revision.opId === op.opId);
  if (existed) return { ok: false, reason: 'duplicate', revision: existed };

  let rebased = false;
  if (expectedParent !== state.rev) {
    const conflicts = detectConflicts(state, op, expectedParent);
    if (conflicts.length) {
      return { ok: false, reason: 'conflict', conflicts, serverRev: state.rev };
    }
    // 落后但无交集：自动快进到当前主线后提交（不同 cell 的并发编辑互不阻塞）
    rebased = true;
  }

  // 模拟网络/磁盘写入失败（状态不变，由 outbox 恢复）
  if (Math.random() < FAIL_RATE) {
    return { ok: false, reason: 'write-failed', error: `写入通道故障（模拟，${LATENCY_MS}ms 后无应答）` };
  }

  const prev = state.tokens;
  let next = applyEdits(prev, op.edits);
  next = applyOverrideEdits(next, op.overrideEdits ?? {});
  const effects = computeEffects(prev, next, op.edits, op.overrideEdits ?? {});
  // 基础值变更传导到已有显式覆盖：值保留，复核状态转为待复核
  const pendingCells = new Set(effects.filter((effect) => effect.type === 'review').map((effect) => effect.cell));
  if (pendingCells.size) {
    next = next.map((token) => {
      let clone: Token | null = null;
      Object.keys(token.overrides ?? {}).forEach((theme) => {
        if (pendingCells.has(cellKey(token.id, theme)) && token.overrides![theme].review !== 'pending') {
          clone ??= structuredClone(token);
          clone.overrides![theme] = { ...clone.overrides![theme], review: 'pending' };
        }
      });
      return clone ?? token;
    });
  }
  const revision: Revision = {
    rev: state.rev + 1,
    parent: state.rev,
    opId: op.opId,
    actor: op.actor,
    tabId: op.tabId,
    ts: nowTs(),
    message: op.message,
    edits: { ...op.edits },
    overrideEdits: { ...(op.overrideEdits ?? {}) },
    effects
  };

  const cellMeta = { ...state.cellMeta };
  Object.keys(op.edits).forEach((cell) => {
    cellMeta[cell] = { rev: revision.rev, opId: op.opId };
  });
  Object.keys(op.overrideEdits ?? {}).forEach((cell) => {
    cellMeta[cell] = { rev: revision.rev, opId: op.opId };
  });

  writeRaw({
    ...state,
    rev: revision.rev,
    tokens: next,
    cellMeta,
    revisions: [...state.revisions, revision],
    outbox: state.outbox.filter((entry) => entry.op.opId !== op.opId)
  });
  return { ok: true, revision, rebased };
}

/** 主线在 expectedParent 之后新增的修订里，是否碰过同一 cell */
function detectConflicts(state: RootState, op: EditOp, expectedParent: number) {
  const newer = state.revisions.filter((revision) => revision.rev > expectedParent);
  const touched = new Map<string, string>();
  newer.forEach((revision) => {
    Object.entries(revision.edits).forEach(([cell, value]) => touched.set(cell, value));
    Object.entries(revision.overrideEdits ?? {}).forEach(([cell, value]) => touched.set(cell, value ?? '（删除覆盖）'));
  });
  const conflicts: CommitConflict[] = [];
  const noteConflict = (cell: string, yours: string) => {
    const at = cell.indexOf('@');
    const token = cell.slice(0, at);
    const theme = cell.slice(at + 1);
    const base = valueAtRevision(state, token, theme, expectedParent);
    conflicts.push({ cell, base, yours, theirs: touched.get(cell)!, kind: tokenKind(token) });
  };
  Object.entries(op.edits).forEach(([cell, yours]) => {
    if (touched.has(cell)) noteConflict(cell, yours);
  });
  Object.entries(op.overrideEdits ?? {}).forEach(([cell, yours]) => {
    if (touched.has(cell)) noteConflict(cell, yours ?? '（删除覆盖）');
  });
  return conflicts;
}

/** 重放修订链到指定 rev，取某 cell 的原始值 */
function valueAtRevision(state: RootState, tokenId: string, theme: string, rev: number): string {
  let tokens: Token[] = structuredClone(initialTokens);
  state.revisions
    .filter((r) => r.rev > 0 && r.rev <= rev)
    .forEach((r) => { tokens = applyEdits(tokens, r.edits); });
  const token = tokens.find((item) => item.id === tokenId);
  return token ? (token.themes[theme] ?? token.value) : '';
}

/** 把提交失败的操作放入 outbox（write-failed 或冲突转存由 store 决定） */
export function enqueueOutbox(entry: {
  op: EditOp; parent: number; status: 'write-failed' | 'foreign'; error: string;
}): RootState {
  const state = readRaw();
  if (state.outbox.some((item) => item.op.opId === entry.op.opId)
    || state.revisions.some((r) => r.opId === entry.op.opId)) {
    return state;
  }
  const next = { ...state, outbox: [...state.outbox, { ...entry, attempts: 0, lastTry: nowTs() }] };
  writeRaw(next);
  return next;
}

export type RecoverResult =
  | { ok: true; revision: Revision; recovered: true }
  | { ok: true; alreadyApplied: true; revision: Revision }
  | { ok: false; reason: 'conflict'; conflicts: CommitConflict[]; serverRev: number }
  | { ok: false; reason: 'write-failed'; error: string };

/**
 * 按操作号恢复未完成提交：
 * - 已应用的操作不重复（幂等返回）
 * - 父修订仍是提交时的父修订（主线未分叉）则正常提交
 * - 主线已分叉则报冲突，由页面按冲突流程解决
 */
export function recoverOperation(opId: string, parentOverride?: number): RecoverResult {
  const state = readRaw();
  const entry = state.outbox.find((item) => item.op.opId === opId);
  const applied = state.revisions.find((r) => r.opId === opId);
  if (applied) {
    writeRaw({ ...state, outbox: state.outbox.filter((item) => item.op.opId !== opId) });
    return { ok: true, alreadyApplied: true, revision: applied };
  }
  if (!entry) return { ok: false, reason: 'write-failed', error: `outbox 中找不到操作 ${opId}` };

  const bumped: RootState = {
    ...state,
    outbox: state.outbox.map((item) => item.op.opId === opId
      ? { ...item, attempts: item.attempts + 1, lastTry: nowTs() }
      : item)
  };
  writeRaw(bumped);

  const parent = parentOverride ?? entry.parent;
  const result = commitEdit(entry.op, parent);
  if (result.ok) return { ok: true, recovered: true, revision: result.revision };
  if (result.reason === 'duplicate') {
    const clean = readRaw();
    writeRaw({ ...clean, outbox: clean.outbox.filter((item) => item.op.opId !== opId) });
    return { ok: true, alreadyApplied: true, revision: result.revision };
  }
  if (result.reason === 'conflict') {
    return { ok: false, reason: 'conflict', conflicts: result.conflicts, serverRev: result.serverRev };
  }
  return { ok: false, reason: 'write-failed', error: result.error };
}

/** 放弃一笔未完成提交 */
export function discardOutboxEntry(opId: string): RootState {
  const state = readRaw();
  const next = { ...state, outbox: state.outbox.filter((item) => item.op.opId !== opId) };
  writeRaw(next);
  return next;
}

/** 冲突解决后以新操作号重放该页剩余编辑（由 store 重新构造 op） */
export function commitResolved(op: EditOp, parent: number): CommitResult {
  return commitEdit(op, parent);
}

/** 覆盖复核：确认保留（reviewed）或清除覆盖回到引用层 */
export function resolveOverride(tokenId: string, theme: string, decision: 'keep' | 'drop', actor: string, tabId: string): CommitResult {
  const state = readRaw();
  const opId = `ovr-${tokenId}-${theme}-${state.rev + 1}`;
  const token = state.tokens.find((item) => item.id === tokenId);
  if (!token?.overrides?.[theme]) return { ok: false, reason: 'write-failed', error: '该单元没有待复核覆盖' };

  if (decision === 'drop') {
    const next = state.tokens.map((item) => {
      if (item.id !== tokenId) return item;
      const clone = structuredClone(item);
      delete clone.overrides![theme];
      return clone;
    });
    const revision: Revision = {
      rev: state.rev + 1, parent: state.rev, opId, actor, tabId, ts: nowTs(),
      message: `取消品牌覆盖 ${tokenId}@${theme}，回归引用层`, edits: {}, effects: []
    };
    writeRaw({ ...state, tokens: next, rev: revision.rev, revisions: [...state.revisions, revision] });
    return { ok: true, revision, rebased: false };
  }

  const next = state.tokens.map((item) => {
    if (item.id !== tokenId) return item;
    const clone = structuredClone(item);
    clone.overrides![theme] = { ...clone.overrides![theme], review: 'reviewed' };
    return clone;
  });
  const revision: Revision = {
    rev: state.rev + 1, parent: state.rev, opId, actor, tabId, ts: nowTs(),
    message: `复核确认保留品牌覆盖 ${tokenId}@${theme}`, edits: {}, effects: []
  };
  writeRaw({ ...state, tokens: next, rev: revision.rev, revisions: [...state.revisions, revision] });
  return { ok: true, revision, rebased: false };
}

export type ReleaseResult =
  | { ok: true; snapshot: ReleaseSnapshot }
  | { ok: false; reason: 'blocked'; error: string };

/**
 * 发布：冲突未解决或有待复核覆盖时暂停；通过则冻结解析快照。
 */
export function createRelease(input: {
  version: string; notes: string; actor: string; tabId: string;
  hasConflict: boolean; pendingReviewCount: number;
  cycles: string[]; invalidRefs: { token: string; ref: string }[]; contrastBad: boolean;
}): ReleaseResult {
  const state = readRaw();
  const problems: string[] = [];
  if (input.hasConflict) problems.push('存在未解决的并发冲突');
  if (input.pendingReviewCount > 0) problems.push(`${input.pendingReviewCount} 处品牌覆盖待复核`);
  if (input.cycles.length) problems.push('依赖图存在循环引用');
  if (input.invalidRefs.length) problems.push('存在无效引用');
  if (input.contrastBad) problems.push('对比度未达 WCAG AA');
  if (problems.length) return { ok: false, reason: 'blocked', error: problems.join('；') };

  const resolved: Record<string, string> = {};
  const overrides: Record<string, string> = {};
  const pendingOverrides: string[] = [];
  state.tokens.forEach((token) => {
    ['light', 'dark', 'ops', 'contrast'].forEach((theme) => {
      resolved[cellKey(token.id, theme)] = resolveCell(state, token.id, theme).resolved;
      const ov = token.overrides?.[theme];
      if (ov) {
        overrides[cellKey(token.id, theme)] = ov.value;
        if (ov.review === 'pending') pendingOverrides.push(cellKey(token.id, theme));
      }
    });
  });
  const checksum = checksumOf(resolved);
  const snapshot: ReleaseSnapshot = {
    id: `rel-${state.rev}`,
    version: input.version,
    releaseId: `DS-${input.version.replace(/\s+/g, '')}-${checksum.slice(0, 7)}`,
    rev: state.rev,
    ts: nowTs(),
    actor: input.actor,
    notes: input.notes,
    accepted: [],
    resolved,
    overrides,
    pendingOverrides,
    checksum
  };
  writeRaw({ ...state, releases: [...state.releases, snapshot] });
  return { ok: true, snapshot };
}

/** 已发布包按原快照查看（不随后续编辑变化） */
export function readSnapshot(releaseId: string): ReleaseSnapshot | undefined {
  return readRaw().releases.find((snapshot) => snapshot.releaseId === releaseId || snapshot.id === releaseId);
}

/** 应用显式品牌覆盖编辑（不可变）；null 删除覆盖 */
export function applyOverrideEdits(tokens: Token[], edits: Record<string, string | null>): Token[] {
  return tokens.map((token) => {
    let next: Token | null = null;
    Object.entries(edits).forEach(([cell, value]) => {
      const at = cell.indexOf('@');
      if (cell.slice(0, at) !== token.id) return;
      const theme = cell.slice(at + 1);
      if (!next) next = structuredClone(token);
      next.overrides = { ...(next.overrides ?? {}) };
      if (value === null) delete next.overrides[theme];
      else next.overrides[theme] = { value, review: 'reviewed' };
    });
    return next ?? token;
  });
}

export function checksumOf(map: Record<string, string>): string {
  const text = Object.keys(map).sort().map((key) => `${key}=${map[key]}`).join('|');
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
  }
  let hex = hash.toString(16);
  const text2 = JSON.stringify(text.length + ':' + text);
  let h2 = 0;
  for (let i = 0; i < text2.length; i += 1) h2 = ((h2 << 6) ^ h2 ^ text2.charCodeAt(i)) >>> 0;
  hex += h2.toString(16).padStart(8, '0');
  return hex.padEnd(15, '0');
}

export function newOpId(): string {
  return `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function effectsOf(state: RootState, sinceRev: number): CellEffect[] {
  return state.revisions.filter((r) => r.rev > sinceRev).flatMap((r) => r.effects);
}

/** 测试/调试用：清空账本 */
export function resetLedger() {
  localStorage.removeItem(LEDGER_KEY);
  writeRaw(seed());
}
