/**
 * 可恢复的协作账本（Collaborative Recoverable Ledger）
 *
 * 设计要点：
 * - 每次令牌编辑产生一条修订（revision），带修订号 rev 与父修订 parent。
 * - 每个标签页是一个图层（layer），从主线某个修订分出；编辑先落在本层。
 * - 提交时做乐观并发校验：parent 必须等于主线当前 head，否则判为冲突，
 *   本层保留自己的值并列出冲突项，解决前发布暂停。
 * - 基础令牌更新后，沿引用链重算未覆盖的语义令牌与组件别名；显式品牌
 *   覆盖保留原值但标记待复核。
 * - 发布生成不可变快照，已发布包始终按原快照查看。
 * - 每次写入带操作号 op，操作先记为 pending，应用后标 applied；失败标
 *   failed。恢复时按操作号重试，已应用的操作跳过（幂等，不重复）。
 */

export type TokenCategory = 'color' | 'font' | 'spacing' | 'radius' | 'shadow' | 'component';

export type Token = {
  id: string;
  name: string;
  category: TokenCategory;
  value: string;
  ref?: string;
  themes: Record<string, string>;
  /** 每个主题是否为显式品牌覆盖（覆盖值不随基础令牌重算） */
  themeOverrides: Record<string, boolean>;
  usage: number;
  status: 'stable' | 'deprecated' | 'proposed';
  description: string;
  /** 最后一条触及该令牌的修订号 */
  rev: number;
  /** 基础令牌更新后，显式覆盖保留但待复核 */
  needsReview: boolean;
};

export type Revision = {
  rev: number;
  parent: number;
  op: string;
  tokenId: string;
  actor: string;
  ts: number;
  layerId: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  note: 'edit' | 'recalc' | 'merge' | 'rebase';
};

export type Conflict = {
  tokenId: string;
  tokenName: string;
  layer: { value: string; themes: Record<string, string> };
  main: { value: string; themes: Record<string, string> };
};

export type Layer = {
  id: string;
  name: string;
  /** 分出时的主线修订（基线） */
  baseRev: number;
  /** 本层最新修订 */
  headRev: number;
  status: 'active' | 'conflicted';
  conflicts: Conflict[];
  /** 本层工作副本 */
  tokens: Token[];
  /** 基线快照（用于判断本层是否有未提交的本地改动） */
  baseTokens: Token[];
};

export type Snapshot = {
  id: string;
  release: string;
  rev: number;
  ts: number;
  actor: string;
  tokens: Token[];
};

export type OpKind = 'commit' | 'snapshot';
export type OpStatus = 'pending' | 'applied' | 'failed';

export type OpRecord = {
  op: string;
  rev: number | null;
  status: OpStatus;
  kind: OpKind;
  ts: number;
  attempts: number;
  error?: string;
  payload?: unknown;
};

export type RecalcScope = {
  tokenId: string;
  tokenName: string;
  recalculated: string[];
  pendingReview: string[];
  ts: number;
};

export type LedgerState = {
  head: number;
  revisions: Revision[];
  tokens: Token[];
  layers: Record<string, Layer>;
  snapshots: Snapshot[];
  ops: Record<string, OpRecord>;
  recalcScopes: RecalcScope[];
  opSeq: number;
};

const STORAGE_KEY = 'yy63-token-ledger-v1';

export function isRef(value: string): boolean {
  return typeof value === 'string' && value.startsWith('{') && value.endsWith('}');
}

