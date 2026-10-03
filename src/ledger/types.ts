// 协作账数据模型：修订链（revision chain）+ 每层值（layer）+ 发布快照（snapshot）

export type TokenCategory = 'color' | 'font' | 'spacing' | 'radius' | 'shadow' | 'component';

export const THEMES = ['light', 'dark', 'ops', 'contrast'] as const;
export type Theme = (typeof THEMES)[number];

export type TokenKind = 'base' | 'semantic' | 'component';

export type Token = {
  id: string;
  name: string;
  category: TokenCategory;
  /** 明亮主题值，同时承担令牌默认值角色 */
  value: string;
  /** 每个主题变体的原始值；语义/组件令牌为 {id} 表达式或字面量 */
  themes: Record<string, string>;
  /** 显式品牌覆盖：cell 级别，{ theme: { value, review } } */
  overrides?: Record<string, OverrideState>;
  usage: number;
  status: 'stable' | 'deprecated' | 'proposed';
  description: string;
};

export type OverrideState = {
  /** 覆盖后的字面量值 */
  value: string;
  /** pending = 基础值变更后待复核；reviewed = 已确认保留 */
  review: 'pending' | 'reviewed';
};

/** 令牌分层：基础令牌 → 语义令牌 → 组件别名 */
export function tokenKind(id: string): TokenKind {
  if (id.startsWith('color.base.') || id.startsWith('font.') || id.startsWith('spacing.')
    || id.startsWith('radius.') || id.startsWith('shadow.')
    || id.startsWith('color.text.') || id.startsWith('color.surface.')) {
    return 'base';
  }
  if (id.startsWith('component.')) return 'component';
  return 'semantic';
}

export function isReference(value: string | undefined): boolean {
  return !!value && value.startsWith('{') && value.endsWith('}') && value.length > 2;
}

export function refTarget(value: string): string {
  return value.slice(1, -1);
}

export const cellKey = (token: string, theme: Theme | string) => `${token}@${theme}`;
export const parseCellKey = (key: string): { token: string; theme: string } => {
  const at = key.indexOf('@');
  return { token: key.slice(0, at), theme: key.slice(at + 1) };
};

/** 编辑原始值的副作用类型 */
export type EffectType = 'recompute' | 'review';

export type CellEffect = {
  cell: string;
  kind: TokenKind;
  type: EffectType;
  /** recompute：按引用链重算出的新值；review：覆盖中保留的旧值 */
  from: string;
  to: string;
};

/** 一条令牌编辑（操作号幂等），在提交时整体作用于某父修订 */
export type EditOp = {
  /** 操作号，已应用的操作不能重复 */
  opId: string;
  actor: string;
  tabId: string;
  clientTs: number;
  message: string;
  edits: Record<string, string>; // cell -> 新原始值（字面量或 {ref} 表达式）
  /** cell -> 覆盖值；null 表示删除品牌覆盖回到引用层 */
  overrideEdits?: Record<string, string | null>;
};

/** 修订节点：每个令牌编辑带修订号和父修订 */
export type Revision = {
  rev: number;
  parent: number;
  opId: string;
  actor: string;
  tabId: string;
  ts: number;
  message: string;
  /** 本次直接改动的 cell */
  edits: Record<string, string>;
  /** 本次直接改动的品牌覆盖 cell；null 为删除覆盖 */
  overrideEdits?: Record<string, string | null>;
  /** 本修订在主线产生的副作用：重算范围 + 待复核覆盖 */
  effects: CellEffect[];
  /** 提交时父修订对应的发布基线（未发布编辑始终相对最近一次发布） */
  sinceRelease?: string;
};

export type CellMeta = {
  /** 最近一次直接改动该 cell 的修订号 */
  rev: number;
  opId: string;
};

export type OutboxStatus = 'write-failed' | 'foreign';

/** 写入失败后按操作号恢复的未完成提交 */
export type OutboxEntry = {
  op: EditOp;
  /** 提交时所基于的父修订（恢复时用于检测分叉） */
  parent: number;
  status: OutboxStatus;
  error: string;
  attempts: number;
  lastTry: number;
};

export type ReleaseSnapshot = {
  id: string;
  version: string;
  releaseId: string;
  rev: number;
  ts: number;
  actor: string;
  notes: string;
  accepted: string[];
  /** 冻结的已解析终值：cell -> value */
  resolved: Record<string, string>;
  /** 冻结时的显式品牌覆盖值 */
  overrides: Record<string, string>;
  /** 冻结时仍待复核的覆盖 cell */
  pendingOverrides: string[];
  checksum: string;
};

export type RootState = {
  rev: number;
  tokens: Token[];
  cellMeta: Record<string, CellMeta>;
  revisions: Revision[];
  outbox: OutboxEntry[];
  releases: ReleaseSnapshot[];
};

/** 三层合并后某个 cell 的解析结果 */
export type ResolvedCell = {
  raw: string;
  resolved: string;
  source: 'override' | 'reference' | 'literal' | 'missing';
  overridden: boolean;
  review: 'pending' | 'reviewed' | null;
  ref?: string;
};

/** 本标签页的层（未提交编辑 + 冲突视图），仅当前页可见 */
export type LayerEdit = {
  cell: string;
  value: string;
  baseValue: string;
  opId: string;
  ts: number;
  kind: TokenKind;
};

export type ConflictEntry = {
  cell: string;
  base: string;
  yours: string;
  theirs: string;
  kind: TokenKind;
  resolved?: 'yours' | 'theirs';
};

export type LayerState = {
  tabId: string;
  baseRev: number;
  edits: LayerEdit[];
  conflicts: ConflictEntry[];
};

export type ChangeRequest = {
  id: string;
  title: string;
  requester: string;
  scope: string;
  impact: number;
  status: '待评审' | '已接受' | '已退回';
  diff: { token: string; before: string; after: string };
};
