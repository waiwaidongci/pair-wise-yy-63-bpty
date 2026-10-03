import { computed, ref, shallowRef } from 'vue';
import { defineStore } from 'pinia';
import {
  applyEdits, buildResolvedView, computeEffects, contrastRatio, directRefs,
  findCycleNodes, findInvalidRefs, resolveCell
} from './ledger/engine';
import {
  commitEdit, commitResolved, createRelease, discardOutboxEntry, enqueueOutbox,
  getActor, newOpId, readLedger, readSnapshot, recoverOperation,
  resolveOverride as commitOverride, subscribeLedger
} from './ledger/storage';
import {
  cellKey, isReference, parseCellKey, refTarget, tokenKind,
  THEMES, type CellEffect, type ChangeRequest, type ConflictEntry, type EditOp,
  type LayerEdit, type ReleaseSnapshot, type RootState, type Token
} from './ledger/types';

const SESSION_KEY = 'yy63-tab-session';
const SETTINGS_KEY = 'yy63-settings';

type OverrideDraft = { value: string | null; baseValue: string; opId: string; ts: number };
type NoticeKind = 'committed' | 'conflict' | 'failed' | 'recovered' | 'duplicate' | 'blocked' | 'released';

type Session = {
  tabId: string;
  baseRev: number;
  edits: LayerEdit[];
  overrideDrafts?: Record<string, OverrideDraft>;
  conflicts: ConflictEntry[];
  pendingOpId?: string;
  // 本页 UI 偏好（不跨标签页）
  activeTheme: string;
  selectedTokenId: string;
  search: string;
  category: string;
  /** 最近一次动作结果，用于页面状态条：冲突/重算范围/恢复结果 */
  lastNotice?: { id: string; kind: NoticeKind; text: string; ts: number };
};

const initialChanges: ChangeRequest[] = [
  { id: 'CR-412', title: '运营产品切换语义主色', requester: '运营设计组', scope: '4 个产品 · 238 处引用', impact: 86, status: '待评审', diff: { token: 'color.semantic.primary', before: '{color.base.blue.600}', after: '{color.base.green.600}' } },
  { id: 'CR-418', title: '高对比度正文尺寸调整', requester: '无障碍专项组', scope: '2 个产品 · 74 处引用', impact: 42, status: '待评审', diff: { token: 'font.size.body', before: '14px', after: '16px' } },
  { id: 'CR-423', title: '统一浮层圆角', requester: '组件维护组', scope: '12 个组件 · 36 处引用', impact: 28, status: '待评审', diff: { token: 'radius.control', before: '8px', after: '6px' } }
];

function loadSession(tabId: string): Session {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (raw) return JSON.parse(raw) as Session;
  } catch { /* ignore */ }
  return {
    tabId, baseRev: readLedger().rev, edits: [], conflicts: [],
    activeTheme: 'light', selectedTokenId: 'color.semantic.primary',
    search: '', category: '全部'
  };
}

function saveSession(session: Session) {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

function loadChanges(): ChangeRequest[] {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return (JSON.parse(raw) as { changes?: ChangeRequest[] }).changes ?? initialChanges;
  } catch { /* ignore */ }
  return initialChanges;
}

