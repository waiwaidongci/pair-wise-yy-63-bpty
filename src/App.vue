<script setup lang="ts">
import { computed, h, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { MessagePlugin } from 'tdesign-vue-next';
import {
  AddIcon,
  ArrowRightIcon,
  CheckCircleIcon,
  CopyIcon,
  ErrorCircleIcon,
  HistoryIcon,
  LockOnIcon,
  RefreshIcon,
  SaveIcon,
  SearchIcon,
  SwapIcon,
  LayersIcon
} from 'tdesign-icons-vue-next';
import TokenEditor from './components/TokenEditor.vue';
import GovernancePanel from './components/GovernancePanel.vue';
import { useTokenStore, type TokenCategory } from './store';

const AddButtonIcon = () => h(AddIcon);
const ArrowRightButtonIcon = () => h(ArrowRightIcon);
const CopyButtonIcon = () => h(CopyIcon);
const HistoryButtonIcon = () => h(HistoryIcon);
const LockButtonIcon = () => h(LockOnIcon);
const RefreshButtonIcon = () => h(RefreshIcon);
const SearchInputIcon = () => h(SearchIcon);
const SwapButtonIcon = () => h(SwapIcon);
const SaveButtonIcon = () => h(SaveIcon);
const LayersButtonIcon = () => h(LayersIcon);

const route = useRoute();
const router = useRouter();
const store = useTokenStore();

const governanceVisible = ref(false);
const releaseDialog = ref(false);
const newTokenDialog = ref(false);
const newToken = ref<{ id: string; name: string; category: TokenCategory; value: string; description: string }>({ id: '', name: '', category: 'color', value: '#2864dc', description: '' });
const releaseResult = ref('');
const batchFrom = ref('');
const batchTo = ref('');

const nav = [
  { path: '/', label: '令牌工作区', icon: 'token' },
  { path: '/graph', label: '依赖与校验', icon: 'control-platform' },
  { path: '/review', label: '变更评审', icon: 'git-commit' },
  { path: '/publish', label: '主题发布', icon: 'send' }
];

onMounted(() => { void store.init(); });

const pageTitle = computed(() => nav.find((item) => item.path === route.path)?.label ?? '令牌工作区');
const selected = computed(() => store.selectedToken);
const selectedJson = computed(() => selected.value ? JSON.stringify({
  id: selected.value.id,
  name: selected.value.name,
  category: selected.value.category,
  value: selected.value.value,
  ref: selected.value.ref,
  themes: selected.value.themes,
  description: selected.value.description,
  status: selected.value.status,
  rev: selected.value.rev,
  needsReview: selected.value.needsReview
}, null, 2) : '{}');
const categories = computed(() => ['全部', ...new Set(store.tokens.map((token) => token.category))]);
const graphNodes = computed(() => {
  const nodes = store.tokens.filter((token) => token.ref || store.tokens.some((item) => item.ref === token.id));
  const grouped = ['color', 'font', 'spacing', 'radius', 'shadow', 'component'];
  return nodes.map((token, index) => ({
    ...token,
    x: 80 + grouped.indexOf(token.category) * 150,
    y: 70 + (index % 4) * 105
  }));
});
const graphEdges = computed(() => store.dependencyEdges.map((edge) => {
  const from = graphNodes.value.find((node) => node.id === edge.from);
  const to = graphNodes.value.find((node) => node.id === edge.to);
  return from && to ? { ...edge, from, to } : null;
}).filter(Boolean) as { from: typeof selected.value & { x: number; y: number }; to: typeof selected.value & { x: number; y: number } }[]);

const recentRevisions = computed(() => [...store.revisions].reverse().slice(0, 20));
const pendingCount = computed(() => store.pendingOps.length);
const snapshotDialogVisible = computed({
  get: () => !!store.viewedSnapshotId,
  set: (value: boolean) => { if (!value) store.closeSnapshot(); }
});

function go(path: string) {
  router.push(path);
}

function updateEditor(value: string) {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    if (parsed.value !== undefined) patch.value = parsed.value;
    if (parsed.themes !== undefined) patch.themes = parsed.themes;
    if (parsed.ref !== undefined) patch.ref = parsed.ref;
    if (parsed.description !== undefined) patch.description = parsed.description;
    if (Object.keys(patch).length) store.editLayerToken(store.selectedTokenId, patch);
  } catch {
    // 保留无效 JSON 可继续编辑；校验在依赖面板展示
  }
}