function refId(ref: string): string {
  return ref.slice(1, -1);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function snapshotToken(token: Token): Record<string, unknown> {
  return {
    value: token.value,
    ref: token.ref,
    themes: { ...token.themes },
    themeOverrides: { ...token.themeOverrides },
    needsReview: token.needsReview
  };
}

/** 沿引用链解析最终字面值（带环保护） */
function resolveRef(tokens: Token[], ref: string, theme: string, seen = new Set<string>()): string {
  if (!isRef(ref)) return ref;
  const id = refId(ref);
  if (seen.has(id)) return ref;
  seen.add(id);
  const token = tokens.find((item) => item.id === id);
  if (!token) return ref;
  const next = token.themes[theme] ?? token.value;
  if (isRef(next)) return resolveRef(tokens, next, theme, seen);
  return next;
}

/** 找出 rootId 的全部传递依赖（拓扑序：最近的在前） */
function findDependents(tokens: Token[], rootId: string): Token[] {
  const result: Token[] = [];
  const visited = new Set<string>([rootId]);
  let frontier = [rootId];
  while (frontier.length) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const token of tokens) {
        if (visited.has(token.id) || !token.ref) continue;
        if (token.ref === id) {
          visited.add(token.id);
          result.push(token);
          next.push(token.id);
        }
      }
    }
    frontier = next;
  }
  return result;
}

function tokenThemesEqual(a: Token, b: Token): boolean {
  if (a.value !== b.value) return false;
  const keys = new Set([...Object.keys(a.themes), ...Object.keys(b.themes)]);
  for (const key of keys) if (a.themes[key] !== b.themes[key]) return false;
  return true;
}

function computeConflicts(layer: Layer, mainline: Token[]): Conflict[] {
  const conflicts: Conflict[] = [];
  for (const layerToken of layer.tokens) {
    // 只列出本层相对基线的本地改动；主线前进导致的陈旧差异不算冲突
    const baseToken = layer.baseTokens.find((item) => item.id === layerToken.id);
    if (!baseToken || tokenThemesEqual(layerToken, baseToken)) continue;
    const mainToken = mainline.find((item) => item.id === layerToken.id);
    conflicts.push({
      tokenId: layerToken.id,
      tokenName: layerToken.name,
      layer: { value: layerToken.value, themes: { ...layerToken.themes } },
      main: { value: mainToken?.value ?? '', themes: { ...(mainToken?.themes ?? {}) } }
    });
  }
  return conflicts;
}

