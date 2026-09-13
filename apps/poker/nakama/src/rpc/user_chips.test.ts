/**
 * Unit tests for wallet buy-in / cash-out conservation
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  clampStartingChips,
  creditCashOut,
  debitBuyIn,
  getWalletBalance,
  updateChipsRpc,
  MIN_BUY_IN,
  MAX_STARTING_CHIPS,
  DEFAULT_STARTING_CHIPS,
} from './user_chips';

type StoredObject = {
  collection: string;
  key: string;
  userId: string;
  value: Record<string, unknown>;
};

function createLogger(): nkruntime.Logger {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  } as unknown as nkruntime.Logger;
}

function createMockNk(initialByUser: Record<string, number> = {}): nkruntime.Nakama {
  const store = new Map<string, StoredObject>();

  for (const [userId, balance] of Object.entries(initialByUser)) {
    store.set(`${userId}:user_data:chips`, {
      collection: 'user_data',
      key: 'chips',
      userId,
      value: {
        balance,
        totalWon: 0,
        totalLost: 0,
        handsPlayed: 0,
        handsWon: 0,
        lastUpdated: Date.now(),
        createdAt: Date.now(),
      },
    });
  }

  return {
    storageRead: (queries: { collection: string; key: string; userId: string }[]) => {
      return queries
        .map((q) => store.get(`${q.userId}:${q.collection}:${q.key}`))
        .filter((v): v is StoredObject => !!v)
        .map((obj) => ({
          collection: obj.collection,
          key: obj.key,
          userId: obj.userId,
          value: obj.value,
          version: '1',
          permissionRead: 1,
          permissionWrite: 0,
        }));
    },
    storageWrite: (objects: StoredObject[]) => {
      for (const obj of objects) {
        store.set(`${obj.userId}:${obj.collection}:${obj.key}`, {
          collection: obj.collection,
          key: obj.key,
          userId: obj.userId,
          value: { ...obj.value },
        });
      }
      return [];
    },
  } as unknown as nkruntime.Nakama;
}

describe('clampStartingChips', () => {
  it('clamps below minimum and above maximum', () => {
    expect(clampStartingChips(1)).toBe(MIN_BUY_IN);
    expect(clampStartingChips(999999)).toBe(MAX_STARTING_CHIPS);
    expect(clampStartingChips(2500)).toBe(2500);
  });

  it('handles non-finite input', () => {
    expect(clampStartingChips(Number.NaN)).toBe(MIN_BUY_IN);
  });
});

describe('debitBuyIn / creditCashOut wallet conservation', () => {
  const logger = createLogger();
  let nk: nkruntime.Nakama;

  beforeEach(() => {
    nk = createMockNk({ user1: 5000 });
  });

  it('debits buy-in from wallet and credits cash-out conserving total', () => {
    const buyIn = 1000;
    const before = getWalletBalance(nk, 'user1', logger);

    debitBuyIn(nk, 'user1', buyIn, logger);
    const afterBuyIn = getWalletBalance(nk, 'user1', logger);
    expect(afterBuyIn).toBe(before - buyIn);

    // Simulate table stack change: win 200 at the table
    const tableChips = buyIn + 200;
    creditCashOut(nk, 'user1', tableChips, logger);
    const afterCashOut = getWalletBalance(nk, 'user1', logger);

    expect(afterCashOut).toBe(before + 200);
    expect(afterCashOut + 0).toBe(before - buyIn + tableChips);
  });

  it('rejects insufficient buy-in without mutating balance', () => {
    const before = getWalletBalance(nk, 'user1', logger);
    expect(() => debitBuyIn(nk, 'user1', before + 1, logger)).toThrow(
      'Insufficient chips for buy-in'
    );
    expect(getWalletBalance(nk, 'user1', logger)).toBe(before);
  });

  it('rejects buy-in below minimum', () => {
    expect(() => debitBuyIn(nk, 'user1', MIN_BUY_IN - 1, logger)).toThrow(
      `Minimum buy-in is ${MIN_BUY_IN} chips`
    );
  });

  it('initializes new users at default balance then conserves through buy-in/cash-out', () => {
    const freshNk = createMockNk();
    const before = getWalletBalance(freshNk, 'newbie', logger);
    expect(before).toBe(DEFAULT_STARTING_CHIPS);

    const buyIn = 1000;
    debitBuyIn(freshNk, 'newbie', buyIn, logger);
    creditCashOut(freshNk, 'newbie', buyIn, logger);

    expect(getWalletBalance(freshNk, 'newbie', logger)).toBe(DEFAULT_STARTING_CHIPS);
  });

  it('round-trips buy-in and zero-loss cash-out (identity conservation)', () => {
    const buyIn = 1000;
    const start = getWalletBalance(nk, 'user1', logger);
    debitBuyIn(nk, 'user1', buyIn, logger);
    creditCashOut(nk, 'user1', buyIn, logger);
    expect(getWalletBalance(nk, 'user1', logger)).toBe(start);
  });
});

describe('updateChipsRpc', () => {
  it('hard-rejects client calls so balances cannot be minted', () => {
    const nk = createMockNk({ user1: 1000 });
    const logger = createLogger();
    const ctx = { userId: 'user1' } as nkruntime.Context;

    expect(() =>
      updateChipsRpc(ctx, logger, nk, JSON.stringify({ amount: 999999, reason: 'bonus' }))
    ).toThrow('update_chips is not available to clients');

    expect(getWalletBalance(nk, 'user1', logger)).toBe(1000);
  });
});
