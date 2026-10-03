import {
  cellKey, isReference, refTarget, tokenKind,
  type CellEffect, type ResolvedCell, type RootState, type Token, type Theme
} from './types';

export type TokenIndex = Map<string, Token>;

export function indexTokens(tokens: Token[]): TokenIndex {
  return new Map(tokens.map((token) => [token.id, token]));
}

/** 基础层原始值：语义/组件令牌的 themes 表达式，基础令牌的字面量 */
export function rawCell(tokens: TokenIndex, token: string, theme: string): string | undefined {
  const item = tokens.get(token);
  if (!item) return undefined;
  return item.themes[theme] ?? item.value;
}

/**
 * 三层解析：显式品牌覆盖 → 引用（沿依赖链回溯到基础令牌）→ 字面量。
 * seen 防止循环引用时无限递归。
 */
export function resolveCell(state: RootState, tokenId: string, theme: string, seen: string[] = []): ResolvedCell {
  const token = state.tokens.find((item) => item.id === tokenId);
  if (!token) return { raw: '', resolved: '（缺失令牌）', source: 'missing', overridden: false, review: null };

  const override = token.overrides?.[theme];
  if (override) {
    return {
      raw: override.value, resolved: override.value, source: 'override',
      overridden: true, review: override.review
    };
  }

  const raw = token.themes[theme] ?? token.value;
  if (isReference(raw)) {
    const target = refTarget(raw);
    if (seen.includes(tokenId)) {
      return { raw, resolved: '（循环引用）', source: 'reference', overridden: false, review: null, ref: target };
    }
    const next = state.tokens.find((item) => item.id === target);
    if (!next) {
      return { raw, resolved: `（无效引用 ${target}）`, source: 'missing', overridden: false, review: null, ref: target };
    }
    const tail = resolveCell(state, target, theme, [...seen, tokenId]);
    return { raw, resolved: tail.resolved, source: 'reference', overridden: tail.overridden, review: tail.review, ref: target };
  }
  return { raw, resolved: raw, source: 'literal', overridden: false, review: null };
}

/** 直接引用 from → to（表达式一层） */
export function directRefs(tokens: Token[]): { from: string; to: string }[] {
  const edges: { from: string; to: string }[] = [];
  tokens.forEach((token) => {
    new Set(Object.values(token.themes)).forEach((value) => {
      if (isReference(value)) edges.push({ from: token.id, to: refTarget(value) });
    });
    if (isReference(token.value) && !token.themes.light) edges.push({ from: token.id, to: refTarget(token.value) });
  });
  return [...new Map(edges.map((edge) => [`${edge.from}->${edge.to}`, edge])).values()];
}

/** 反向依赖：谁（直接或传递）引用了我 */
export function dependentsMap(tokens: Token[]): Map<string, Set<string>> {
  const reverse = new Map<string, Set<string>>();
  directRefs(tokens).forEach(({ from, to }) => {
    if (!reverse.has(to)) reverse.set(to, new Set());
    reverse.get(to)!.add(from);
  });
  return reverse;
}

/** 找出循环中的全部节点 */
export function findCycleNodes(tokens: Token[]): string[] {
  const graph = new Map<string, string>();
  directRefs(tokens).forEach(({ from, to }) => {
    // 多主题可能指向不同目标，环检测任取一条即可
    if (!graph.has(from)) graph.set(from, to);
  });
  const cycle = new Set<string>();
  graph.forEach((_, start) => {
    const path: string[] = [];
    let current: string | undefined = start;
    while (current && !path.includes(current)) {
      path.push(current);
      current = graph.get(current);
    }
    if (current && path.includes(current)) {
      path.slice(path.indexOf(current)).forEach((id) => cycle.add(id));
    }
  });
  return [...cycle];
}

/** 表达式指向不存在的令牌 */
export function findInvalidRefs(tokens: Token[]): { token: string; ref: string }[] {
  const ids = new Set(tokens.map((token) => token.id));
  const issues: { token: string; ref: string }[] = [];
  tokens.forEach((token) => {
    new Set(Object.values(token.themes)).forEach((value) => {
      if (isReference(value) && !ids.has(refTarget(value))) {
        issues.push({ token: token.id, ref: refTarget(value) });
      }
    });
  });
  return issues;
}

/**
 * 基础 cell 编辑的影响范围（按主题分别计算）：
 * 沿反向引用链传播到未覆盖的语义/组件 cell（recompute），
 * 被显式品牌覆盖截断的下游记为 review（保留覆盖旧值、待复核）。
 * prev = 编辑前令牌表，next = 编辑后令牌表（引用结构以 next 为准）。
 * overrideRoots 中的 cell 自身是直接覆盖编辑，只用于向下游传播，不计入副作用。
 */