async function commitSelected() {
  if (!selected.value) return;
  const result = await store.commitEdit(store.selectedTokenId, { ...selected.value });
  if (result.status === 'committed') {
    if (result.alreadyApplied) MessagePlugin.info('该操作已应用，未重复写入');
    else MessagePlugin.success(`已提交到主线 · rev #${result.rev}`);
  } else {
    MessagePlugin.warning('与主线冲突，请在协作台账中处理');
    governanceVisible.value = true;
  }
}

async function addToken() {
  if (!newToken.value.id || !store.tokens.every((token) => token.id !== newToken.value.id)) {
    MessagePlugin.error('令牌 ID 不能为空且不能重复');
    return;
  }
  const token = {
    id: newToken.value.id,
    name: newToken.value.name || newToken.value.id,
    category: newToken.value.category,
    value: newToken.value.value,
    themes: { light: newToken.value.value, dark: newToken.value.value, ops: newToken.value.value, contrast: newToken.value.value },
    themeOverrides: {},
    usage: 0,
    status: 'proposed' as const,
    description: newToken.value.description,
    rev: 1,
    needsReview: false
  };
  store.tokens.push(token);
  store.selectToken(newToken.value.id);
  newTokenDialog.value = false;
  newToken.value = { id: '', name: '', category: 'color', value: '#2864dc', description: '' };
  MessagePlugin.success('已创建候选令牌（本层）');
}