function initialTokens(): Token[] {
  const base = [
    { id: 'color.base.blue.600', name: '品牌主色 600', category: 'color', value: '#2864dc', themes: { light: '#2864dc', dark: '#6f96ff', ops: '#24786a', contrast: '#0b4dba' }, usage: 184, status: 'stable', description: '主操作、链接和重点状态' },
    { id: 'color.semantic.primary', name: '语义主色', category: 'color', value: '{color.base.blue.600}', ref: 'color.base.blue.600', themes: { light: '{color.base.blue.600}', dark: '{color.base.blue.400}', ops: '{color.base.green.600}', contrast: '{color.base.blue.800}' }, usage: 126, status: 'stable', description: '组件库统一主色别名', themeOverrides: { ops: true } },
    { id: 'color.base.blue.400', name: '品牌蓝 400', category: 'color', value: '#6f96ff', themes: { light: '#6f96ff', dark: '#6f96ff', ops: '#58a99a', contrast: '#2878e8' }, usage: 42, status: 'stable', description: '暗色主题主色' },
    { id: 'color.base.blue.800', name: '品牌蓝 800', category: 'color', value: '#0b4dba', themes: { light: '#0b4dba', dark: '#9ab9ff', ops: '#145c51', contrast: '#06358a' }, usage: 31, status: 'stable', description: '高对比主题主色' },
    { id: 'color.base.green.600', name: '运营绿 600', category: 'color', value: '#24786a', themes: { light: '#24786a', dark: '#54b2a0', ops: '#24786a', contrast: '#0d5a4d' }, usage: 67, status: 'proposed', description: '运营产品品牌替换色' },
    { id: 'color.text.primary', name: '正文主色', category: 'color', value: '#17202b', themes: { light: '#17202b', dark: '#f5f7fa', ops: '#152a25', contrast: '#000000' }, usage: 293, status: 'stable', description: '主要正文和标题' },
    { id: 'color.text.secondary', name: '正文次色', category: 'color', value: '#667582', themes: { light: '#667582', dark: '#a8b2bd', ops: '#62766f', contrast: '#303b46' }, usage: 211, status: 'stable', description: '辅助信息和说明' },
    { id: 'color.surface.canvas', name: '页面背景', category: 'color', value: '#f2f5f7', themes: { light: '#f2f5f7', dark: '#121821', ops: '#f1f6f4', contrast: '#ffffff' }, usage: 54, status: 'stable', description: '应用一级背景' },
    { id: 'font.family.sans', name: '无衬线字体', category: 'font', value: '"Noto Sans SC", sans-serif', themes: { light: '"Noto Sans SC", sans-serif', dark: '"Noto Sans SC", sans-serif', ops: '"Noto Sans SC", sans-serif', contrast: 'system-ui, sans-serif' }, usage: 388, status: 'stable', description: '产品界面默认真体' },
    { id: 'font.size.body', name: '正文字号', category: 'font', value: '14px', themes: { light: '14px', dark: '14px', ops: '14px', contrast: '16px' }, usage: 255, status: 'stable', description: '正文与表单文本' },
    { id: 'spacing.base.2', name: '基础间距 2', category: 'spacing', value: '8px', themes: { light: '8px', dark: '8px', ops: '8px', contrast: '8px' }, usage: 312, status: 'stable', description: '紧凑布局基础间距' },
    { id: 'radius.control', name: '控件圆角', category: 'radius', value: '6px', themes: { light: '6px', dark: '6px', ops: '4px', contrast: '4px' }, usage: 167, status: 'stable', description: '按钮、输入框和卡片' },
    { id: 'shadow.raised', name: '浮层阴影', category: 'shadow', value: '0 8px 28px rgba(22,35,48,.14)', themes: { light: '0 8px 28px rgba(22,35,48,.14)', dark: '0 8px 28px rgba(0,0,0,.42)', ops: '0 8px 28px rgba(21,54,45,.14)', contrast: '0 0 0 2px #303b46' }, usage: 36, status: 'stable', description: '菜单、弹窗和浮层' },
    { id: 'component.button.primary.bg', name: '主按钮背景', category: 'component', value: '{color.semantic.primary}', ref: 'color.semantic.primary', themes: { light: '{color.semantic.primary}', dark: '{color.semantic.primary}', ops: '{color.semantic.primary}', contrast: '{color.semantic.primary}' }, usage: 98, status: 'stable', description: '主要操作按钮' },
    { id: 'component.button.primary.text', name: '主按钮文字', category: 'component', value: '#ffffff', themes: { light: '#ffffff', dark: '#ffffff', ops: '#ffffff', contrast: '#ffffff' }, usage: 98, status: 'stable', description: '主要操作按钮文字' }
  ];
  return base.map((token) => ({
    ...token,
    themeOverrides: token.themeOverrides ?? {},
    rev: 1,
    needsReview: false
  })) as Token[];
}

function initialState(): LedgerState {
  return {
    head: 1,
    revisions: [],
    tokens: initialTokens(),
    layers: {},
    snapshots: [],
    ops: {},
    recalcScopes: [],
    opSeq: 0
  };
}

export type CommitResult =
  | { status: 'committed'; rev: number; recalcScope: RecalcScope | null; alreadyApplied?: boolean }
  | { status: 'conflict'; conflicts: Conflict[] };

export type RecoverResult = { recovered: string[]; skipped: string[]; failed: string[] };

export class Ledger {
  state: LedgerState;

  constructor() {
    this.state = this.load();
  }