export const useTokenStore = defineStore('ledger', () => {
  // —— 共享主线（跨标签页）——
  const root = shallowRef<RootState>(readLedger());
  const actor = ref(getActor());
  const changes = ref<ChangeRequest[]>(loadChanges());

  // —— 本标签页层（会话级，不与他页互冲）——
  const session = ref<Session>(loadSession(crypto.randomUUID()));
  // 若本页落后于主线，先把基线对齐（未提交编辑仍保留）
  if (session.value.baseRev > root.value.rev) session.value.baseRev = root.value.rev;
  saveSession(session.value);

  // 已发布包查看：undefined 看当前主线，否则按发布时的冻结快照
  const viewingReleaseId = ref<string | undefined>(undefined);

  let unsubscribe: (() => void) | null = null;
  function bind() {
    unsubscribe = subscribeLedger((next) => {
      root.value = next;
    });
  }
  bind();

  const activeTheme = computed(() => session.value.activeTheme);
  const selectedTokenId = computed(() => session.value.selectedTokenId);
  const sessionSearch = computed(() => session.value.search);
  const sessionCategory = computed(() => session.value.category);

  function persistSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ changes: changes.value }));
  }
  function touchSession() {
    session.value = { ...session.value };
    saveSession(session.value);
  }
  function notify(kind: NoticeKind, text: string) {
    session.value.lastNotice = { id: newOpId(), kind, text, ts: Date.now() };
    saveSession(session.value);
    session.value = { ...session.value };
  }

  // ————— 解析视图（叠加本层未提交编辑）—————
  /** 用于计算的临时 state：主线令牌 + 本层编辑 + 本层覆盖草稿 */
  const stagedState = computed<RootState>(() => {
    const tokens = structuredClone(root.value.tokens);
    session.value.edits.forEach((edit) => {
      const { token, theme } = parseCellKey(edit.cell);
      const item = tokens.find((t) => t.id === token);
      if (item) {
        item.themes[theme] = edit.value;
        if (theme === 'light') item.value = edit.value;
      }
    });
    Object.entries(session.value.overrideDrafts ?? {}).forEach(([cell, draft]) => {
      const { token, theme } = parseCellKey(cell);
      const item = tokens.find((t) => t.id === token);
      if (!item || !draft) return;
      item.overrides = { ...(item.overrides ?? {}) };
      if (draft.value === null) delete item.overrides[theme];
      else item.overrides[theme] = { value: draft.value, review: 'reviewed' };
    });
    return { ...root.value, tokens };
  });

  const resolvedRows = computed(() => buildResolvedView(stagedState.value, activeTheme.value));
  const tokens = computed<Token[]>(() => stagedState.value.tokens);

  /** 当前查看模式（主线草稿视图或已发布冻结快照）下的统一行视图 */
  const displayRows = computed(() => {
    if (!viewingReleaseId.value) return resolvedRows.value;
    const snapshot = readSnapshot(viewingReleaseId.value);
    if (!snapshot) return resolvedRows.value;
    return root.value.tokens.map((token) => {
      const key = cellKey(token.id, activeTheme.value);
      const raw = token.themes[activeTheme.value] ?? token.value;
      const overrideValue = snapshot.overrides[key];
      return {
        id: token.id, name: token.name, category: token.category, kind: tokenKind(token.id),
        raw,
        value: snapshot.resolved[key] ?? '（未收录）',
        source: overrideValue ? 'override' as const
          : (isReference(raw) ? 'reference' as const : 'literal' as const),
        overridden: !!overrideValue,
        review: snapshot.pendingOverrides.includes(key) ? 'pending' as const : null,
        ref: isReference(raw) ? refTarget(raw) : undefined,
        meta: undefined, usage: token.usage, status: token.status, description: token.description
      };
    });
  });

  function overrideOf(tokenId: string, theme = activeTheme.value) {
    const snapshot = viewingReleaseId.value ? readSnapshot(viewingReleaseId.value) : undefined;
    if (snapshot) {
      const value = snapshot.overrides[cellKey(tokenId, theme)];
      return value ? {
        value,
        review: snapshot.pendingOverrides.includes(cellKey(tokenId, theme)) ? 'pending' as const : 'reviewed' as const
      } : null;
    }
    return tokens.value.find((t) => t.id === tokenId)?.overrides?.[theme] ?? null;
  }

  const selectedToken = computed<Token | undefined>(() =>
    tokens.value.find((token) => token.id === selectedTokenId.value));

  const filteredTokens = computed(() => {
    const query = session.value.search.toLowerCase();
    return displayRows.value.filter((row) => {
      const matchesSearch = !query || row.id.toLowerCase().includes(query) || row.name.includes(session.value.search);
      const matchesCategory = session.value.category === '全部' || row.category === session.value.category;
      return matchesSearch && matchesCategory;
    });
  });

  const conflictCells = computed(() => new Set(session.value.conflicts.map((conflict) => conflict.cell)));
  const draftCells = computed(() => new Set(session.value.edits.map((edit) => edit.cell)));

  function rowOf(tokenId: string) {
    return resolvedRows.value.find((row) => row.id === tokenId);
  }
  function rawValue(tokenId: string, theme = activeTheme.value): string {
    return stagedState.value.tokens.find((t) => t.id === tokenId)?.themes[theme]
      ?? stagedState.value.tokens.find((t) => t.id === tokenId)?.value
      ?? '';
  }
  /** 不含本层编辑的主线原始值 */
  function mainlineValue(tokenId: string, theme: string): string {
    return root.value.tokens.find((t) => t.id === tokenId)?.themes[theme]
      ?? root.value.tokens.find((t) => t.id === tokenId)?.value
      ?? '';
  }

  // ————— 本层编辑 —————
  function stageEdit(tokenId: string, value: string) {
    const cell = cellKey(tokenId, activeTheme.value);
    if (conflictCells.value.has(cell)) return; // 冲突 cell 解决前不允许再改
    const baseValue = mainlineValue(tokenId, activeTheme.value);
    // 原始值编辑与覆盖草稿互斥
    if (session.value.overrideDrafts?.[cell]) {
      const drafts = { ...session.value.overrideDrafts };
      delete drafts[cell];
      session.value.overrideDrafts = drafts;
    }
    const existing = session.value.edits.find((edit) => edit.cell === cell);
    if (existing) {
      if (value === existing.baseValue) {
        session.value.edits = session.value.edits.filter((edit) => edit.cell !== cell);
      } else {
        session.value.edits = session.value.edits.map((edit) =>
          edit.cell === cell ? { ...edit, value, ts: Date.now() } : edit);
      }
    } else if (value !== baseValue) {
      session.value.edits = [...session.value.edits, {
        cell, value, baseValue, opId: newOpId(), ts: Date.now(), kind: tokenKind(tokenId)
      }];
    }
    touchSession();
  }

  /** 指定主题暂存编辑（批量替换用） */
  function stageEditForTheme(tokenId: string, theme: string, value: string) {
    const cell = cellKey(tokenId, theme);
    if (conflictCells.value.has(cell)) return;
    const baseValue = mainlineValue(tokenId, theme);
    const existing = session.value.edits.find((edit) => edit.cell === cell);
    if (existing) {
      session.value.edits = session.value.edits.map((edit) =>
        edit.cell === cell ? { ...edit, value, ts: Date.now() } : edit);
    } else if (value !== baseValue) {
      session.value.edits = [...session.value.edits, {
        cell, value, baseValue, opId: newOpId(), ts: Date.now(), kind: tokenKind(tokenId)
      }];
    }
    touchSession();
  }

  function stageOverride(tokenId: string, value: string | null) {
    const cell = cellKey(tokenId, activeTheme.value);
    if (conflictCells.value.has(cell)) return;
    const token = root.value.tokens.find((t) => t.id === tokenId);
    const current = token?.overrides?.[activeTheme.value]?.value ?? null;
    if (value === current) return;
    // 覆盖编辑与原始值编辑互斥（同一 cell 同一层）
    session.value.edits = session.value.edits.filter((edit) => edit.cell !== cell);
    session.value.overrideDrafts = {
      ...(session.value.overrideDrafts ?? {}),
      [cell]: { value, baseValue: current ?? '（引用层）', opId: newOpId(), ts: Date.now() }
    };
    touchSession();
  }

  function discardDraft(cell: string) {
    session.value.edits = session.value.edits.filter((edit) => edit.cell !== cell);
    if (session.value.overrideDrafts) delete session.value.overrideDrafts[cell];
    session.value.conflicts = session.value.conflicts.filter((conflict) => conflict.cell !== cell);
    touchSession();
  }

  // ————— 提交：乐观并发，只有一条进入主线 —————
  function buildOp(message?: string): EditOp | null {
    const edits: Record<string, string> = {};
    const overrideEdits: Record<string, string | null> = {};
    session.value.edits.forEach((edit) => { edits[edit.cell] = edit.value; });
    Object.entries(session.value.overrideDrafts ?? {}).forEach(([cell, draft]) => {
      if (draft) overrideEdits[cell] = draft.value;
    });
    if (!Object.keys(edits).length && !Object.keys(overrideEdits).length) return null;
    return {
      opId: newOpId(), actor: actor.value, tabId: session.value.tabId, clientTs: Date.now(),
      message: message || defaultMessage(edits, overrideEdits), edits, overrideEdits
    };
  }

  function defaultMessage(edits: Record<string, string>, overrides: Record<string, string | null>) {
    const parts: string[] = [];
    if (Object.keys(edits).length) parts.push(`编辑 ${Object.keys(edits).length} 个单元`);
    if (Object.keys(overrides).length) parts.push(`品牌覆盖 ${Object.keys(overrides).length} 处`);
    return parts.join('，') || '令牌编辑';
  }

  function commit(message?: string) {
    const op = buildOp(message);
    if (!op) return;
    const parent = session.value.baseRev;
    const result = commitEdit(op, parent);
    if (result.ok) {
      applyCommitSuccess(op);
      const recompute = result.revision.effects.filter((e) => e.type === 'recompute').length;
      const review = result.revision.effects.filter((e) => e.type === 'review').length;
      notify('committed', `修订 r${result.revision.rev} 已进入主线（父 r${result.revision.parent}）`
        + (result.rebased ? '，本页基线落后但编辑无交集，已自动快进提交' : '')
        + `${recompute ? `，自动重算 ${recompute} 个下游单元` : ''}${review ? `，${review} 处品牌覆盖保留待复核` : ''}`);
      return;
    }
    if (result.reason === 'duplicate') {
      notify('duplicate', `操作 ${op.opId} 已应用为 r${result.revision.rev}，未重复提交`);
      return;
    }
    if (result.reason === 'conflict') {
      session.value.conflicts = result.conflicts.map((conflict) => ({ ...conflict, resolved: undefined }));
      // 本层值保留（edits 不清空）；发布门禁在解决前保持暂停
      notify('conflict', `提交被拒：主线已推进到 r${result.serverRev}，${result.conflicts.length} 个单元冲突，本层值已保留`);
      return;
    }
    // write-failed：入 outbox，按操作号可恢复
    enqueueOutbox({ op, parent, status: 'write-failed', error: result.error });
    session.value.pendingOpId = op.opId;
    notify('failed', `写入失败，操作 ${op.opId.slice(-6)} 已登记未完成提交，可按操作号恢复`);
  }

  /** 提交成功后：清掉已进入主线的草稿，基线推进到新修订；未触碰的草稿保留 */
  function applyCommitSuccess(op: EditOp) {
    const submitted = new Set([...Object.keys(op.edits), ...Object.keys(op.overrideEdits ?? {})]);
    session.value.edits = session.value.edits.filter((edit) => !submitted.has(edit.cell));
    if (session.value.overrideDrafts) {
      const drafts = { ...session.value.overrideDrafts };
      submitted.forEach((cell) => delete drafts[cell]);
      session.value.overrideDrafts = drafts;
    }
    session.value.conflicts = [];
    session.value.baseRev = root.value.rev;
    session.value.pendingOpId = undefined;
    touchSession();
  }

  // ————— 冲突解决 —————
  function resolveConflict(cell: string, choice: 'yours' | 'theirs') {
    session.value.conflicts = session.value.conflicts.map((conflict) =>
      conflict.cell === cell ? { ...conflict, resolved: choice } : conflict);
    if (choice === 'theirs') {
      // 放弃本层值：移除该 cell 草稿
      session.value.edits = session.value.edits.filter((edit) => edit.cell !== cell);
      if (session.value.overrideDrafts) delete session.value.overrideDrafts[cell];
    } else {
      // 保留本层值：把草稿基准更新为当前主线值，作为新操作提交
      const edit = session.value.edits.find((item) => item.cell === cell);
      const draft = session.value.overrideDrafts?.[cell];
      const theirs = session.value.conflicts.find((item) => item.cell === cell)?.theirs ?? '';
      if (edit) edit.baseValue = theirs;
      if (draft) draft.baseValue = theirs;
    }
    touchSession();
  }

  /** 全部冲突处理完后，把剩余本层编辑基于最新主线重放 */
  function commitAfterResolution(message?: string) {
    if (session.value.conflicts.some((conflict) => !conflict.resolved)) return;
    const op = buildOp(message ?? '冲突解决后重放本层编辑');
    if (!op) {
      session.value.baseRev = root.value.rev;
      session.value.conflicts = [];
      touchSession();
      return;
    }
    const result = commitResolved(op, root.value.rev);
    if (result.ok) {
      applyCommitSuccess(op);
      notify('committed', `冲突已解决，修订 r${result.revision.rev} 重放进入主线`);
    } else if (result.reason === 'conflict') {
      session.value.conflicts = result.conflicts.map((conflict) => ({ ...conflict }));
      notify('conflict', `主线又有新提交，仍有 ${result.conflicts.length} 个单元冲突`);
    } else if (result.reason === 'duplicate') {
      notify('duplicate', '该操作已应用，未重复提交');
    } else {
      enqueueOutbox({ op, parent: root.value.rev, status: 'write-failed', error: result.error });
      session.value.pendingOpId = op.opId;
      notify('failed', '重放写入失败，已登记可恢复');
    }
  }

  // ————— 恢复未完成提交 —————
  function recover(opId?: string) {
    const target = opId ?? session.value.pendingOpId;
    if (!target) {
      notify('recovered', '没有待恢复的未完成提交');
      return;
    }
    const result = recoverOperation(target);
    if (result.ok && 'alreadyApplied' in result) {
      session.value.pendingOpId = undefined;
      touchSession();
      notify('duplicate', `操作 ${target.slice(-6)} 此前已应用为 r${result.revision.rev}，恢复时未重复执行`);
      return;
    }
    if (result.ok) {
      // 恢复成功的 op 是 outbox 里的原始操作；若与本页草稿同源，清掉对应草稿
      const entry = root.value.outbox.find((item) => item.op.opId === target);
      void entry;
      session.value.pendingOpId = undefined;
      session.value.baseRev = root.value.rev;
      const applied = root.value.revisions.find((r) => r.opId === target);
      if (applied) {
        const cells = new Set([...Object.keys(applied.edits), ...Object.keys(applied.overrideEdits ?? {})]);
        session.value.edits = session.value.edits.filter((edit) => !cells.has(edit.cell));
      }
      touchSession();
      notify('recovered', `操作 ${target.slice(-6)} 恢复成功，已补记为 r${result.revision.rev}`);
      return;
    }
    if (result.reason === 'conflict') {
      session.value.conflicts = result.conflicts.map((conflict) => ({ ...conflict }));
      notify('conflict', `恢复发现分叉：主线已到 r${result.serverRev}，${result.conflicts.length} 个单元需要冲突解决`);
      return;
    }
    notify('failed', `恢复未成功：${result.error}（操作号保留，可重试）`);
  }

  function discardOutbox(opId: string) {
    discardOutboxEntry(opId);
    if (session.value.pendingOpId === opId) session.value.pendingOpId = undefined;
    touchSession();
    notify('recovered', `已放弃未完成提交 ${opId.slice(-6)}`);
  }

  // ————— 覆盖复核 —————
  function reviewOverride(tokenId: string, theme: string, decision: 'keep' | 'drop') {
    const result = commitOverride(tokenId, theme, decision, actor.value, session.value.tabId);
    if (result.ok) {
      session.value.baseRev = root.value.rev;
      touchSession();
      notify('committed', `覆盖复核完成，修订 r${result.revision.rev}`);
    } else {
      notify('failed', result.reason === 'write-failed' ? result.error : '覆盖复核提交未成功');
    }
  }

  // ————— 校验 —————
  const dependencyEdges = computed(() =>
    directRefs(stagedState.value.tokens).map((edge) => ({ from: edge.from, to: edge.to })));
  const cycleNodes = computed(() => findCycleNodes(stagedState.value.tokens));
  const invalidReferences = computed(() => findInvalidRefs(stagedState.value.tokens));
  const contrastIssues = computed(() => {
    const text = resolveCell(stagedState.value, 'color.text.primary', activeTheme.value).resolved;
    const surface = resolveCell(stagedState.value, 'color.surface.canvas', activeTheme.value).resolved;
    const ratio = contrastRatio(text, surface);
    if (ratio === null) return [];
    return ratio < 4.5
      ? [{ title: '正文与页面背景对比度不足', detail: `当前 ${ratio.toFixed(2)}:1，要求至少 4.5:1。` }]
      : [];
  });
  const pendingReviewCells = computed(() => {
    const list: { token: string; theme: string; value: string; underlying: string }[] = [];
    // 去掉全部 pending 覆盖后的 state，用来展示“底层重算成了什么”
    const strippedTokens = root.value.tokens.map((token) => {
      const pending = Object.entries(token.overrides ?? {}).some(([, ov]) => ov.review === 'pending');
      if (!pending) return token;
      const clone = structuredClone(token);
      Object.keys(clone.overrides ?? {}).forEach((theme) => {
        if (clone.overrides![theme].review === 'pending') delete clone.overrides![theme];
      });
      return clone;
    });
    const strippedState = { ...root.value, tokens: strippedTokens };
    root.value.tokens.forEach((token) => {
      Object.entries(token.overrides ?? {}).forEach(([theme, ov]) => {
        if (ov.review === 'pending') {
          list.push({
            token: token.id, theme, value: ov.value,
            underlying: resolveCell(strippedState, token.id, theme).resolved
          });
        }
      });
    });
    return list;
  });

  const hasConflict = computed(() => session.value.conflicts.length > 0);
  const publishBlocked = computed(() =>
    hasConflict.value
    || pendingReviewCells.value.length > 0
    || cycleNodes.value.length > 0
    || invalidReferences.value.length > 0
    || contrastIssues.value.length > 0
    || changes.value.some((c) => c.status === '待评审')
  );
  const blockReasons = computed(() => {
    const reasons: string[] = [];
    if (hasConflict.value) reasons.push(`${session.value.conflicts.length} 个并发冲突未解决`);
    if (pendingReviewCells.value.length) reasons.push(`${pendingReviewCells.value.length} 处品牌覆盖待复核`);
    if (cycleNodes.value.length) reasons.push('存在循环引用');
    if (invalidReferences.value.length) reasons.push('存在无效引用');
    if (contrastIssues.value.length) reasons.push('对比度未达 WCAG AA');
    if (changes.value.some((c) => c.status === '待评审')) reasons.push('存在待评审变更');
    return reasons;
  });

  const releaseReadiness = computed(() => {
    const base = 100 - cycleNodes.value.length * 25 - invalidReferences.value.length * 20
      - contrastIssues.value.length * 15 - (hasConflict.value ? 30 : 0)
      - pendingReviewCells.value.length * 5 - (changes.value.some((c) => c.status === '待评审') ? 10 : 0);
    return Math.max(0, base);
  });

  // ————— 发布快照 —————
  const releases = computed<ReleaseSnapshot[]>(() => root.value.releases);
  const viewingRelease = computed(() =>
    viewingReleaseId.value ? readSnapshot(viewingReleaseId.value) : undefined);

  function publish(version: string, notes: string) {
    const result = createRelease({
      version, notes, actor: actor.value, tabId: session.value.tabId,
      hasConflict: hasConflict.value, pendingReviewCount: pendingReviewCells.value.length,
      cycles: cycleNodes.value, invalidRefs: invalidReferences.value,
      contrastBad: contrastIssues.value.length > 0
    });
    if (!result.ok) {
      notify('blocked', `发布暂停：${result.error}`);
      return undefined;
    }
    viewingReleaseId.value = result.snapshot.releaseId;
    notify('released', `已按修订 r${result.snapshot.rev} 冻结快照 ${result.snapshot.releaseId}（校验和 ${result.snapshot.checksum.slice(0, 7)}）`);
    return result.snapshot;
  }
  function viewCurrent() { viewingReleaseId.value = undefined; }
  function viewRelease(releaseId: string) { viewingReleaseId.value = releaseId; }

  /** 快照视图里某 cell 的冻结值 */
  function snapshotValue(tokenId: string, theme = activeTheme.value): string {
    const snapshot = viewingRelease.value;
    if (!snapshot) return resolveCell(stagedState.value, tokenId, theme).resolved;
    return snapshot.resolved[cellKey(tokenId, theme)] ?? '（未收录）';
  }

  // ————— 修订账 —————
  const revisions = computed(() => root.value.revisions);
  const outbox = computed(() => root.value.outbox);
  const headRev = computed(() => root.value.rev);
  const baseRev = computed(() => session.value.baseRev);
  const behindCount = computed(() => root.value.rev - session.value.baseRev);
  const lastNotice = computed(() => session.value.lastNotice);
  const pendingOpId = computed(() => session.value.pendingOpId);

  /** 自本页拉取基线以来主线新增修订（用于"另一页改了什么"面板） */
  const incomingRevisions = computed(() =>
    root.value.revisions.filter((revision) => revision.rev > session.value.baseRev));

  const recomputePreview = computed(() => {
    // 提交前预览：当前草稿若提交会产生的重算/复核范围
    const op = buildOp();
    if (!op) return [];
    // 用引擎直接估算
    return previewEffects(root.value.tokens, op);
  });

  // ————— 变更评审（接受=本层编辑）—————
  function acceptChange(id: string) {
    const change = changes.value.find((item) => item.id === id);
    if (!change) return;
    stageEdit(change.diff.token, change.diff.after);
    change.status = '已接受';
    persistSettings();
  }
  function rejectChange(id: string) {
    const change = changes.value.find((item) => item.id === id);
    if (change) change.status = '已退回';
    persistSettings();
  }

  // ————— 基础 UI 状态 —————
  function selectToken(id: string) { session.value.selectedTokenId = id; touchSession(); }
  function setTheme(theme: string) { session.value.activeTheme = theme; touchSession(); }
  function setSearch(value: string) { session.value.search = value; touchSession(); }
  function setCategory(value: string) { session.value.category = value; touchSession(); }
  function rollbackDrafts() {
    session.value.edits = [];
    session.value.overrideDrafts = {};
    session.value.conflicts = [];
    session.value.pendingOpId = undefined;
    touchSession();
  }

  /** 放弃本页分叉基线，对齐主线（本层无编辑/冲突时使用） */
  function rebaseToHead() {
    session.value.baseRev = root.value.rev;
    session.value.conflicts = [];
    touchSession();
    notify('committed', `已对齐主线 r${root.value.rev}`);
  }

  const readOnly = computed(() => !!viewingReleaseId.value);

  return {
    // state
    actor, activeTheme, selectedTokenId, sessionSearch, sessionCategory,
    tokens, resolvedRows, displayRows, filteredTokens,
    selectedToken, changes, headRev, baseRev, behindCount, revisions, outbox,
    releases, viewingRelease, viewingReleaseId, lastNotice, pendingOpId,
    incomingRevisions, draftCells, conflictCells, recomputePreview, readOnly,
    session: computed(() => session.value),
    // validation
    dependencyEdges, cycleNodes, invalidReferences, contrastIssues,
    pendingReviewCells, publishBlocked, blockReasons, releaseReadiness,
    // actions
    selectToken, setTheme, setSearch, setCategory,
    rawValue, rowOf, snapshotValue, overrideOf, rebaseToHead,
    stageEdit, stageEditForTheme, stageOverride, discardDraft, commit, resolveConflict,
    commitAfterResolution, recover, discardOutbox, reviewOverride,
    acceptChange, rejectChange, rollbackDrafts,
    publish, viewCurrent, viewRelease,
    isRef: (value: string) => isReference(value),
    refOf: (value: string) => (isReference(value) ? refTarget(value) : undefined),
    themes: THEMES
  };
});

function previewEffects(prevTokens: Token[], op: EditOp): CellEffect[] {
  let next = applyEdits(prevTokens, op.edits);
  // 覆盖草稿用相同结构应用
  next = next.map((token) => {
    let clone: Token | null = null;
    Object.entries(op.overrideEdits ?? {}).forEach(([cell, value]) => {
      const { token: id, theme } = parseCellKey(cell);
      if (id !== token.id) return;
      clone ??= structuredClone(token);
      clone.overrides = { ...(clone.overrides ?? {}) };
      if (value === null) delete clone.overrides[theme];
      else clone.overrides[theme] = { value, review: 'reviewed' };
    });
    return clone ?? token;
  });
  return computeEffects(prevTokens, next, op.edits, op.overrideEdits ?? {});
}
