import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import {
  commitEdit as apiCommitEdit,
  resolveConflict as apiResolveConflict,
  publishSnapshot as apiPublishSnapshot,
  recover as apiRecover,
  fetchLedger,
  ensureLayer as apiEnsureLayer,
  isFaultArmed,
  setFaultArmed,
  type CommitResult,
  type RecoverResult,
  type Snapshot,
  type Token
} from './api';
import type { Conflict, Layer, OpRecord, RecalcScope, Revision, TokenCategory } from './ledger';

export type { Token, Conflict, Layer, Snapshot, RecalcScope, Revision, OpRecord, TokenCategory };

const ACTOR = '设计系统维护员';
const LAYER_NAME = '品牌主题';

function layerId(): string {
  if (typeof sessionStorage === 'undefined') return 'layer-default';
  let id = sessionStorage.getItem('yy63-layer-id');
  if (!id) {
    id = `layer-${Math.random().toString(36).slice(2, 8)}`;
    sessionStorage.setItem('yy63-layer-id', id);
  }
  return id;
}

const currentLayerId = layerId();

export const useTokenStore = defineStore('tokens', {
  state: () => ({
    head: 1,
    tokens: [] as Token[],
    mainlineTokens: [] as Token[],
    layers: [] as Layer[],
    snapshots: [] as Snapshot[],
    ops: {} as Record<string, OpRecord>,
    recalcScopes: [] as RecalcScope[],
    revisions: [] as Revision[],
    currentLayerId,
    activeTheme: 'light',
    selectedTokenId: 'color.semantic.primary',
    search: '',
    category: '全部',
    releaseVersion: '4.6.0-rc.2',
    lastPublished: 'DS 4.5.2',
    locked: false,
    lastRecalcScope: null as RecalcScope | null,
    lastRecoverResult: null as RecoverResult | null,
    lastCommit: null as CommitResult | null,
    busy: false,
    faultArmed: isFaultArmed(),
    viewedSnapshotId: null as string | null,
    externalChange: false,
    initialized: false
  }),
  getters: {
    currentLayer(state): Layer | undefined {
      return state.layers.find((layer) => layer.id === state.currentLayerId);
    },
    selectedToken(state): Token | undefined {
      return state.tokens.find((token) => token.id === state.selectedTokenId);
    },
    /** 本层工作副本中的选中令牌（编辑落在本层） */
    selectedLayerToken(state): Token | undefined {
      const layer = state.layers.find((item) => item.id === state.currentLayerId);
      return layer?.tokens.find((token) => token.id === state.selectedTokenId);
    },
    filteredTokens(state): Token[] {
      const query = state.search.toLowerCase();
      return state.tokens.filter((token) => {
        const matchesSearch = !query || token.id.toLowerCase().includes(query) || token.name.includes(state.search);
        const matchesCategory = state.category === '全部' || token.category === state.category;
        return matchesSearch && matchesCategory;
      });
    },
    conflicts(state): Conflict[] {
      return this.currentLayer?.conflicts ?? [];
    },
    hasConflicts(state): boolean {
      return (this.currentLayer?.status === 'conflicted') && (this.currentLayer?.conflicts.length ?? 0) > 0;
    },
    /** 本层工作副本是否有未提交的本地改动（相对基线快照） */
    isDirty(state): boolean {
      const layer = state.layers.find((item) => item.id === state.currentLayerId);
      if (!layer) return false;
      return layer.tokens.some((token) => {
        const base = layer.baseTokens.find((item) => item.id === token.id);
        if (!base) return true;
        if (token.value !== base.value) return true;
        const keys = new Set([...Object.keys(token.themes), ...Object.keys(base.themes)]);
        for (const key of keys) if (token.themes[key] !== base.themes[key]) return true;
        return false;
      });
    },
    pendingOps(state): OpRecord[] {
      return Object.values(state.ops)
        .filter((op) => op.status !== 'applied')
        .sort((a, b) => b.ts - a.ts);
    },
    appliedOps(state): OpRecord[] {
      return Object.values(state.ops)
        .filter((op) => op.status === 'applied')
        .sort((a, b) => b.ts - a.ts);
    },
    staleLayer(state): boolean {
      const layer = this.currentLayer;
      return !!layer && layer.status === 'active' && layer.baseRev < state.head;
    },
    dependencyEdges(state) {
      return state.tokens.filter((token) => token.ref).map((token) => ({ from: token.ref!, to: token.id }));
    },
    cycleNodes(state): string[] {
      const graph = new Map<string, string>();
      state.tokens.filter((token) => token.ref).forEach((token) => graph.set(token.id, token.ref!));
      const cycle = new Set<string>();
      graph.forEach((_, start) => {
        const path: string[] = [];
        let current: string | undefined = start;
        while (current && !path.includes(current)) {
          path.push(current);
          current = graph.get(current);
        }
        if (current && path.includes(current)) path.slice(path.indexOf(current)).forEach((id) => cycle.add(id));
      });
      return [...cycle];
    },
    invalidReferences(state) {
      const ids = new Set(state.tokens.map((token) => token.id));
      return state.tokens.filter((token) => token.ref && !ids.has(token.ref));
    },
    contrastIssues(state) {
      const text = state.tokens.find((token) => token.id === 'color.text.primary');
      const surface = state.tokens.find((token) => token.id === 'color.surface.canvas');
      const values = [text?.themes[state.activeTheme], surface?.themes[state.activeTheme]].filter(Boolean) as string[];
      if (values.length < 2) return [];
      const ratio = contrastRatio(values[0], values[1]);
      return ratio < 4.5 ? [{ title: '正文与页面背景对比度不足', detail: `当前 ${ratio.toFixed(2)}:1，要求至少 4.5:1。` }] : [];
    },
    releaseReadiness(state): number {
      const base = 100 - this.cycleNodes.length * 25 - this.invalidReferences.length * 20 - this.contrastIssues.length * 15;
      return Math.max(0, base);
    },
    diffRows(state) {
      // 相对已发布基线（lastPublished）的差异
      const baseline = state.snapshots.find((snap) => snap.release === state.lastPublished) ?? state.snapshots[0];
      const baseTokens = baseline?.tokens ?? [];
      return state.tokens
        .filter((token) => {
          const base = baseTokens.find((item) => item.id === token.id);
          return !base || base.value !== token.value;
        })
        .map((token) => {
          const base = baseTokens.find((item) => item.id === token.id);
          return { id: token.id, before: base?.value ?? '新增', after: token.value, name: token.name };
        });
    },
    viewedSnapshot(state): Snapshot | undefined {
      return state.snapshots.find((snap) => snap.id === state.viewedSnapshotId);
    }
  },
  actions: {
    async init() {
      if (this.initialized) return;
      this.initialized = true;
      await this.refresh();
      await this.ensureCurrentLayer();
      this.bindCrossTab();
    },
    async ensureCurrentLayer() {
      const exists = this.layers.some((layer) => layer.id === this.currentLayerId);
      if (!exists) {
        await apiEnsureLayer(this.currentLayerId, LAYER_NAME);
        await this.refresh();
      }
    },
    async refresh() {
      const snapshot = await fetchLedger();
      this.head = snapshot.head;
      this.mainlineTokens = snapshot.tokens;
      this.snapshots = snapshot.snapshots;
      this.ops = snapshot.ops;
      this.recalcScopes = snapshot.recalcScopes;
      this.revisions = snapshot.revisions;
      this.layers = snapshot.layers.filter((layer): layer is Layer => !!layer);
      // 工作副本 = 本层的 tokens（与 layers 中本层引用同一副本，本地编辑即时可见）
      const layer = this.layers.find((item) => item.id === this.currentLayerId);
      this.tokens = layer?.tokens ?? snapshot.tokens;
      this.faultArmed = isFaultArmed();
      this.externalChange = false;
    },
    bindCrossTab() {
      if (typeof window === 'undefined') return;
      window.addEventListener('storage', (event) => {
        if (event.key === 'yy63-token-ledger-v1') {
          // 本层有未提交改动时不自动刷新，避免冲掉本地编辑；改为提示手动刷新
          if (this.isDirty) this.externalChange = true;
          else void this.refresh();
        }
      });
    },
    selectToken(id: string) {
      this.selectedTokenId = id;
    },
    setTheme(theme: string) {
      this.activeTheme = theme;
    },
    setSearch(value: string) { this.search = value; },
    setCategory(value: string) { this.category = value; },

    /** 在本层工作副本上本地编辑（不立即进入主线） */
    editLayerToken(id: string, patch: Partial<Token>) {
      const layer = this.layers.find((item) => item.id === this.currentLayerId);
      if (!layer) return;
      const token = layer.tokens.find((item) => item.id === id);
      if (!token) return;
      Object.assign(token, patch);
      if (patch.themes) token.themes = { ...patch.themes };
      // 标记该主题为显式覆盖（若直接改了值）
      if (patch.value !== undefined) {
        token.themeOverrides = { ...token.themeOverrides, [this.activeTheme]: true };
      }
    },

    /** 把本层编辑提交到主线 */
    async commitEdit(tokenId: string, patch: Partial<Token>): Promise<CommitResult> {
      this.busy = true;
      try {
        const result = await apiCommitEdit({ layerId: this.currentLayerId, tokenId, patch, actor: ACTOR });
        this.lastCommit = result;
        if (result.status === 'committed') {
          if (result.recalcScope) this.lastRecalcScope = result.recalcScope;
        }
        await this.refresh();
        return result;
      } finally {
        this.busy = false;
      }
    },

    /** 解决本层冲突 */
    async resolveConflict(strategy: 'rebase' | 'merge') {
      this.busy = true;
      try {
        const result = await apiResolveConflict({ layerId: this.currentLayerId, strategy, actor: ACTOR });
        this.lastCommit = result;
        if (result.status === 'committed' && result.recalcScope) {
          this.lastRecalcScope = result.recalcScope;
        }
        await this.refresh();
      } finally {
        this.busy = false;
      }
    },

    /** 按操作号恢复未完成提交 */
    async recover() {
      this.busy = true;
      try {
        const result = await apiRecover(ACTOR);
        this.lastRecoverResult = result;
        await this.refresh();
      } finally {
        this.busy = false;
      }
    },

    /** 发布快照 */
    async publishSnapshot() {
      this.busy = true;
      try {
        const snapshot = await apiPublishSnapshot({ release: this.releaseVersion, actor: ACTOR });
        this.locked = true;
        this.lastPublished = snapshot.release;
        await this.refresh();
        return snapshot;
      } finally {
        this.busy = false;
      }
    },

    setFaultArmed(armed: boolean) {
      setFaultArmed(armed);
      this.faultArmed = armed;
    },

    viewSnapshot(id: string) {
      this.viewedSnapshotId = id;
    },
    closeSnapshot() {
      this.viewedSnapshotId = null;
    }
  }
});

function contrastRatio(a: string, b: string) {
  const luminance = (hex: string) => {
    const clean = hex.replace('#', '');
    if (clean.length !== 6) return .5;
    const channels = [0, 2, 4].map((index) => parseInt(clean.slice(index, index + 2), 16) / 255).map((value) => value <= .03928 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2];
  };
  const l1 = luminance(a);
  const l2 = luminance(b);
  return (Math.max(l1, l2) + .05) / (Math.min(l1, l2) + .05);
}