  private load(): LedgerState {
    if (typeof localStorage === 'undefined') return initialState();
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as LedgerState;
        if (parsed && Array.isArray(parsed.tokens) && typeof parsed.head === 'number') return parsed;
      }
    } catch {
      // fall through to fresh state
    }
    return initialState();
  }

  persist() {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    }
  }

  // ---------- 图层 ----------

  ensureLayer(layerId: string, name = '品牌主题'): Layer {
    const existing = this.state.layers[layerId];
    if (existing) return existing;
    const layer: Layer = {
      id: layerId,
      name,
      baseRev: this.state.head,
      headRev: this.state.head,
      status: 'active',
      conflicts: [],
      tokens: clone(this.state.tokens),
      baseTokens: clone(this.state.tokens)
    };
    this.state.layers[layerId] = layer;
    this.persist();
    return layer;
  }

  getLayer(layerId: string): Layer | undefined {
    return this.state.layers[layerId];
  }

  /** 本层是否有未提交的本地改动（相对基线快照） */
  isDirty(layer: Layer): boolean {
    return layer.tokens.some((layerToken) => {
      const baseToken = layer.baseTokens.find((item) => item.id === layerToken.id);
      if (!baseToken) return true;
      return !tokenThemesEqual(layerToken, baseToken);
    });
  }

  // ---------- 操作号（幂等） ----------

  beginOp(kind: OpKind, payload?: unknown): OpRecord {
    const op = `op-${++this.state.opSeq}-${Date.now().toString(36)}`;
    const record: OpRecord = { op, rev: null, status: 'pending', kind, ts: Date.now(), attempts: 0, payload };
    this.state.ops[op] = record;
    this.persist();
    return record;
  }

  private hasRevision(op: string): boolean {
    return this.state.revisions.some((revision) => revision.op === op);
  }

  // ---------- 提交 ----------

  /**
   * 把本层对某个令牌的编辑提交到主线。
   * 乐观并发：parent（layer.baseRev）必须等于主线 head，否则冲突。
   */
  commitEdit(layerId: string, tokenId: string, patch: Partial<Token>, actor: string, op: string): CommitResult {
    // 幂等：同一操作号已应用过，直接返回已有结果，不重复写入
    if (this.hasRevision(op)) {
      const applied = this.state.revisions.find((revision) => revision.op === op)!;
      return { status: 'committed', rev: applied.rev, recalcScope: null, alreadyApplied: true };
    }

    const layer = this.ensureLayer(layerId);
    if (layer.status === 'conflicted') {
      return { status: 'conflict', conflicts: layer.conflicts };
    }

    const layerToken = layer.tokens.find((item) => item.id === tokenId);
    if (!layerToken) return { status: 'conflict', conflicts: [] };

    const before = snapshotToken(layerToken);
    Object.assign(layerToken, patch);
    if (patch.themes) layerToken.themes = { ...patch.themes };

    // 乐观并发校验
    if (layer.baseRev !== this.state.head) {
      layer.status = 'conflicted';
      layer.conflicts = computeConflicts(layer, this.state.tokens);
      this.persist();
      return { status: 'conflict', conflicts: layer.conflicts };
    }

    // 快进：应用到主线
    const rev = this.state.head + 1;
    const after = snapshotToken(layerToken);
    layerToken.rev = rev;
    this.state.revisions.push({
      rev,
      parent: layer.baseRev,
      op,
      tokenId,
      actor,
      ts: Date.now(),
      layerId,
      before,
      after,
      note: 'edit'
    });

    const mainToken = this.state.tokens.find((item) => item.id === tokenId);
    if (mainToken) {
      Object.assign(mainToken, after, { rev });
    } else {
      // 新令牌：写入主线
      this.state.tokens.push({ ...clone(layerToken), rev });
    }

    // 沿引用链重算未覆盖的语义令牌与组件别名
    const recalcScope = this.recalculate(tokenId, op, actor, rev);

    // 同步本层工作副本到主线（含重算结果），使本层无未提交改动
    layer.tokens = clone(this.state.tokens);
    layer.baseRev = this.state.head;
    layer.headRev = this.state.head;
    layer.baseTokens = clone(this.state.tokens);

    // 其他干净图层自动跟随主线；脏图层标记冲突
    for (const other of Object.values(this.state.layers)) {
      if (other.id === layerId) continue;
      if (this.isDirty(other)) {
        other.status = 'conflicted';
        other.conflicts = computeConflicts(other, this.state.tokens);
      } else {
        other.tokens = clone(this.state.tokens);
        other.baseRev = this.state.head;
        other.headRev = this.state.head;
        other.status = 'active';
        other.conflicts = [];
        other.baseTokens = clone(this.state.tokens);
      }
    }

    this.persist();
    return { status: 'committed', rev, recalcScope };
  }

  /** 基础令牌更新后，重算依赖它的语义令牌与组件别名 */
  private recalculate(changedTokenId: string, op: string, actor: string, startRev: number): RecalcScope {
    const changed = this.state.tokens.find((item) => item.id === changedTokenId);
    const dependents = findDependents(this.state.tokens, changedTokenId);
    const scope: RecalcScope = {
      tokenId: changedTokenId,
      tokenName: changed?.name ?? changedTokenId,
      recalculated: [],
      pendingReview: [],
      ts: Date.now()
    };

    let rev = startRev;
    for (const dep of dependents) {
      const before = snapshotToken(dep);
      let recalculated = false;

      for (const theme of Object.keys(dep.themes)) {
        if (dep.themeOverrides[theme]) {
          // 显式品牌覆盖：保留原值，标记待复核
          dep.needsReview = true;
          if (!scope.pendingReview.includes(dep.id)) scope.pendingReview.push(dep.id);
        } else if (isRef(dep.themes[theme])) {
          const resolved = resolveRef(this.state.tokens, dep.themes[theme], theme);
          if (resolved !== dep.themes[theme]) {
            dep.themes[theme] = resolved;
            recalculated = true;
          }
        }
      }

      // 默认（明亮）主题值
      if (!dep.themeOverrides['light'] && dep.ref && isRef(dep.ref)) {
        const resolved = resolveRef(this.state.tokens, dep.ref, 'light');
        if (resolved !== dep.value) {
          dep.value = resolved;
          recalculated = true;
        }
      }

      if (recalculated) {
        rev += 1;
        dep.rev = rev;
        this.state.revisions.push({
          rev,
          parent: rev - 1,
          op,
          tokenId: dep.id,
          actor,
          ts: Date.now(),
          layerId: 'system',
          before,
          after: snapshotToken(dep),
          note: 'recalc'
        });
        scope.recalculated.push(dep.id);
      }
    }

    this.state.head = rev;
    this.state.recalcScopes.push(scope);
    return scope;
  }

  // ---------- 冲突解决 ----------

  /**
   * 解决本层冲突。
   * strategy='rebase'：丢弃本层改动，接受主线（本层值被冲掉）。
   * strategy='merge'：保留本层值并合并入主线（本层覆盖值成为新主线）。
   */
  resolveConflict(layerId: string, strategy: 'rebase' | 'merge', actor: string, op: string): CommitResult {
    if (this.hasRevision(op)) {
      const applied = this.state.revisions.find((revision) => revision.op === op)!;
      return { status: 'committed', rev: applied.rev, recalcScope: null, alreadyApplied: true };
    }

    const layer = this.state.layers[layerId];
    if (!layer || layer.status !== 'conflicted') {
      return { status: 'conflict', conflicts: layer?.conflicts ?? [] };
    }

    if (strategy === 'rebase') {
      layer.tokens = clone(this.state.tokens);
      layer.baseTokens = clone(this.state.tokens);
      layer.baseRev = this.state.head;
      layer.headRev = this.state.head;
      layer.status = 'active';
      layer.conflicts = [];
      this.persist();
      return { status: 'committed', rev: this.state.head, recalcScope: null };
    }

    // merge：把本层分歧令牌写入主线
    const rev = this.state.head + 1;
    const merged: string[] = [];
    for (const conflict of layer.conflicts) {
      const layerToken = layer.tokens.find((item) => item.id === conflict.tokenId);
      const mainToken = this.state.tokens.find((item) => item.id === conflict.tokenId);
      if (!layerToken || !mainToken) continue;
      const before = snapshotToken(mainToken);
      const after = snapshotToken(layerToken);
      Object.assign(mainToken, after, { rev });
      merged.push(conflict.tokenId);
      this.state.revisions.push({
        rev,
        parent: this.state.head,
        op,
        tokenId: conflict.tokenId,
        actor,
        ts: Date.now(),
        layerId,
        before,
        after,
        note: 'merge'
      });
    }
    this.state.head = rev;
    layer.baseRev = rev;
    layer.headRev = rev;
    layer.status = 'active';
    layer.conflicts = [];

    // 合并后重算依赖
    const recalcScope = this.recalculateAfterMerge(merged, op, actor, rev);

    layer.baseTokens = clone(this.state.tokens);

    for (const other of Object.values(this.state.layers)) {
      if (other.id === layerId) continue;
      if (this.isDirty(other)) {
        other.status = 'conflicted';
        other.conflicts = computeConflicts(other, this.state.tokens);
      } else {
        other.tokens = clone(this.state.tokens);
        other.baseRev = this.state.head;
        other.headRev = this.state.head;
        other.status = 'active';
        other.conflicts = [];
        other.baseTokens = clone(this.state.tokens);
      }
    }

    this.persist();
    return { status: 'committed', rev, recalcScope };
  }

  private recalculateAfterMerge(mergedIds: string[], op: string, actor: string, startRev: number): RecalcScope | null {
    if (!mergedIds.length) return null;
    const scope: RecalcScope = {
      tokenId: mergedIds[0],
      tokenName: '合并覆盖',
      recalculated: [],
      pendingReview: [],
      ts: Date.now()
    };
    let rev = startRev;
    for (const id of mergedIds) {
      const sub = this.recalculate(id, op, actor, rev);
      rev = this.state.head;
      scope.recalculated.push(...sub.recalculated);
      scope.pendingReview.push(...sub.pendingReview);
    }
    this.state.recalcScopes.push(scope);
    return scope;
  }

  // ---------- 快照 ----------

  publishSnapshot(release: string, actor: string, op: string): Snapshot {
    const id = `snap-${release}-${Date.now().toString(36)}`;
    const snapshot: Snapshot = {
      id,
      release,
      rev: this.state.head,
      ts: Date.now(),
      actor,
      tokens: clone(this.state.tokens)
    };
    this.state.snapshots.push(snapshot);
    this.persist();
    return snapshot;
  }

  // ---------- 恢复 ----------

  /** 按操作号恢复未完成提交；已应用的操作跳过（幂等） */
  recover(actor: string): RecoverResult {
    const result: RecoverResult = { recovered: [], skipped: [], failed: [] };
    for (const record of Object.values(this.state.ops)) {
      if (record.status === 'applied') continue;
      if (record.rev != null && this.state.revisions.some((revision) => revision.op === record.op)) {
        record.status = 'applied';
        result.skipped.push(record.op);
        continue;
      }
      try {
        if (record.kind === 'commit') {
          const payload = record.payload as { layerId: string; tokenId: string; patch: Partial<Token> };
          const r = this.commitEdit(payload.layerId, payload.tokenId, payload.patch, actor, record.op);
          if (r.status === 'committed') {
            record.status = 'applied';
            record.rev = r.rev;
            result.recovered.push(record.op);
          } else {
            result.failed.push(record.op);
          }
        } else if (record.kind === 'snapshot') {
          const payload = record.payload as { release: string };
          const snapshot = this.publishSnapshot(payload.release, actor, record.op);
          record.status = 'applied';
          record.rev = null;
          result.recovered.push(record.op);
          void snapshot;
        }
      } catch (error) {
        record.status = 'failed';
        record.error = String(error);
        result.failed.push(record.op);
      }
    }
    this.persist();
    return result;
  }
}
