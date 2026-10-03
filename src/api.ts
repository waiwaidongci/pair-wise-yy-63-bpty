import { resolveCell } from './ledger/engine';
import { readLedger } from './ledger/storage';
import type { Token } from './ledger/types';

export type TokenPayload = {
  release: string;
  themes: string[];
  tokens: Token[];
};

/** 兼容旧入口：从协作账主线读取令牌（返回解析后视图） */
export async function fetchTokens(): Promise<TokenPayload> {
  await new Promise((resolve) => setTimeout(resolve, 60));
  const state = readLedger();
  return {
    release: `DS working @ r${state.rev}`,
    themes: ['品牌蓝 · 明亮', '品牌蓝 · 暗色', '运营绿', '高对比度'],
    tokens: state.tokens.map((token) => ({
      ...token,
      value: resolveCell(state, token.id, 'light').resolved
    }))
  };
}

export async function submitRelease(payload: { version: string; accepted: string[]; actor: string }) {
  await new Promise((resolve) => setTimeout(resolve, 120));
  return { accepted: true, releaseId: `DS-${payload.version}-${Date.now().toString().slice(-4)}` };
}
