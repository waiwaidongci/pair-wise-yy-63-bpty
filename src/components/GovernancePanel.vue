<script setup lang="ts">
import { computed, ref } from 'vue';
import { storeToRefs } from 'pinia';
import {
  CheckCircleIcon,
  ErrorCircleIcon,
  HistoryIcon,
  RefreshIcon,
  LayersIcon
} from 'tdesign-icons-vue-next';
import { useTokenStore } from '../store';

const props = defineProps<{ visible: boolean }>();
const emit = defineEmits<{ 'update:visible': [value: boolean] }>();

const store = useTokenStore();
const {
  conflicts,
  pendingOps,
  appliedOps,
  lastRecalcScope,
  lastRecoverResult,
  currentLayer,
  head,
  snapshots,
  revisions
} = storeToRefs(store);

const activeTab = ref('conflict');

const conflictCount = computed(() => conflicts.value.length);
const pendingCount = computed(() => pendingOps.value.length);

const recentRevisions = computed(() => [...revisions.value].reverse().slice(0, 30));

function close() {
  emit('update:visible', false);
}

function fmtTs(ts: number) {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
}

function opLabel(kind: string) {
  return kind === 'commit' ? '提交' : '快照';
}
</script>

<template>
  <t-drawer
    :visible="visible"
    size="640px"
    :footer="false"
    header="协作台账 · 冲突 / 重算 / 恢复 / 快照"
    @update:visible="(value: boolean) => !value && close()"
  >
    <div class="gov-panel">
      <div class="gov-status-bar">
        <div class="status-cell"><span>主线 head</span><strong>#{{ head }}</strong></div>
        <div class="status-cell"><span>本层</span><strong>{{ currentLayer?.name ?? '—' }}</strong></div>
        <div class="status-cell"><span>本层基线</span><strong>#{{ currentLayer?.baseRev ?? '—' }}</strong></div>
        <div class="status-cell"><span>本层修订</span><strong>#{{ currentLayer?.headRev ?? '—' }}</strong></div>
        <div class="status-cell"><span>状态</span>
          <t-tag v-if="currentLayer?.status === 'conflicted'" theme="danger" variant="light">冲突</t-tag>
          <t-tag v-else-if="currentLayer && currentLayer.baseRev < head" theme="warning" variant="light">待同步</t-tag>
          <t-tag v-else theme="success" variant="light">一致</t-tag>
        </div>
      </div>

      <t-tabs v-model="activeTab">
        <t-tab-panel value="conflict" label="冲突">
          <template #label>
            <span>冲突<t-badge v-if="conflictCount" :count="conflictCount" size="small" /></span>
          </template>
          <div v-if="!conflictCount" class="gov-empty">
            <CheckCircleIcon size="28px" />
            <p>本层与主线一致，无冲突。</p>
            <small>两个标签页并发保存时，只有一条能进入主线；另一页保留本层值并在此列出冲突。</small>
          </div>
          <div v-else class="conflict-list">
            <div class="conflict-banner">
              <ErrorCircleIcon />
              <div><strong>检测到 {{ conflictCount }} 项分歧</strong><span>解决前发布暂停。可接受主线放弃本层，或保留本层值合并入主线。</span></div>
            </div>
            <div v-for="conflict in conflicts" :key="conflict.tokenId" class="conflict-card">
              <div class="conflict-head">
                <t-tag size="small">{{ conflict.tokenId }}</t-tag>
                <strong>{{ conflict.tokenName }}</strong>
              </div>
              <div class="conflict-diff">
                <div class="diff-col"><span>本层值</span><code>{{ conflict.layer.value }}</code></div>
                <div class="diff-col"><span>主线值</span><code>{{ conflict.main.value }}</code></div>
              </div>
              <div class="conflict-actions">
                <t-button size="small" variant="outline" :disabled="store.busy" @click="store.resolveConflict('rebase')">接受主线（放弃本层）</t-button>
                <t-button size="small" theme="primary" :disabled="store.busy" @click="store.resolveConflict('merge')">保留本层 · 合并入主线</t-button>
              </div>
            </div>
          </div>
        </t-tab-panel>

        <t-tab-panel value="recalc" label="重算范围">
          <div v-if="!lastRecalcScope" class="gov-empty">
            <RefreshIcon size="28px" />
            <p>暂无重算记录。</p>
            <small>基础令牌更新后，未覆盖的语义令牌与组件别名会自动重算；显式品牌覆盖保留但标记待复核。</small>
          </div>
          <div v-else class="recalc-scope">
            <div class="scope-banner">
              <RefreshIcon />
              <div><strong>由 {{ lastRecalcScope.tokenName }} 更新触发</strong><span>{{ fmtTs(lastRecalcScope.ts) }}</span></div>
            </div>
            <div class="scope-group">
              <h4>已重算（{{ lastRecalcScope.recalculated.length }}）</h4>
              <div v-if="!lastRecalcScope.recalculated.length" class="scope-empty">无</div>
              <t-tag v-for="id in lastRecalcScope.recalculated" :key="id" theme="success" variant="light" class="scope-tag">{{ id }}</t-tag>
            </div>
            <div class="scope-group">
              <h4>待复核 · 显式品牌覆盖保留（{{ lastRecalcScope.pendingReview.length }}）</h4>
              <div v-if="!lastRecalcScope.pendingReview.length" class="scope-empty">无</div>
              <t-tag v-for="id in lastRecalcScope.pendingReview" :key="id" theme="warning" variant="light" class="scope-tag">{{ id }}</t-tag>
            </div>
          </div>
        </t-tab-panel>

        <t-tab-panel value="recovery" label="恢复">
          <div class="fault-toggle">
            <div><strong>写入故障演练</strong><span>开启后下一次写入将失败，用于演示按操作号恢复。</span></div>
            <t-switch :value="store.faultArmed" @change="(value: boolean) => store.setFaultArmed(value)" />
          </div>

          <div v-if="lastRecoverResult" class="recover-result">
            <CheckCircleIcon />
            <div>
              <strong>恢复完成</strong>
              <span>已恢复 {{ lastRecoverResult.recovered.length }} · 跳过 {{ lastRecoverResult.skipped.length }} · 仍失败 {{ lastRecoverResult.failed.length }}</span>
            </div>
          </div>

          <div v-if="!pendingCount" class="gov-empty">
            <CheckCircleIcon size="28px" />
            <p>无未完成操作。</p>
            <small>每次写入带操作号；失败后在此按操作号恢复，已应用的操作跳过不重复。</small>
          </div>
          <div v-else class="op-list">
            <div class="op-banner">
              <ErrorCircleIcon />
              <div><strong>{{ pendingCount }} 个操作未完成</strong><span>按操作号恢复未完成提交；已应用的操作不会重复执行。</span></div>
            </div>
            <div v-for="op in pendingOps" :key="op.op" class="op-card">
              <div class="op-head">
                <t-tag size="small" :theme="op.status === 'failed' ? 'danger' : 'warning'" variant="light">{{ op.status === 'failed' ? '失败' : '待提交' }}</t-tag>
                <code>{{ op.op }}</code>
              </div>
              <div class="op-meta"><span>{{ opLabel(op.kind) }}</span><span>{{ fmtTs(op.ts) }}</span><span>尝试 {{ op.attempts + 1 }} 次</span></div>
              <div v-if="op.error" class="op-error">{{ op.error }}</div>
            </div>
            <t-button theme="primary" :disabled="store.busy" block @click="store.recover">
              <RefreshIcon /> 一键恢复未完成操作
            </t-button>
          </div>

          <div v-if="appliedOps.length" class="op-history">
            <h4>已应用操作（{{ appliedOps.length }}）</h4>
            <div v-for="op in appliedOps.slice(0, 8)" :key="op.op" class="op-row">
              <t-tag size="small" theme="success" variant="light">已应用</t-tag>
              <code>{{ op.op }}</code>
              <span v-if="op.rev != null">→ rev #{{ op.rev }}</span>
            </div>
          </div>
        </t-tab-panel>

        <t-tab-panel value="snapshot" label="快照">
          <div v-if="!snapshots.length" class="gov-empty">
            <LayersIcon size="28px" />
            <p>暂无发布快照。</p>
            <small>发布生成不可变快照；已发布包始终按原快照查看，不受后续编辑影响。</small>
          </div>
          <div v-else class="snapshot-list">
            <div v-for="snap in snapshots" :key="snap.id" class="snapshot-card" :class="{ active: store.viewedSnapshotId === snap.id }">
              <div class="snapshot-head">
                <t-tag size="small" theme="success" variant="light">{{ snap.release }}</t-tag>
                <strong>rev #{{ snap.rev }}</strong>
              </div>
              <div class="snapshot-meta"><span>{{ snap.actor }}</span><span>{{ fmtTs(snap.ts) }}</span><span>{{ snap.tokens.length }} 个令牌</span></div>
              <div class="snapshot-actions">
                <t-button size="small" variant="outline" @click="store.viewSnapshot(snap.id)">按原快照查看</t-button>
              </div>
            </div>
          </div>
        </t-tab-panel>

        <t-tab-panel value="ledger" label="台账">
          <div class="ledger-rev">
            <div class="ledger-rev-head"><HistoryIcon /><strong>最近修订</strong><span>主线 head #{{ head }}</span></div>
            <div v-if="!recentRevisions.length" class="scope-empty">暂无修订</div>
            <div v-for="rev in recentRevisions" :key="rev.rev" class="rev-row">
              <t-tag size="small" :theme="rev.note === 'edit' ? 'primary' : rev.note === 'recalc' ? 'success' : rev.note === 'merge' ? 'warning' : 'default'" variant="light">{{ rev.note }}</t-tag>
              <code class="rev-num">#{{ rev.rev }}</code>
              <span class="rev-parent">父 #{{ rev.parent }}</span>
              <span class="rev-token">{{ rev.tokenId }}</span>
              <span class="rev-op">{{ rev.op }}</span>
              <span class="rev-actor">{{ rev.actor }}</span>
            </div>
          </div>
        </t-tab-panel>
      </t-tabs>
    </div>
  </t-drawer>
