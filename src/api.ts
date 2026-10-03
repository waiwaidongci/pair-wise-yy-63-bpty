/**
 * 模拟服务端：基于修订号的乐观并发 + 操作号幂等 + 故障注入。
 * 账本本体在 ledger.ts（localStorage 持久化，跨标签页共享）。
 */
import { Ledger, type CommitResult, type Layer, type RecoverResult, type Snapshot, type Token } from './ledger';

export type { Token, Snapshot, CommitResult, RecoverResult, Layer };

const ledger = new Ledger();

/** 故障演练开关：开启后下一次写入必然失败（用于演示恢复） */
let faultArmed = false;
const faultListeners = new Set<(armed: boolean) => void>();

export function isFaultArmed(): boolean {
  return faultArmed;
}

export function setFaultArmed(armed: boolean) {
  faultArmed = armed;
  faultListeners.forEach((listener) => listener(armed));
}

export function onFaultChange(listener: (armed: boolean) => void): () => void {
  faultListeners.add(listener);
  return () => faultListeners.delete(listener);
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type LedgerSnapshot = {
  head: number;
  tokens: Token[];
  layers: ReturnType<Ledger['getLayer']>[];
  snapshots: Snapshot[];
  ops: Ledger['state']['ops'];
  recalcScopes: Ledger['state']['recalcScopes'];
  revisions: Ledger['state']['revisions'];
};

export async function fetchLedger(): Promise<LedgerSnapshot> {
  await delay(120);
  return {
    head: ledger.state.head,
    tokens: ledger.state.tokens,
    layers: Object.values(ledger.state.layers),
    snapshots: ledger.state.snapshots,
    ops: ledger.state.ops,
    recalcScopes: ledger.state.recalcScopes,
    revisions: ledger.state.revisions
  };
}

export async function fetchTokens() {
  await delay(120);
  return { release: 'DS 4.6.0-rc.2', themes: ['品牌蓝 · 明亮', '品牌蓝 · 暗色', '运营绿', '高对比度'], tokens: ledger.state.tokens };
}

/** 确保本标签页的图层在账本中存在（首次打开时创建） */
export async function ensureLayer(layerId: string, name: string): Promise<Layer> {
  await delay(60);
  return ledger.ensureLayer(layerId, name);
}

export type CommitPayload = {
  layerId: string;
  tokenId: string;
  patch: Partial<Token>;
  actor: string;
};

/** 提交一次编辑（带操作号；故障演练开启时写入失败，操作记为 failed） */
export async function commitEdit(payload: CommitPayload): Promise<CommitResult> {
  const record = ledger.beginOp('commit', payload);
  await delay(180);
  if (faultArmed) {
    faultArmed = false;
    faultListeners.forEach((listener) => listener(false));
    record.status = 'failed';
    record.error = 'write-failed: 模拟写入故障（操作未应用，可按操作号恢复）';
    ledger.persist();
    throw new Error(record.error);
  }
  try {
    const result = ledger.commitEdit(payload.layerId, payload.tokenId, payload.patch, payload.actor, record.op);
    if (result.status === 'committed') {
      record.status = 'applied';
      record.rev = result.rev;
    }
    ledger.persist();
    return result;
  } catch (error) {
    record.status = 'failed';
    record.error = String(error);
    ledger.persist();
    throw error;
  }
}

export type ResolvePayload = {
  layerId: string;
  strategy: 'rebase' | 'merge';
  actor: string;
};

export async function resolveConflict(payload: ResolvePayload): Promise<CommitResult> {
  const record = ledger.beginOp('commit', payload);
  await delay(160);
  if (faultArmed) {
    faultArmed = false;
    faultListeners.forEach((listener) => listener(false));
    record.status = 'failed';
    record.error = 'write-failed: 模拟写入故障（操作未应用，可按操作号恢复）';
    ledger.persist();
    throw new Error(record.error);
  }
  try {
    const result = ledger.resolveConflict(payload.layerId, payload.strategy, payload.actor, record.op);
    if (result.status === 'committed') {
      record.status = 'applied';
      record.rev = result.rev;
    }
    ledger.persist();
    return result;
  } catch (error) {
    record.status = 'failed';
    record.error = String(error);
    ledger.persist();
    throw error;
  }
}

export type SnapshotPayload = { release: string; actor: string };

export async function publishSnapshot(payload: SnapshotPayload): Promise<Snapshot> {
  const record = ledger.beginOp('snapshot', payload);
  await delay(200);
  if (faultArmed) {
    faultArmed = false;
    faultListeners.forEach((listener) => listener(false));
    record.status = 'failed';
    record.error = 'write-failed: 模拟写入故障（操作未应用，可按操作号恢复）';
    ledger.persist();
    throw new Error(record.error);
  }
  try {
    const snapshot = ledger.publishSnapshot(payload.release, payload.actor, record.op);
    record.status = 'applied';
    ledger.persist();
    return snapshot;
  } catch (error) {
    record.status = 'failed';
    record.error = String(error);
    ledger.persist();
    throw error;
  }
}

/** 按操作号恢复未完成提交；已应用的操作跳过（幂等，不重复） */
export async function recover(actor: string): Promise<RecoverResult> {
  await delay(220);
  return ledger.recover(actor);
}

export async function submitRelease(payload: { version: string; accepted: string[]; actor: string }) {
  await delay(220);
  return { accepted: true, releaseId: `DS-${payload.version}-${Date.now().toString().slice(-4)}` };
}