async function publish() {
  if (store.hasConflicts) {
    MessagePlugin.warning('存在未解决冲突，发布已暂停');
    governanceVisible.value = true;
    return;
  }
  const snapshot = await store.publishSnapshot();
  releaseResult.value = `快照 ${snapshot.id} · rev #${snapshot.rev} · ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
  releaseDialog.value = true;
}

function fmtTs(ts: number) {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

function batchReplace() {
  if (!batchFrom.value || !batchTo.value) return;
  let count = 0;
  store.tokens.forEach((token) => {
    Object.keys(token.themes).forEach((theme) => {
      if (token.themes[theme] === batchFrom.value) {
        token.themes[theme] = batchTo.value;
        count += 1;
      }
    });
    if (token.value === batchFrom.value) {
      token.value = batchTo.value;
      count += 1;
    }
  });
  MessagePlugin.success(`已替换 ${count} 处引用（本层）`);
}
</script>

<template>
  <t-layout class="app-shell">
    <t-header class="app-header">
      <div class="brand"><span class="brand-mark">DS</span><div><strong>设计令牌治理台</strong><small>Collaborative Ledger</small></div></div>
      <div class="release-chip"><span>当前候选</span><strong>DS {{ store.releaseVersion }}</strong></div>
      <div class="header-spacer" />
      <t-tag theme="success" variant="light-outline">校验通过 {{ store.releaseReadiness }}%</t-tag>
      <t-button variant="outline" :icon="LayersButtonIcon" @click="governanceVisible = true">
        协作台账
        <t-badge v-if="store.hasConflicts" :count="store.conflicts.length" size="small" />
        <t-badge v-else-if="pendingCount" :count="pendingCount" size="small" />
      </t-button>
      <div class="operator"><span>设计系统维护员</span><strong>顾清 · Core DS</strong></div>
    </t-header>
    <t-layout class="body-layout">
      <t-aside class="side-nav">
        <div class="workspace-card"><t-icon name="layers" /><div><span>当前工作区</span><strong>通用组件库 · 品牌主题</strong><small>主线 head #{{ store.head }} · 本层 #{{ store.currentLayer?.headRev ?? '—' }}</small></div></div>
        <nav>
          <button v-for="item in nav" :key="item.path" :class="{ active: route.path === item.path }" @click="go(item.path)"><t-icon :name="item.icon" /><span>{{ item.label }}</span><t-badge v-if="item.path === '/review' && pendingCount" :count="pendingCount" /></button>
        </nav>
        <div class="save-state">
          <t-icon :name="store.isDirty ? 'edit' : 'cloud-done'" />
          <div><span>{{ store.isDirty ? '本层有未提交改动' : '草稿已同步' }}</span><small>主线 #{{ store.head }} · {{ new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) }}</small></div>
        </div>
      </t-aside>
      <t-content class="main-content">
        <header class="page-heading">
          <div><small>{{ store.locked ? 'RELEASE LOCKED' : 'GOVERNANCE WORKBENCH' }} / {{ pageTitle }}</small><h1>{{ pageTitle }}</h1><p>修订带父、并发冲突可恢复、基础更新自动重算、发布按原快照查看。</p></div>
          <div class="heading-actions">
            <t-select v-model="store.activeTheme" style="width: 150px" :options="[{label:'明亮模式',value:'light'},{label:'暗色模式',value:'dark'},{label:'运营模式',value:'ops'},{label:'高对比度',value:'contrast'}]" />
            <t-button variant="outline" :icon="AddButtonIcon" @click="newTokenDialog = true">新建令牌</t-button>
            <t-button theme="primary" :icon="LockButtonIcon" :disabled="store.locked || store.hasConflicts" @click="publish">发布主题</t-button>
          </div>
        </header>

        <!-- 冲突横幅 -->
        <div v-if="store.hasConflicts" class="banner banner-conflict">
          <ErrorCircleIcon />
          <div class="banner-body">
            <strong>本层与主线冲突 · {{ store.conflicts.length }} 项分歧</strong>
            <span>两个标签页并发保存，只有一条进入主线。本层保留自己的值，发布已暂停。</span>
          </div>
          <t-button size="small" theme="primary" @click="governanceVisible = true">去处理</t-button>
        </div>

        <!-- 外部变更提示 -->
        <div v-if="store.externalChange" class="banner banner-info">
          <RefreshIcon />
          <div class="banner-body"><strong>其他标签页已提交</strong><span>本层有未提交改动，为避免冲掉已保留本地编辑未自动刷新。</span></div>
          <t-button size="small" variant="outline" @click="store.refresh()">刷新并查看冲突</t-button>
        </div>

        <!-- 重算范围横幅 -->
        <div v-if="store.lastRecalcScope && route.path === '/'" class="banner banner-recalc">
          <CheckCircleIcon />
          <div class="banner-body">
            <strong>已按 {{ store.lastRecalcScope.tokenName }} 重算</strong>
            <span>重算 {{ store.lastRecalcScope.recalculated.length }} 项 · 待复核 {{ store.lastRecalcScope.pendingReview.length }} 项（显式品牌覆盖保留）</span>
          </div>
          <t-button size="small" variant="text" @click="governanceVisible = true">查看范围</t-button>
        </div>

        <!-- 恢复结果横幅 -->
        <div v-if="store.lastRecoverResult" class="banner banner-recover">
          <CheckCircleIcon />
          <div class="banner-body">
            <strong>恢复完成</strong>
            <span>已恢复 {{ store.lastRecoverResult.recovered.length }} · 跳过 {{ store.lastRecoverResult.skipped.length }}（幂等不重复） · 仍失败 {{ store.lastRecoverResult.failed.length }}</span>
          </div>
        </div>

        <section v-if="route.path === '/'" class="token-workspace">
          <aside class="token-tree panel">
            <div class="panel-head"><div><strong>令牌树</strong><span>{{ store.filteredTokens.length }} 个匹配项</span></div><t-button size="small" variant="text" :icon="RefreshButtonIcon" @click="store.refresh">刷新</t-button></div>
            <t-input v-model="store.search" clearable placeholder="搜索令牌 ID 或名称" :prefix-icon="SearchInputIcon" />
            <div class="category-tabs"><button v-for="category in categories" :key="category" :class="{ active: store.category === category }" @click="store.setCategory(category)">{{ category }}</button></div>
            <div class="tree-list">
              <button v-for="token in store.filteredTokens" :key="token.id" :class="{ active: store.selectedTokenId === token.id }" @click="store.selectToken(token.id)">
                <i :class="token.category" />
                <div><strong>{{ token.name }}</strong><span>{{ token.id }}</span></div>
                <t-tag size="small" :theme="token.needsReview ? 'warning' : token.status === 'stable' ? 'success' : token.status === 'proposed' ? 'warning' : 'default'" variant="light">{{ token.needsReview ? '待复核' : token.status === 'stable' ? '稳定' : token.status === 'proposed' ? '候选' : '弃用' }}</t-tag>
              </button>
            </div>
          </aside>
          <section class="editor-column">
            <div class="panel editor-panel">
              <div class="panel-head">
                <div><strong>Monaco 令牌编辑</strong><span>{{ selected?.id }} · {{ store.activeTheme }}</span></div>
                <div class="editor-actions">
                  <t-tag v-if="selected?.ref" variant="light">引用 {{ selected.ref }}</t-tag>
                  <t-tag v-if="selected?.needsReview" theme="warning" variant="light">待复核</t-tag>
                  <t-button size="small" variant="outline" :icon="SaveButtonIcon" :disabled="store.busy" @click="commitSelected">提交修订</t-button>
                </div>
              </div>
              <div class="editor-host"><TokenEditor :model-value="selectedJson" language="json" @update:model-value="updateEditor" /></div>
              <div class="editor-status">
                <span><i class="status-dot" />JSON 结构有效</span>
                <span>本层 rev #{{ selected?.rev ?? 1 }}</span>
                <span>父修订 #{{ store.currentLayer?.baseRev ?? 1 }}</span>
                <span>主线 head #{{ store.head }}</span>
                <span v-if="store.isDirty" class="dirty-tag">未提交改动</span>
              </div>
            </div>
            <div class="panel batch-panel"><div class="panel-head"><div><strong>批量替换</strong><span>跨主题替换相同原始值</span></div><SwapIcon /></div><div class="batch-form"><t-input v-model="batchFrom" placeholder="原始值，如 #2864dc" /><ArrowRightIcon /><t-input v-model="batchTo" placeholder="新值" /><t-button theme="primary" :disabled="!batchFrom || !batchTo" @click="batchReplace">执行替换</t-button></div></div>
          </section>
          <aside class="preview-column">
            <div class="panel preview-panel">
              <div class="panel-head"><div><strong>组件预览</strong><span>实时应用当前主题</span></div><t-tag theme="success" variant="light">可渲染</t-tag></div>
              <div class="component-preview" :style="{ background: selected?.category === 'color' ? selected.value : undefined }">
                <div class="mock-app"><div class="mock-sidebar"><i /><i /><i /></div><div class="mock-content"><div class="mock-title" /><div class="mock-card"><span /><span /><span /></div><div class="mock-buttons"><button>取消</button><button>确认提交</button></div></div></div>
              </div>
              <div class="token-detail"><div><span>当前值</span><strong>{{ selected?.value }}</strong></div><div><span>使用量</span><strong>{{ selected?.usage }} 处</strong></div><div><span>状态</span><strong>{{ selected?.status }}</strong></div><div><span>说明</span><strong>{{ selected?.description }}</strong></div></div>
            </div>
            <div class="panel validation-summary"><div class="panel-head"><div><strong>快速校验</strong><span>发布前门禁摘要</span></div><strong class="score">{{ store.releaseReadiness }}%</strong></div><div class="summary-row" :class="{ bad: store.cycleNodes.length }"><span>循环依赖</span><strong>{{ store.cycleNodes.length ? `${store.cycleNodes.length} 个节点` : '未发现' }}</strong></div><div class="summary-row" :class="{ bad: store.invalidReferences.length }"><span>无效引用</span><strong>{{ store.invalidReferences.length || '未发现' }}</strong></div><div class="summary-row" :class="{ bad: store.contrastIssues.length }"><span>对比度</span><strong>{{ store.contrastIssues.length ? '需调整' : '符合 AA' }}</strong></div><div class="summary-row"><span>命名冲突</span><strong>未发现</strong></div></div>
          </aside>
        </section>

        <section v-else-if="route.path === '/graph'" class="graph-page panel">
          <div class="panel-head"><div><strong>令牌依赖图</strong><span>基础令牌 → 语义令牌 → 组件别名</span></div><div class="graph-legend"><span><i class="color" />颜色</span><span><i class="component" />组件</span><span><i class="error" />错误</span></div></div>
          <div class="graph-canvas">
            <svg viewBox="0 0 820 520" preserveAspectRatio="xMidYMid meet">
              <defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="8" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8" fill="#7c8c98" /></marker></defs>
              <path v-for="edge in graphEdges" :key="`${edge.from.id}-${edge.to.id}`" :d="`M ${edge.from.x} ${edge.from.y} C ${edge.from.x + 70} ${edge.from.y}, ${edge.to.x - 70} ${edge.to.y}, ${edge.to.x} ${edge.to.y}`" fill="none" stroke="#8b9aa5" stroke-width="1.5" marker-end="url(#arrow)" />
              <g v-for="node in graphNodes" :key="node.id" :transform="`translate(${node.x},${node.y})`" class="graph-node" :class="{ cycle: store.cycleNodes.includes(node.id), selected: node.id === store.selectedTokenId }" @click="store.selectToken(node.id)">
                <rect x="-60" y="-24" width="120" height="48" rx="5" />
                <text x="0" y="-3" text-anchor="middle">{{ node.name }}</text>
                <text x="0" y="13" text-anchor="middle">{{ node.category }}</text>
              </g>
            </svg>
          </div>
          <div class="validation-strip"><div class="validation-card"><t-icon name="check-circle" theme="success" /><div><strong>循环依赖</strong><span>{{ store.cycleNodes.length ? store.cycleNodes.join(' → ') : '未发现循环引用路径' }}</span></div></div><div class="validation-card"><t-icon :name="store.invalidReferences.length ? 'error-circle' : 'check-circle'" :theme="store.invalidReferences.length ? 'danger' : 'success'" /><div><strong>引用完整性</strong><span>{{ store.invalidReferences.length ? store.invalidReferences.map(t => t.ref).join('、') : '所有引用均指向已发布令牌' }}</span></div></div><div class="validation-card"><t-icon :name="store.contrastIssues.length ? 'error-circle' : 'check-circle'" :theme="store.contrastIssues.length ? 'danger' : 'success'" /><div><strong>对比度检查</strong><span>{{ store.contrastIssues[0]?.detail ?? '正文与背景对比度 13.8:1' }}</span></div></div></div>
        </section>

        <section v-else-if="route.path === '/review'" class="review-page">
          <div class="review-summary panel"><div><span>主线修订</span><strong>{{ store.head }}</strong></div><div><span>待处理操作</span><strong>{{ pendingCount }}</strong></div><div><span>冲突</span><strong>{{ store.conflicts.length }}</strong></div><div><span>发布快照</span><strong>{{ store.snapshots.length }}</strong></div></div>
          <div class="review-grid">
            <div v-for="rev in recentRevisions" :key="rev.rev" class="panel change-card">
              <div class="change-head">
                <div><t-tag size="small">{{ rev.note }}</t-tag><strong>{{ rev.tokenId }}</strong><span>rev #{{ rev.rev }} · 父 #{{ rev.parent }}</span></div>
                <t-tag size="small" variant="light">{{ rev.actor }}</t-tag>
              </div>
              <div class="diff-box"><div><span>修改前</span><code>{{ JSON.stringify(rev.before) }}</code></div><t-icon name="arrow-right" /><div><span>修改后</span><code>{{ JSON.stringify(rev.after) }}</code></div></div>
              <div class="change-meta"><span>操作号 {{ rev.op }}</span><span>{{ fmtTs(rev.ts) }}</span></div>
            </div>
            <div v-if="!recentRevisions.length" class="panel empty-card">暂无修订记录。</div>
          </div>
        </section>

        <section v-else class="publish-page">
          <div class="panel publish-main">
            <div class="panel-head"><div><strong>发布准备</strong><span>生成不可变快照，已发布包按原快照查看</span></div><t-tag :theme="store.locked ? 'success' : 'warning'">{{ store.locked ? '已锁定' : '候选版本' }}</t-tag></div>
            <div class="publish-form">
              <label><span>版本号</span><t-input v-model="store.releaseVersion" /></label>
              <label><span>目标产品</span><t-select multiple value="['组件库','运营后台','移动端组件']" :options="[{label:'组件库',value:'组件库'},{label:'运营后台',value:'运营后台'},{label:'移动端组件',value:'移动端组件'},{label:'数据平台',value:'数据平台'}]" /></label>
              <label><span>发布说明</span><t-textarea value="更新语义主色、统一控件圆角，并修复暗色主题正文对比度。" :autosize="{ minRows: 3 }" /></label>
            </div>
            <div class="release-checks">
              <label><t-checkbox checked /> 循环依赖检查通过</label>
              <label><t-checkbox checked /> 无效引用检查通过</label>
              <label><t-checkbox :checked="store.contrastIssues.length === 0" /> 颜色对比度符合 WCAG AA</label>
              <label><t-checkbox :checked="!store.hasConflicts" /> 无未解决冲突（解决前发布暂停）</label>
              <label><t-checkbox :checked="pendingCount === 0" /> 无未完成操作</label>
            </div>
            <div class="publish-actions">
              <t-button variant="outline" @click="governanceVisible = true">打开协作台账</t-button>
              <t-button theme="primary" icon="lock-on" :disabled="store.locked || store.hasConflicts" @click="publish">校验并锁定发布</t-button>
            </div>
          </div>
          <aside class="publish-side">
            <div class="panel history-panel">
              <div class="panel-head"><div><strong>发布快照</strong><span>不可变 · 按原快照查看</span></div><HistoryIcon /></div>
              <div v-for="snap in store.snapshots" :key="snap.id" class="history-row">
                <t-tag theme="success" variant="light">rev #{{ snap.rev }}</t-tag>
                <div><strong>{{ snap.release }}</strong><span>{{ snap.actor }} · {{ fmtTs(snap.ts) }}</span></div>
                <t-button size="small" variant="text" @click="store.viewSnapshot(snap.id)">查看</t-button>
              </div>
              <div v-if="!store.snapshots.length" class="empty">暂无发布快照。</div>
            </div>
          </aside>
        </section>
      </t-content>
    </t-layout>
  </t-layout>

  <GovernancePanel v-model:visible="governanceVisible" />

  <t-dialog v-model:visible="newTokenDialog" header="创建候选令牌" :confirm-btn="{ content: '创建', onClick: addToken }">
    <div class="dialog-form"><t-input v-model="newToken.id" label="令牌 ID" placeholder="product.component.property" /><t-input v-model="newToken.name" label="显示名称" /><t-select v-model="newToken.category" label="分类" :options="[{label:'颜色',value:'color'},{label:'字体',value:'font'},{label:'间距',value:'spacing'},{label:'圆角',value:'radius'},{label:'阴影',value:'shadow'},{label:'组件',value:'component'}]" /><t-input v-model="newToken.value" label="默认值" /><t-textarea v-model="newToken.description" label="用途说明" /></div>
  </t-dialog>

  <t-dialog v-model:visible="releaseDialog" header="主题发布完成" :footer="false"><div class="release-success"><t-icon name="check-circle" size="46px" theme="success" /><h3>DS {{ store.releaseVersion }} 已锁定</h3><p>{{ releaseResult }}</p><p>版本快照已生成，产品使用方可以按固定版本拉取令牌。</p></div></t-dialog>

  <t-dialog v-model:visible="snapshotDialogVisible" header="按原快照查看" :footer="false" width="720px">
    <div v-if="store.viewedSnapshot" class="snapshot-viewer">
      <div class="snapshot-viewer-head">
        <t-tag theme="success" variant="light">{{ store.viewedSnapshot.release }}</t-tag>
        <strong>rev #{{ store.viewedSnapshot.rev }}</strong>
        <span>{{ store.viewedSnapshot.actor }} · {{ fmtTs(store.viewedSnapshot.ts) }}</span>
      </div>
      <div class="snapshot-viewer-list">
        <div v-for="token in store.viewedSnapshot.tokens" :key="token.id" class="snapshot-token-row">
          <t-tag size="small">{{ token.category }}</t-tag>
          <code>{{ token.id }}</code>
          <span>{{ token.value }}</span>
        </div>
      </div>
    </div>
  </t-dialog>
</template>