export function computeEffects(
  prev: Token[],
  next: Token[],
  edits: Record<string, string>,
  overrideRoots: Record<string, unknown> = {}
): CellEffect[] {
  const nextIndex = indexTokens(next);
  const reverse = dependentsMap(next);
  const byTheme = new Map<string, Set<string>>();
  const addRoot = (cell: string) => {
    const at = cell.indexOf('@');
    const token = cell.slice(0, at);
    const theme = cell.slice(at + 1);
    if (!byTheme.has(theme)) byTheme.set(theme, new Set());
    byTheme.get(theme)!.add(token);
  };
  Object.keys(edits).forEach(addRoot);
  Object.keys(overrideRoots).forEach(addRoot);

  const effects: CellEffect[] = [];
  byTheme.forEach((editedTokens, theme) => {
    const seen = new Map<string, CellEffect>();

    const walk = (tokenId: string) => {
      (reverse.get(tokenId) ?? []).forEach((depId) => {
        const dep = nextIndex.get(depId);
        if (!dep || tokenKind(depId) === 'base' || editedTokens.has(depId) || seen.has(cellKey(depId, theme))) return;
        const cell = cellKey(depId, theme);
        const override = dep.overrides?.[theme];
        if (override) {
          // 覆盖截断传播：值保留，但标记待复核；from 展示底层重算后的新值
          const underlying = resolveOn(next, depId, theme, true);
          seen.set(cell, { cell, kind: tokenKind(depId), type: 'review', from: underlying, to: override.value });
          return;
        }
        const before = resolveOn(prev, depId, theme);
        const after = resolveOn(next, depId, theme);
        if (before !== after) {
          seen.set(cell, { cell, kind: tokenKind(depId), type: 'recompute', from: before, to: after });
        }
        walk(depId);
      });
    };

    editedTokens.forEach(walk);
    effects.push(...seen.values());
  });
  return effects;
}

function resolveOn(tokens: Token[], tokenId: string, theme: string, ignoreOverride = false, trail: string[] = []): string {
  const index = indexTokens(tokens);
  const token = index.get(tokenId);
  if (!token) return `（无效引用 ${tokenId}）`;
  const override = token.overrides?.[theme];
  if (override && !ignoreOverride) return override.value;
  const raw = token.themes[theme] ?? token.value;
  if (isReference(raw)) {
    const target = refTarget(raw);
    if (trail.includes(tokenId)) return '（循环引用）';
    return resolveOn(tokens, target, theme, ignoreOverride, [...trail, tokenId]);
  }
  return raw;
}

/** 应用一组 cell 原始值编辑到令牌列表（不可变，返回新列表） */
export function applyEdits(tokens: Token[], edits: Record<string, string>): Token[] {
  return tokens.map((token) => {
    let next: Token | null = null;
    (Object.keys(edits)).forEach((cell) => {
      const at = cell.indexOf('@');
      if (cell.slice(0, at) !== token.id) return;
      const theme = cell.slice(at + 1);
      const value = edits[cell];
      if (!next) next = structuredClone(token);
      next.themes[theme] = value;
      if (theme === 'light') next.value = value;
    });
    return next ?? token;
  });
}

/** 对比度（WCAG），仅对十六进制颜色有效，其余返回 null */
export function contrastRatio(a: string, b: string): number | null {
  const luminance = (hex: string): number | null => {
    const clean = hex.replace('#', '').trim();
    if (!/^[0-9a-fA-F]{6}$/.test(clean)) return null;
    const channels = [0, 2, 4].map((i) => parseInt(clean.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const l1 = luminance(a);
  const l2 = luminance(b);
  if (l1 === null || l2 === null) return null;
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

export function activeThemeOf(state: RootState, theme: string) {
  const text = resolveCell(state, 'color.text.primary', theme).resolved;
  const surface = resolveCell(state, 'color.surface.canvas', theme).resolved;
  return { text, surface };
}

export type ResolvedView = ReturnType<typeof buildResolvedView>;

/** 给界面用的整表解析视图 */
export function buildResolvedView(state: RootState, theme: string) {
  return state.tokens.map((token) => {
    const cell = resolveCell(state, token.id, theme);
    return {
      id: token.id,
      name: token.name,
      category: token.category,
      kind: tokenKind(token.id),
      raw: cell.raw,
      value: cell.resolved,
      source: cell.source,
      overridden: cell.overridden,
      review: cell.review,
      ref: cell.ref,
      meta: state.cellMeta[cellKey(token.id, theme)],
      usage: token.usage,
      status: token.status,
      description: token.description
    };
  });
}

export type { Theme };
