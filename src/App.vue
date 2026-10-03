<script setup lang="ts">
import { computed, h, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { MessagePlugin } from 'tdesign-vue-next';
import {
  AddIcon, ArrowRightIcon, HistoryIcon, LockOnIcon, RefreshIcon, SearchIcon, SwapIcon
} from 'tdesign-icons-vue-next';
import TokenEditor from './components/TokenEditor.vue';
import { useTokenStore } from './store';
import { cellKey, parseCellKey, tokenKind, type CellEffect, type Token } from './ledger/types';

const RefreshButtonIcon = () => h(RefreshIcon);
const SearchInputIcon = () => h(SearchIcon);
const LockButtonIcon = () => h(LockOnIcon);

const route = useRoute();
const router = useRouter();
const store = useTokenStore();

const nav = [
  { path: '/', label: '令牌工作区', icon: 'token' },
  { path: '/graph', label: '依赖与校验', icon: 'control-platform' },
  { path: '/review', label: '变更评审', icon: 'git-commit' },
  { path: '/publish', label: '协作账与发布', icon: 'send' }
];

const pageTitle = computed(() => nav.find((item) => item.path === route.path)?.label ?? '令牌工作区');
const themeOptions = [
  { label: '明亮模式', value: 'light' },
  { label: '暗色模式', value: 'dark' },
  { label: '运营模式', value: 'ops' },
  { label: '高对比度', value: 'contrast' }
];
const themeName = (t: string) => themeOptions.find((o) => o.value === t)?.label ?? t;
const categories = computed(() => ['全部', ...new Set(store.tokens.map((token) => token.category))]);

const selected = computed<Token | undefined>(() => store.selectedToken);
const selectedRow = computed(() => store.displayRows.find((row) => row.id === store.selectedTokenId));
const selectedOverride = computed(() => (store.selectedTokenId ? store.overrideOf(store.selectedTokenId) : null));
const conflictOfCell = (cell: string) => store.session.conflicts.find((c) => c.cell === cell);
const selectedConflict = computed(() => conflictOfCell(cellKey(store.selectedTokenId, store.activeTheme)));

const editorText = ref('{}');
function syncEditorText() {
  const token = selected.value;
  if (!token) { editorText.value = '{}'; return; }
  editorText.value = JSON.stringify({
    cell: cellKey(token.id, store.activeTheme),
    kind: tokenKind(token.id),
    baseRev: store.baseRev,
    headRev: store.headRev,
    value: store.rawValue(token.id, store.activeTheme),
    themes: Object.fromEntries(
      (['light', 'dark', 'ops', 'contrast'] as const).map((t) => [t, store.rawValue(token.id, t)])
    ),
    override: store.overrideOf(token.id, store.activeTheme)
  }, null, 2);
}
watch([() => store.selectedTokenId, () => store.activeTheme, () => store.headRev, () => store.session.edits, () => store.session.overrideDrafts], syncEditorText, { immediate: true, deep: false });

function updateEditor(value: string) {
  if (store.readOnly) return;
  try {
    const parsed = JSON.parse(value) as { value?: string };
    if (typeof parsed.value === 'string') store.stageEdit(store.selectedTokenId, parsed.value);
  } catch {
    // 保留无效 JSON 的可编辑状态
  }
}

const valueDraft = ref('');
function syncValueDraft() {
  const cell = cellKey(store.selectedTokenId, store.activeTheme);
  const edit = store.session.edits.find((e) => e.cell === cell);
  valueDraft.value = edit ? edit.value : store.rawValue(store.selectedTokenId, store.activeTheme);
}
watch([() => store.selectedTokenId, () => store.activeTheme, () => store.headRev, () => store.session.edits], syncValueDraft, { immediate: true });
function commitValueInput() {
  if (store.readOnly) return;
  if (valueDraft.value !== store.rawValue(store.selectedTokenId, store.activeTheme)) {
    store.stageEdit(store.selectedTokenId, valueDraft.value);
  }
}

const overrideDraftText = ref('');
watch([() => store.selectedTokenId, () => store.activeTheme, () => store.headRev], () => {
  overrideDraftText.value = store.overrideOf(store.selectedTokenId, store.activeTheme)?.value ?? '';
}, { immediate: true });
function saveOverride() {
  if (!overrideDraftText.value.trim()) return;
  store.stageOverride(store.selectedTokenId, overrideDraftText.value.trim());
  MessagePlugin.info('品牌覆盖已进入本层草稿，提交后生效');
}
function dropOverrideDraft() {
  store.stageOverride(store.selectedTokenId, null);
}

function commitAll() {
  store.commit();
}

// 批量替换：逐 cell 进入本层草稿（直接按主题暂存，不切换全局主题）
const batchFrom = ref('');
const batchTo = ref('');
function batchReplace() {
  if (!batchFrom.value || !batchTo.value) return;
  let count = 0;
  const themeBefore = store.activeTheme;
  store.tokens.forEach((token) => {
    (['light', 'dark', 'ops', 'contrast'] as const).forEach((theme) => {
      if (token.themes[theme] === batchFrom.value) {
        store.stageEditForTheme(token.id, theme, batchTo.value);
        count += 1;
      }
    });
  });
  void themeBefore;
  MessagePlugin.success(`已把 ${count} 处匹配值放入本层草稿，提交后进入主线`);
}

// —— 依赖图布局：基础 → 语义 → 组件 三列 ——
const graphNodes = computed(() => {
  const columns: Record<string, Token[]> = { base: [], semantic: [], component: [] };
  store.tokens.filter((token) => {
    const hasRef = Object.values(token.themes).some((v) => v.startsWith('{') && v.endsWith('}'));
    return hasRef || store.dependencyEdges.some((edge) => edge.from === token.id);
  }).forEach((token) => columns[tokenKind(token.id)].push(token));
  const xOf = { base: 120, semantic: 410, component: 700 };
  const nodes: (Token & { x: number; y: number })[] = [];
  Object.entries(columns).forEach(([kind, list]) => {
    list.forEach((token, index) => {
      nodes.push({ ...token, x: xOf[kind as keyof typeof xOf], y: 60 + index * 95 });
    });
  });
  return nodes;
});
const graphEdges = computed(() => store.dependencyEdges.map((edge) => {
  const from = graphNodes.value.find((node) => node.id === edge.from);
  const to = graphNodes.value.find((node) => node.id === edge.to);
  return from && to ? { ...edge, from, to } : null;
}).filter(Boolean) as { from: Token & { x: number; y: number }; to: Token & { x: number; y: number } }[]);

// 主线新修订带来的重算/复核范围（用于图和高亮）
const incomingEffects = computed<CellEffect[]>(() =>
  store.incomingRevisions.flatMap((revision) => revision.effects));
const effectCellMap = computed(() => new Map(incomingEffects.value.map((effect) => [effect.cell, effect])));
const previewCellMap = computed(() => new Map(store.recomputePreview.map((effect) => [effect.cell, effect])));
const pendingSet = computed(() => new Set(store.pendingReviewCells.map((p) => `${p.token}@${p.theme}`)));

function nodeClass(node: Token & { x: number; y: number }) {
  const cell = cellKey(node.id, store.activeTheme);
  return {
    cycle: store.cycleNodes.includes(node.id),
    selected: node.id === store.selectedTokenId,
    recompute: effectCellMap.value.get(cell)?.type === 'recompute' || previewCellMap.value.get(cell)?.type === 'recompute',
    review: effectCellMap.value.get(cell)?.type === 'review' || pendingSet.value.has(cell),
    draft: store.draftCells.has(cell),
    conflict: store.conflictCells.has(cell)
  };
}

// —— 发布 ——
const releaseVersion = ref(`4.6.0-r${store.headRev}`);
const releaseNotes = ref('更新语义主色、统一控件圆角，并修复暗色主题正文对比度。');
const releaseDialog = ref(false);
const releaseResult = ref('');
function publish() {
  const snapshot = store.publish(releaseVersion.value || `4.6.0-r${store.headRev}`, releaseNotes.value);
  if (snapshot) {
    releaseResult.value = `发布标识 ${snapshot.releaseId} · 修订 r${snapshot.rev} · 校验和 ${snapshot.checksum.slice(0, 7)}`;
    releaseDialog.value = true;
    MessagePlugin.success('主题版本已按当前修订冻结快照');
  } else {
    MessagePlugin.warning(`发布暂停：${store.blockReasons.join('；')}`);
  }
}

// 当前主线相对最近一次发布快照的差异
const diffRows = computed(() => {
  const snapshot = store.releases[store.releases.length - 1];
  if (!snapshot) {
    return store.displayRows.map((row) => ({
      id: row.id, name: row.name, before: '（未发布）', after: row.value, changed: true
    })).filter((row) => row.after !== '（未收录）');
  }
  return store.displayRows.map((row) => {
    const before = snapshot.resolved[cellKey(row.id, store.activeTheme)] ?? '（未收录）';
    return { id: row.id, name: row.name, before, after: row.value, changed: before !== row.value };
  }).filter((row) => row.changed);
});

function fmtTime(ts: number) {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function shortOp(opId: string) {
  return opId.length > 12 ? opId.slice(-8) : opId;
}

const noticeTheme = computed(() => {
  switch (store.lastNotice?.kind) {
    case 'committed':
    case 'recovered':
    case 'released': return 'success';
    case 'conflict':
    case 'failed':
    case 'blocked': return 'danger';
    case 'duplicate': return 'warning';
    default: return 'default';
  }
});

function toggleFailMode() {
  const url = new URL(location.href);
  if (url.searchParams.get('fail')) url.searchParams.delete('fail');
  else url.searchParams.set('fail', '0.85');
  location.href = url.toString();
}
const failMode = computed(() => new URLSearchParams(location.search).has('fail'));

function go(path: string) { router.push(path); }

function kindLabel(kind: string) {
  return kind === 'base' ? '基础' : kind === 'semantic' ? '语义' : '组件别名';
}
function kindTagTheme(kind: string) {
  return kind === 'base' ? 'primary' : kind === 'semantic' ? 'warning' : 'default';
}
function sourceLabel(source: string) {
  return source === 'override' ? '品牌覆盖' : source === 'reference' ? '引用解析' : source === 'missing' ? '缺失' : '字面量';
}
const draftCount = computed(() => store.session.edits.length + Object.keys(store.session.overrideDrafts ?? {}).length);
const headLabel = computed(() => `主线 r${store.headRev}${store.behindCount ? `（落后 ${store.behindCount}）` : '（最新）'}`);
const cycleSummary = computed(() => store.cycleNodes.length ? `${store.cycleNodes.length} 个节点` : '未发现');
function themeSourceLabel(tokenId: string, theme: string) {
  const override = store.overrideOf(tokenId, theme);
  if (override) return '品牌覆盖';
  const raw = store.rawValue(tokenId, theme);
  if (raw.startsWith('{') && raw.endsWith('}')) return '引用解析';
  return '字面量';
}
</script>

<template>
  <t-layout class="app-shell">
    <t-header class="app-header">
      <div class="brand"><span class="brand-mark">DS</span><div><strong>设计令牌治理台</strong><small>COLLABORATIVE TOKEN LEDGER</small></div></div>
      <div class="release-chip"><span>主线修订</span><strong>r{{ store.headRev }} · 本页基线 r{{ store.baseRev }}</strong></div>
      <div class="header-spacer" />
      <t-button size="small" variant="outline" :theme="failMode ? 'danger' : 'default'" @click="toggleFailMode">
        {{ failMode ? '故障模拟中（85% 失败）' : '模拟写入故障' }}
      </t-button>
      <t-tag theme="success" variant="light-outline">门禁 {{ store.releaseReadiness }}%</t-tag>
      <div class="operator"><span>{{ store.actor }}</span><strong>{{ store.session.tabId.slice(0, 8) }}</strong></div>
    </t-header>
    <t-layout class="body-layout">
      <t-aside class="side-nav">
        <div class="workspace-card">
          <t-icon name="layers" />
          <div>
            <span>协作账工作区</span>
            <strong>通用组件库 · 品牌主题</strong>
            <small>{{ store.tokens.length }} 个令牌 · 主线 r{{ store.headRev }}{{ store.readOnly ? ' · 快照只读' : '' }}</small>
          </div>
        </div>
        <nav>
          <button v-for="item in nav" :key="item.path" :class="{ active: route.path === item.path }" @click="go(item.path)">
            <t-icon :name="item.icon" /><span>{{ item.label }}</span>
            <t-badge v-if="item.path === '/review'" :count="store.changes.filter((c) => c.status === '待评审').length" />
            <t-badge v-if="item.path === '/publish' && (store.session.conflicts.length || store.outbox.length)" :count="store.session.conflicts.length + store.outbox.length" color="#b94343" />
          </button>
        </nav>
        <div class="save-state" :class="{ alarm: store.session.conflicts.length }">
          <t-icon :name="store.readOnly ? 'lock-on' : store.session.conflicts.length ? 'error-circle' : 'cloud-done'" />
          <div>
            <span>{{ store.readOnly ? '正在查看发布快照（只读）' : store.session.conflicts.length ? '存在并发冲突' : '草稿在本层，提交才入主线' }}</span>
            <small>草稿 {{ store.session.edits.length + Object.keys(store.session.overrideDrafts ?? {}).length }} · 冲突 {{ store.session.conflicts.length }} · 待恢复 {{ store.outbox.length }}</small>
          </div>
        </div>
      </t-aside>
      <t-content class="main-content">
        <header class="page-heading">
          <div>
            <small>{{ store.readOnly ? 'READ-ONLY SNAPSHOT' : store.session.conflicts.length ? 'CONFLICT DETECTED' : 'GOVERNANCE WORKBENCH' }} / {{ pageTitle }}</small>
            <h1>{{ pageTitle }}</h1>
            <p>修订号与父修订串联每次编辑；并发提交只有一条进入主线，另一条留层待解。</p>
          </div>
          <div class="heading-actions">
            <t-select :model-value="store.activeTheme" style="width: 150px" :options="themeOptions" :disabled="store.readOnly" @change="(v: string) => store.setTheme(v)" />
            <t-button variant="outline" :icon="RefreshButtonIcon" :disabled="store.readOnly" @click="store.commit()">提交本层编辑</t-button>
            <t-button theme="primary" :icon="LockButtonIcon" :disabled="store.publishBlocked || store.readOnly" @click="publish">发布主题</t-button>
          </div>
        </header>

        <!-- 协作状态条 -->
        <section class="collab-bar">
          <div class="rev-chain">
            <t-tag variant="light" theme="primary">本页基线 r{{ store.baseRev }}</t-tag>
            <ArrowRightIcon />
            <t-tag variant="light" :theme="store.behindCount ? 'warning' : 'success'">{{ headLabel }}</t-tag>
            <t-tag variant="light" theme="default">本层草稿 {{ draftCount }}</t-tag>
            <t-tag v-if="store.session.conflicts.length" variant="light" theme="danger">冲突 {{ store.session.conflicts.length }}</t-tag>
            <t-tag v-if="store.outbox.length" variant="light" theme="warning">未完成提交 {{ store.outbox.length }}</t-tag>
            <t-tag v-if="store.pendingReviewCells.length" variant="light" theme="warning">覆盖待复核 {{ store.pendingReviewCells.length }}</t-tag>
          </div>
          <div class="collab-actions">
            <t-button v-if="store.behindCount && !store.session.edits.length && !store.session.conflicts.length" size="small" variant="outline" @click="store.rebaseToHead()">对齐主线</t-button>
            <t-button size="small" variant="outline" :disabled="!store.session.pendingOpId" @click="store.recover()">按操作号恢复 ({{ store.pendingOpId ? shortOp(store.pendingOpId) : '—' }})</t-button>
            <t-button size="small" variant="text" :disabled="!(store.session.edits.length || store.session.conflicts.length)" @click="store.rollbackDrafts()">清空本层</t-button>
          </div>
        </section>
        <t-alert v-if="store.lastNotice" :key="store.lastNotice.id" class="notice-alert" :theme="noticeTheme" :message="store.lastNotice.text" />

        <!-- 快照只读横幅 -->
        <section v-if="store.viewingRelease" class="snapshot-banner">
          <t-icon name="lock-on" />
          <div>
            <strong>正在按发布快照 {{ store.viewingRelease.releaseId }} 查看</strong>
            <span>冻结于修订 r{{ store.viewingRelease.rev }} · {{ fmtTime(store.viewingRelease.ts) }} · 校验和 {{ store.viewingRelease.checksum.slice(0, 9) }}；当前主线已到 r{{ store.headRev }}，快照内容不随后续编辑变化。</span>
          </div>
          <t-button size="small" theme="primary" variant="outline" @click="store.viewCurrent()">返回当前主线</t-button>
        </section>

        <!-- —————————— 工作区 —————————— -->
        <section v-if="route.path === '/'" class="token-workspace">
          <aside class="token-tree panel">
            <div class="panel-head">
              <div><strong>令牌树</strong><span>{{ store.filteredTokens.length }} 个匹配项</span></div>
              <t-button size="small" variant="text" :icon="RefreshButtonIcon" :disabled="store.readOnly" @click="store.rollbackDrafts()">清草稿</t-button>
            </div>
            <t-input :model-value="store.sessionSearch" clearable placeholder="搜索令牌 ID 或名称" :prefix-icon="SearchInputIcon" @change="(v: string) => store.setSearch(v ?? '')" />
            <div class="category-tabs">
              <button v-for="category in categories" :key="category" :class="{ active: store.sessionCategory === category }" @click="store.setCategory(category)">{{ category }}</button>
            </div>
            <div class="tree-list">
              <button v-for="row in store.filteredTokens" :key="row.id" :class="{ active: store.selectedTokenId === row.id }" @click="store.selectToken(row.id)">
                <i :class="[row.kind, { flag: store.draftCells.has(cellKey(row.id, store.activeTheme)) || store.conflictCells.has(cellKey(row.id, store.activeTheme)) }]" />
                <div class="tree-main">
                  <strong>{{ row.name }}
                    <t-tag size="extra-small" :theme="kindTagTheme(row.kind)" variant="light">{{ kindLabel(row.kind) }}</t-tag>
                  </strong>
                  <span>{{ row.id }}</span>
                  <div class="tree-flags">
                    <t-tag v-if="store.conflictCells.has(cellKey(row.id, store.activeTheme))" size="extra-small" theme="danger" variant="light">冲突</t-tag>
                    <t-tag v-else-if="store.draftCells.has(cellKey(row.id, store.activeTheme))" size="extra-small" theme="primary" variant="light">本层已改</t-tag>
                    <t-tag v-if="row.overridden" size="extra-small" theme="default" variant="light-outline">{{ row.review === 'pending' ? '覆盖·待复核' : '品牌覆盖' }}</t-tag>
                  </div>
                </div>
                <code class="tree-value">{{ row.value }}</code>
              </button>
            </div>
          </aside>

          <section class="editor-column">
            <!-- 冲突面板 -->
            <div v-if="store.session.conflicts.length" class="panel conflict-panel">
              <div class="panel-head">
                <div><strong>并发冲突（{{ store.session.conflicts.length }}）</strong><span>主线已接受另一标签页的提交；你的本层值已保留，逐项解决后才能重放与发布</span></div>
                <t-tag theme="danger" variant="light">发布已暂停</t-tag>
              </div>
              <div v-for="conflict in store.session.conflicts" :key="conflict.cell" class="conflict-row">
                <div class="conflict-cell">
                  <t-tag size="small" :theme="kindTagTheme(conflict.kind)" variant="light">{{ kindLabel(conflict.kind) }}</t-tag>
                  <code>{{ conflict.cell }}</code>
                </div>
                <div class="conflict-values">
                  <div><span>共同基准</span><code>{{ conflict.base }}</code></div>
                  <div class="yours" :class="{ picked: conflict.resolved === 'yours' }"><span>你的本层值</span><code>{{ conflict.yours }}</code></div>
                  <div class="theirs" :class="{ picked: conflict.resolved === 'theirs' }"><span>主线值（另一标签页）</span><code>{{ conflict.theirs }}</code></div>
                </div>
                <div class="conflict-actions">
                  <t-button size="small" variant="outline" :disabled="store.readOnly" @click="store.resolveConflict(conflict.cell, 'yours')">采用我的</t-button>
                  <t-button size="small" variant="outline" :disabled="store.readOnly" @click="store.resolveConflict(conflict.cell, 'theirs')">采用主线</t-button>
                </div>
              </div>
              <div class="conflict-footer">
                <span>{{ store.session.conflicts.filter((c) => c.resolved).length }}/{{ store.session.conflicts.length }} 已解决</span>
                <t-button size="small" theme="primary" :disabled="store.session.conflicts.some((c) => !c.resolved)" @click="store.commitAfterResolution()">解决后重放到主线</t-button>
              </div>
            </div>

            <div class="panel editor-panel">
              <div class="panel-head">
                <div>
                  <strong>令牌编辑 · {{ selected?.id }}</strong>
                  <span>{{ kindLabel(selectedRow?.kind ?? 'base') }} · {{ themeName(store.activeTheme) }} · 修订链见底部账页</span>
                </div>
                <div class="editor-actions">
                  <t-tag v-if="selectedConflict" size="small" theme="danger" variant="light">该单元冲突中</t-tag>
                  <t-tag v-else-if="selectedRow?.meta" size="small" variant="light">最近直接改动 r{{ selectedRow.meta.rev }}</t-tag>
                  <t-tag v-if="selectedRow?.ref" size="small" variant="light-outline">引用 {{ selectedRow.ref }}</t-tag>
                </div>
              </div>

              <div class="value-form">
                <label>
                  <span>本层原始值（字面量或 &#123;令牌ID&#125; 表达式）</span>
                  <div class="value-line">
                    <t-input v-model="valueDraft" :disabled="store.readOnly || !!selectedConflict" @enter="commitValueInput" @blur="commitValueInput" />
                    <t-tag v-if="store.draftCells.has(cellKey(store.selectedTokenId, store.activeTheme))" theme="primary" variant="light">本层已改</t-tag>
                  </div>
                </label>
                <label>
                  <span>显式品牌覆盖（优先于引用层，留空跟随引用）</span>
                  <div class="value-line">
                    <t-input v-model="overrideDraftText" :placeholder="selectedOverride ? selectedOverride.value : '无覆盖，跟随引用层'" :disabled="store.readOnly || !!selectedConflict" />
                    <t-button size="small" variant="outline" :disabled="store.readOnly" @click="saveOverride">存为覆盖草稿</t-button>
                    <t-button size="small" variant="text" :disabled="store.readOnly" @click="dropOverrideDraft">清除覆盖</t-button>
                  </div>
                </label>
                <div v-if="selectedOverride" class="override-state" :class="{ pending: selectedOverride.review === 'pending' }">
                  <t-icon :name="selectedOverride.review === 'pending' ? 'error-circle' : 'check-circle'" />
                  <span v-if="selectedOverride.review === 'pending'">基础值已变：覆盖值 <code>{{ selectedOverride.value }}</code> 已保留，待人工复核后才允许发布。</span>
                  <span v-else>覆盖值 <code>{{ selectedOverride.value }}</code> 已复核确认。</span>
                  <t-button v-if="selectedOverride.review === 'pending' && !store.readOnly" size="small" theme="primary" @click="store.reviewOverride(store.selectedTokenId, store.activeTheme, 'keep')">确认保留</t-button>
                  <t-button v-if="selectedOverride.review === 'pending' && !store.readOnly" size="small" variant="outline" @click="store.reviewOverride(store.selectedTokenId, store.activeTheme, 'drop')">放弃覆盖</t-button>
                </div>
              </div>

              <div class="editor-host"><TokenEditor :model-value="editorText" language="json" @update:model-value="updateEditor" /></div>

              <div class="theme-grid">
                <div v-for="theme in store.themes" :key="theme" class="theme-cell" :class="{ active: theme === store.activeTheme, pending: store.overrideOf(store.selectedTokenId, theme)?.review === 'pending' }" @click="store.setTheme(theme)">
                  <span>{{ themeName(theme) }}</span>
                  <code>{{ store.snapshotValue(store.selectedTokenId, theme) }}</code>
                  <small>{{ themeSourceLabel(store.selectedTokenId, theme) }}</small>
                  <t-tag v-if="store.overrideOf(store.selectedTokenId, theme)" size="extra-small" :theme="store.overrideOf(store.selectedTokenId, theme)?.review === 'pending' ? 'warning' : 'default'" variant="light">{{ store.overrideOf(store.selectedTokenId, theme)?.review === 'pending' ? '待复核' : '覆盖' }}</t-tag>
                </div>
              </div>
            </div>

            <!-- 重算范围预览 -->
            <div class="panel effects-panel">
              <div class="panel-head"><div><strong>提交影响预览（重算范围）</strong><span>基础令牌改动沿引用链传播；品牌覆盖截断传播并转待复核</span></div><t-tag>{{ store.recomputePreview.length }}</t-tag></div>
              <div v-if="!store.recomputePreview.length" class="empty">当前本层草稿不引起下游重算。</div>
              <div v-for="effect in store.recomputePreview" :key="effect.cell" class="effect-row" :class="effect.type">
                <t-tag size="extra-small" :theme="effect.type === 'recompute' ? 'primary' : 'warning'" variant="light">{{ effect.type === 'recompute' ? '自动重算' : '覆盖待复核' }}</t-tag>
                <code class="effect-cell">{{ effect.cell }}</code>
                <div class="effect-values"><del>{{ effect.from }}</del><ins v-if="effect.type === 'recompute'">{{ effect.to }}</ins><ins v-else class="kept">{{ effect.to }}（保留）</ins></div>
              </div>
            </div>

            <div class="panel batch-panel">
              <div class="panel-head"><div><strong>批量替换</strong><span>匹配值逐 cell 进入本层草稿，提交后统一进入主线</span></div><SwapIcon /></div>
              <div class="batch-form">
                <t-input v-model="batchFrom" placeholder="原始值，如 #2864dc" :disabled="store.readOnly" />
                <ArrowRightIcon />
                <t-input v-model="batchTo" placeholder="新值" :disabled="store.readOnly" />
                <t-button theme="primary" :disabled="!batchFrom || !batchTo || store.readOnly" @click="batchReplace">放入本层</t-button>
              </div>
            </div>
          </section>

          <aside class="preview-column">
            <div class="panel preview-panel">
              <div class="panel-head"><div><strong>组件预览</strong><span>{{ store.readOnly ? '发布快照终值' : '实时应用当前主题' }}</span></div><t-tag :theme="store.readOnly ? 'warning' : 'success'" variant="light">{{ store.readOnly ? '只读快照' : '可渲染' }}</t-tag></div>
              <div class="component-preview" :style="{ background: store.snapshotValue('color.surface.canvas', store.activeTheme) }">
                <div class="mock-app">
                  <div class="mock-sidebar"><i /><i /><i /></div>
                  <div class="mock-content">
                    <div class="mock-title" :style="{ background: store.snapshotValue('color.text.primary', store.activeTheme) }" />
                    <div class="mock-card"><span /><span /><span /></div>
                    <div class="mock-buttons">
                      <button>取消</button>
                      <button :style="{ background: store.snapshotValue('component.button.primary.bg', store.activeTheme), color: store.snapshotValue('component.button.primary.text', store.activeTheme) }">确认提交</button>
                    </div>
                  </div>
                </div>
              </div>
              <div class="token-detail">
                <div><span>解析终值</span><strong>{{ selectedRow?.value }}</strong></div>
                <div><span>来源</span><strong>{{ sourceLabel(selectedRow?.source ?? 'literal') }}</strong></div>
                <div><span>分层</span><strong>{{ kindLabel(selectedRow?.kind ?? 'base') }}</strong></div>
                <div><span>说明</span><strong>{{ selected?.description }}</strong></div>
              </div>
            </div>

            <!-- 待复核覆盖 -->
            <div class="panel review-panel">
              <div class="panel-head"><div><strong>品牌覆盖待复核</strong><span>显式覆盖在基础值变更后保留，但发布前必须逐项确认</span></div><t-tag :theme="store.pendingReviewCells.length ? 'warning' : 'success'">{{ store.pendingReviewCells.length }}</t-tag></div>
              <div v-if="!store.pendingReviewCells.length" class="empty">没有待复核覆盖。</div>
              <div v-for="item in store.pendingReviewCells" :key="`${item.token}@${item.theme}`" class="pending-row">
                <code>{{ item.token }} · {{ themeName(item.theme) }}</code>
                <div class="pending-values"><span>底层重算</span><del>{{ item.underlying }}</del><span>覆盖保留</span><ins>{{ item.value }}</ins></div>
                <div class="pending-actions">
                  <t-button size="small" theme="primary" :disabled="store.readOnly" @click="store.reviewOverride(item.token, item.theme, 'keep')">保留</t-button>
                  <t-button size="small" variant="outline" :disabled="store.readOnly" @click="store.reviewOverride(item.token, item.theme, 'drop')">放弃</t-button>
                </div>
              </div>
            </div>

            <div class="panel validation-summary">
              <div class="panel-head"><div><strong>快速校验</strong><span>冲突、覆盖复核与质量门禁</span></div><strong class="score">{{ store.releaseReadiness }}%</strong></div>
              <div class="summary-row" :class="{ bad: store.session.conflicts.length }"><span>并发冲突</span><strong>{{ store.session.conflicts.length || '无' }}</strong></div>
              <div class="summary-row" :class="{ bad: store.pendingReviewCells.length }"><span>覆盖待复核</span><strong>{{ store.pendingReviewCells.length || '无' }}</strong></div>
              <div class="summary-row" :class="{ bad: store.cycleNodes.length }"><span>循环依赖</span><strong>{{ cycleSummary }}</strong></div>
              <div class="summary-row" :class="{ bad: store.invalidReferences.length }"><span>无效引用</span><strong>{{ store.invalidReferences.length || '未发现' }}</strong></div>
              <div class="summary-row" :class="{ bad: store.contrastIssues.length }"><span>对比度</span><strong>{{ store.contrastIssues.length ? '需调整' : '符合 AA' }}</strong></div>
            </div>

            <!-- 主线新修订 -->
            <div class="panel incoming-panel">
              <div class="panel-head"><div><strong>主线新动态</strong><span>本页基线之后其他标签页进入主线的修订</span></div><HistoryIcon /></div>
              <div v-if="!store.incomingRevisions.length" class="empty">主线无新修订。</div>
              <div v-for="revision in [...store.incomingRevisions].reverse()" :key="revision.rev" class="incoming-row">
                <t-tag size="extra-small" theme="success" variant="light">r{{ revision.rev }} ← r{{ revision.parent }}</t-tag>
                <div><strong>{{ revision.message }}</strong><span>{{ revision.actor }} · {{ fmtTime(revision.ts) }}</span></div>
                <t-tag v-if="revision.effects.length" size="extra-small" variant="light-outline">影响 {{ revision.effects.length }}</t-tag>
              </div>
            </div>
          </aside>
        </section>

        <!-- —————————— 依赖图 —————————— -->
        <section v-else-if="route.path === '/graph'" class="graph-page panel">
          <div class="panel-head">
            <div><strong>令牌依赖图（{{ themeName(store.activeTheme) }}）</strong><span>基础令牌 → 语义令牌 → 组件别名；高亮本页草稿、重算范围、待复核覆盖与冲突</span></div>
            <div class="graph-legend">
              <span><i class="recompute" />自动重算</span><span><i class="review" />覆盖待复核</span><span><i class="draft" />本层草稿</span><span><i class="error" />冲突/环</span>
            </div>
          </div>
          <div class="graph-canvas">
            <svg viewBox="0 0 820 520" preserveAspectRatio="xMidYMid meet">
              <defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="8" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8" fill="#7c8c98" /></marker></defs>
              <path v-for="edge in graphEdges" :key="`${edge.from.id}-${edge.to.id}`" :d="`M ${edge.from.x + 62} ${edge.from.y} C ${edge.from.x + 120} ${edge.from.y}, ${edge.to.x - 120} ${edge.to.y}, ${edge.to.x - 62} ${edge.to.y}`" fill="none" stroke="#8b9aa5" stroke-width="1.5" marker-end="url(#arrow)" />
              <g v-for="node in graphNodes" :key="node.id" :transform="`translate(${node.x},${node.y})`" class="graph-node" :class="nodeClass(node)" @click="store.selectToken(node.id)">
                <rect x="-62" y="-24" width="124" height="48" rx="5" />
                <text x="0" y="-4" text-anchor="middle">{{ node.name }}</text>
                <text x="0" y="12" text-anchor="middle">{{ kindLabel(tokenKind(node.id)) }}</text>
              </g>
            </svg>
          </div>
          <div class="validation-strip">
            <div class="validation-card"><t-icon name="check-circle" theme="success" /><div><strong>循环依赖</strong><span>{{ store.cycleNodes.length ? store.cycleNodes.join(' → ') : '未发现循环引用路径' }}</span></div></div>
            <div class="validation-card"><t-icon :name="store.invalidReferences.length ? 'error-circle' : 'check-circle'" :theme="store.invalidReferences.length ? 'danger' : 'success'" /><div><strong>引用完整性</strong><span>{{ store.invalidReferences.length ? store.invalidReferences.map((t) => `${t.token}→${t.ref}`).join('、') : '所有引用均指向已登记令牌' }}</span></div></div>
            <div class="validation-card"><t-icon :name="store.contrastIssues.length ? 'error-circle' : 'check-circle'" :theme="store.contrastIssues.length ? 'danger' : 'success'" /><div><strong>对比度检查</strong><span>{{ store.contrastIssues[0]?.detail ?? '正文与背景对比度符合 WCAG AA' }}</span></div></div>
          </div>
          <div class="effects-legend-row">
            <div class="panel-head"><strong>主线新修订的重算范围（r{{ store.baseRev }} → r{{ store.headRev }}）</strong></div>
            <div v-if="!incomingEffects.length" class="empty">基线之后暂无重算副作用。</div>
            <div v-for="effect in incomingEffects" :key="effect.cell" class="effect-row" :class="effect.type">
              <t-tag size="extra-small" :theme="effect.type === 'recompute' ? 'primary' : 'warning'" variant="light">{{ effect.type === 'recompute' ? '自动重算' : '覆盖待复核' }}</t-tag>
              <code class="effect-cell">{{ effect.cell }}</code>
              <div class="effect-values"><del>{{ effect.from }}</del><ins v-if="effect.type === 'recompute'">{{ effect.to }}</ins></div>
            </div>
          </div>
        </section>

        <!-- —————————— 评审 —————————— -->
        <section v-else-if="route.path === '/review'" class="review-page">
          <div class="review-summary panel">
            <div><span>待评审变更</span><strong>{{ store.changes.filter((c) => c.status === '待评审').length }}</strong></div>
            <div><span>已接受</span><strong>{{ store.changes.filter((c) => c.status === '已接受').length }}</strong></div>
            <div><span>已退回</span><strong>{{ store.changes.filter((c) => c.status === '已退回').length }}</strong></div>
            <div><span>本层草稿</span><strong>{{ store.session.edits.length }}</strong></div>
          </div>
          <div class="review-grid">
            <div v-for="change in store.changes" :key="change.id" class="panel change-card">
              <div class="change-head">
                <div><t-tag size="small">{{ change.id }}</t-tag><strong>{{ change.title }}</strong><span>{{ change.requester }} · {{ change.scope }}</span></div>
                <t-tag :theme="change.status === '已接受' ? 'success' : change.status === '已退回' ? 'danger' : 'warning'" variant="light">{{ change.status }}</t-tag>
              </div>
              <div class="diff-box"><div><span>修改前</span><code>{{ change.diff.before }}</code></div><t-icon name="arrow-right" /><div><span>修改后（进入本层草稿）</span><code>{{ change.diff.after }}</code></div></div>
              <div class="impact"><span>影响评分</span><t-progress :percentage="change.impact" :theme="change.impact > 70 ? 'danger' : 'warning'" /></div>
              <div class="change-actions"><t-button variant="outline" :disabled="change.status !== '待评审' || store.readOnly" @click="store.rejectChange(change.id)">退回并说明</t-button><t-button theme="primary" :disabled="change.status !== '待评审' || store.readOnly" @click="store.acceptChange(change.id)">接受并放入本层</t-button></div>
            </div>
          </div>
        </section>

        <!-- —————————— 协作账与发布 —————————— -->
        <section v-else class="publish-page">
          <div class="publish-main-col">
            <div class="panel publish-main">
              <div class="panel-head">
                <div><strong>发布准备</strong><span>冲突未解决或覆盖待复核时暂停；发布即冻结解析快照与校验和</span></div>
                <t-tag :theme="store.publishBlocked ? 'danger' : 'success'">{{ store.publishBlocked ? '暂停' : '可发布' }}</t-tag>
              </div>
              <div class="publish-form">
                <label><span>版本号</span><t-input v-model="releaseVersion" :disabled="store.readOnly" /></label>
                <label><span>目标产品</span><t-select multiple :value="['组件库','运营后台','移动端组件']" :options="[{label:'组件库',value:'组件库'},{label:'运营后台',value:'运营后台'},{label:'移动端组件',value:'移动端组件'},{label:'数据平台',value:'数据平台'}]" /></label>
                <label><span>发布说明</span><t-textarea v-model="releaseNotes" :autosize="{ minRows: 2 }" :disabled="store.readOnly" /></label>
              </div>
              <div class="release-gates">
                <div v-for="reason in store.blockReasons" :key="reason" class="gate bad"><t-icon name="error-circle" /><span>{{ reason }}</span></div>
                <div v-if="!store.blockReasons.length" class="gate ok"><t-icon name="check-circle" theme="success" /><span>冲突已解决、覆盖已复核、循环/引用/对比度检查通过、评审已处理。</span></div>
              </div>
              <div class="publish-actions">
                <t-button variant="outline" :disabled="store.readOnly" @click="store.rollbackDrafts()">清空本层未提交编辑</t-button>
                <t-button theme="primary" :icon="LockButtonIcon" :disabled="store.publishBlocked || store.readOnly" @click="publish">校验并冻结发布</t-button>
              </div>
            </div>

            <!-- 未完成提交 / 恢复 -->
            <div class="panel outbox-panel">
              <div class="panel-head"><div><strong>未完成提交（写入失败台账）</strong><span>按操作号恢复；已应用的操作不会重复执行</span></div><t-tag :theme="store.outbox.length ? 'warning' : 'success'">{{ store.outbox.length }}</t-tag></div>
              <div v-if="!store.outbox.length" class="empty">没有卡住的提交。</div>
              <div v-for="entry in store.outbox" :key="entry.op.opId" class="outbox-row">
                <div class="outbox-head">
                  <t-tag size="small" theme="warning" variant="light">{{ shortOp(entry.op.opId) }}</t-tag>
                  <code>父修订 r{{ entry.parent }}</code>
                  <span class="outbox-error">{{ entry.error }}</span>
                </div>
                <div class="outbox-meta">
                  <span>{{ entry.op.message }}</span>
                  <span>{{ Object.keys(entry.op.edits).length + Object.keys(entry.op.overrideEdits ?? {}).length }} 个单元 · 尝试 {{ entry.attempts }} 次 · {{ fmtTime(entry.lastTry) }}</span>
                </div>
                <div class="outbox-actions">
                  <t-button size="small" theme="primary" @click="store.recover(entry.op.opId)">按操作号恢复</t-button>
                  <t-button size="small" variant="text" @click="store.discardOutbox(entry.op.opId)">放弃</t-button>
                </div>
              </div>
            </div>

            <!-- 修订账 -->
            <div class="panel ledger-panel">
              <div class="panel-head"><div><strong>修订账（主线）</strong><span>每次编辑带修订号与父修订，跨标签页全序排列</span></div><t-tag variant="light">{{ store.revisions.length }} 条</t-tag></div>
              <div class="ledger-list">
                <div v-for="revision in [...store.revisions].reverse()" :key="revision.rev" class="ledger-row" :class="{ head: revision.rev === store.headRev }">
                  <div class="ledger-rev"><strong>r{{ revision.rev }}</strong><small v-if="revision.parent >= 0">父 r{{ revision.parent }}</small><small v-else>根修订</small></div>
                  <div class="ledger-body">
                    <strong>{{ revision.message }}</strong>
                    <span>{{ revision.actor }} · {{ fmtTime(revision.ts) }} · op {{ shortOp(revision.opId) }}</span>
                    <div v-if="Object.keys(revision.edits).length" class="ledger-cells">
                      <t-tag v-for="(value, cell) in revision.edits" :key="cell" size="extra-small" variant="light-outline"><code>{{ cell }}</code> = {{ value }}</t-tag>
                    </div>
                    <div v-if="revision.effects.length" class="ledger-effects">
                      <t-tag v-for="effect in revision.effects" :key="effect.cell" size="extra-small" :theme="effect.type === 'recompute' ? 'primary' : 'warning'" variant="light">
                        {{ effect.type === 'recompute' ? '重算' : '待复核' }} {{ parseCellKey(effect.cell).token }}@{{ parseCellKey(effect.cell).theme }}{{ effect.type === 'recompute' ? ` → ${effect.to}` : '' }}
                      </t-tag>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <aside class="publish-side">
            <div class="panel diff-panel">
              <div class="panel-head"><div><strong>未发布差异</strong><span>{{ themeName(store.activeTheme) }} · 相对 {{ store.releases.length ? store.releases[store.releases.length - 1].releaseId : '上次发布' }}</span></div><t-tag>{{ diffRows.length }} 项</t-tag></div>
              <div v-for="row in diffRows.slice(0, 12)" :key="row.id" class="diff-row"><strong>{{ row.name }}</strong><span>{{ row.id }}</span><div><del>{{ row.before }}</del><ins>{{ row.after }}</ins></div></div>
              <p v-if="!diffRows.length" class="empty">暂无未发布差异。</p>
            </div>
            <div class="panel history-panel">
              <div class="panel-head"><div><strong>发布快照</strong><span>已发布包按冻结时的修订查看</span></div><HistoryIcon /></div>
              <div v-if="!store.releases.length" class="empty">还没有发布记录。</div>
              <div v-for="snapshot in [...store.releases].reverse()" :key="snapshot.releaseId" class="history-row">
                <t-tag size="small" :theme="store.viewingReleaseId === snapshot.releaseId ? 'success' : 'default'" variant="light">{{ store.viewingReleaseId === snapshot.releaseId ? '查看中' : '快照' }}</t-tag>
                <div><strong>{{ snapshot.releaseId }}</strong><span>{{ snapshot.actor }} · r{{ snapshot.rev }} · {{ fmtTime(snapshot.ts) }}</span></div>
                <t-button size="small" variant="text" @click="store.viewRelease(snapshot.releaseId)">查看</t-button>
              </div>
            </div>
          </aside>
        </section>
      </t-content>
    </t-layout>
  </t-layout>

  <t-dialog v-model:visible="releaseDialog" header="主题发布完成" :footer="false">
    <div class="release-success"><t-icon name="check-circle" size="46px" theme="success" /><h3>{{ releaseVersion }} 已冻结</h3><p>{{ releaseResult }}</p><p>快照内容不随后续编辑变化；其他标签页可在“发布快照”中按原修订查看。</p></div>
  </t-dialog>
</template>