</template>

<style scoped>
.gov-panel { display: flex; flex-direction: column; gap: 14px; }
.gov-status-bar { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; }
.status-cell { background: #f6f8fa; border: 1px solid var(--line); border-radius: 5px; padding: 9px 11px; }
.status-cell span { display: block; color: var(--muted); font-size: 9px; }
.status-cell strong { display: block; font-size: 12px; margin-top: 3px; }
.gov-empty { text-align: center; padding: 30px 16px; color: var(--muted); }
.gov-empty p { margin: 10px 0 4px; color: var(--ink); font-size: 13px; font-weight: 700; }
.gov-empty small { font-size: 10px; }
.conflict-list, .op-list, .snapshot-list { display: flex; flex-direction: column; gap: 10px; }
.conflict-banner, .op-banner { display: flex; gap: 9px; align-items: flex-start; background: #fdeceb; border: 1px solid #f3c1c1; border-radius: 5px; padding: 11px; color: #a34a48; }
.conflict-banner strong, .conflict-banner span, .op-banner strong, .op-banner span { display: block; }
.conflict-banner strong, .op-banner strong { font-size: 12px; }
.conflict-banner span, .op-banner span { font-size: 10px; margin-top: 3px; }
.conflict-card, .op-card, .snapshot-card { border: 1px solid var(--line); border-radius: 5px; padding: 11px; }
.conflict-head, .op-head, .snapshot-head { display: flex; align-items: center; gap: 8px; }
.conflict-head strong, .op-head code { font-size: 11px; }
.conflict-diff { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 10px 0; }
.diff-col { background: #f6f8fa; border-radius: 4px; padding: 8px; }
.diff-col span { display: block; color: var(--muted); font-size: 9px; }
.diff-col code { display: block; font-size: 10px; margin-top: 4px; overflow-wrap: anywhere; }
.conflict-actions { display: flex; gap: 8px; justify-content: flex-end; }
.scope-banner, .recover-result { display: flex; gap: 9px; align-items: center; background: #e7f5ef; border: 1px solid #bfe3d6; border-radius: 5px; padding: 11px; color: #17664b; margin-bottom: 12px; }
.scope-banner strong, .scope-banner span, .recover-result strong, .recover-result span { display: block; }
.scope-banner strong, .recover-result strong { font-size: 12px; }
.scope-banner span, .recover-result span { font-size: 10px; margin-top: 2px; }
.scope-group { margin-bottom: 14px; }
.scope-group h4 { margin: 0 0 8px; font-size: 11px; color: var(--muted); }
.scope-empty { font-size: 10px; color: var(--muted); }
.scope-tag { margin: 0 6px 6px 0; }
.fault-toggle { display: flex; align-items: center; justify-content: space-between; gap: 12px; background: #f6f8fa; border: 1px solid var(--line); border-radius: 5px; padding: 11px; margin-bottom: 12px; }
.fault-toggle strong, .fault-toggle span { display: block; }
.fault-toggle strong { font-size: 12px; }
.fault-toggle span { font-size: 9px; color: var(--muted); margin-top: 2px; }
.op-meta { display: flex; gap: 12px; margin-top: 6px; font-size: 9px; color: var(--muted); }
.op-error { margin-top: 6px; font-size: 9px; color: #a34a48; background: #fdeceb; border-radius: 3px; padding: 5px 7px; }
.op-history { margin-top: 16px; }
.op-history h4 { font-size: 11px; color: var(--muted); margin: 0 0 8px; }
.op-row { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid #edf1f3; font-size: 10px; }
.op-row code { font-size: 9px; color: var(--muted); }
.snapshot-meta { display: flex; gap: 12px; margin-top: 6px; font-size: 9px; color: var(--muted); }
.snapshot-actions { margin-top: 8px; }
.snapshot-card.active { border-color: #2864dc; background: #f5f9ff; }
.ledger-rev-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.ledger-rev-head strong { font-size: 12px; }
.ledger-rev-head span { font-size: 10px; color: var(--muted); }
.rev-row { display: flex; align-items: center; gap: 8px; padding: 7px 0; border-bottom: 1px solid #edf1f3; font-size: 10px; }
.rev-num { font-weight: 700; }
.rev-parent { color: var(--muted); font-size: 9px; }
.rev-token { font-size: 9px; color: var(--ink); }
.rev-op { font-size: 8px; color: var(--muted); font-family: ui-monospace, monospace; }
.rev-actor { margin-left: auto; font-size: 9px; color: var(--muted); }
</style>
