/**
 * Unit tests for wallet buy-in / cash-out conservation
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  clampStartingChips,
  clearMatchEscrow,
  creditCashOut,
  debitBuyIn,
  getWalletBalance,
  updateChipsRpc,
  writeMatchEscrow,
  MIN_BUY_IN,
  MAX_STARTING_CHIPS,
  DEFAULT_STARTING_CHIPS,
} from './user_chips';

type StoredObject = {
  collection: string;
  key: string;
  userId: string;
  value: Record<string, unknown>;
  version: string;
};

function createLogger(): nkruntime.Logger {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  } as unknown as nkruntime.Logger;
}

function createMockNk(
  initialByUser: Record<string, number> = {},
  options: { failWritesUntil?: number } = {}
): nkruntime.Nakama {
  const store = new Map<string, StoredObject>();
  let writeCount = 0;
  const failWritesUntil = options.failWritesUntil ?? 0;

  for (const [userId, balance] of Object.entries(initialByUser)) {
    store.set(`${userId}:user_data:chips`, {
      collection: 'user_data',
      key: 'chips',
      userId,
      version: '1',
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
          value: { ...obj.value },
          version: obj.version,
          permissionRead: 1,
          permissionWrite: 0,
        }));
    },
    storageWrite: (
      objects: {
        collection: string;
        key: string;
        userId: string;
        value: Record<string, unknown>;
        version?: string;
      }[]
    ) => {
      writeCount += 1;
      if (writeCount <= failWritesUntil) {
        throw new Error('version conflict');
      }

      const acks: { collection: string; key: string; userId: string; version: string }[] = [];
      for (const obj of objects) {
        const storeKey = `${obj.userId}:${obj.collection}:${obj.key}`;
        const existing = store.get(storeKey);

        if (obj.version === '*') {
          if (existing) {
            throw new Error('version conflict: object already exists');
          }
        } else if (obj.version !== undefined && existing && existing.version !== obj.version) {
          throw new Error('version conflict');
        }

        const nextVersion = existing
          ? String(Number(existing.version || '0') + 1)
          : '1';

        store.set(storeKey, {
          collection: obj.collection,
          key: obj.key,
          userId: obj.userId,
          value: { ...obj.value },
          version: nextVersion,
        });
        acks.push({
          collection: obj.collection,
          key: obj.key,
          userId: obj.userId,
          version: nextVersion,
        });
      }
      return acks;
    },
    storageDelete: (deletes: { collection: string; key: string; userId: string }[]) => {
      for (const d of deletes) {
        store.delete(`${d.userId}:${d.collection}:${d.key}`);
      }
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

  it('retries version-conflicted wallet writes instead of minting chips', () => {
    // First storageWrite (debit) fails once with version conflict, then succeeds
    const conflictNk = createMockNk({ user1: 5000 }, { failWritesUntil: 1 });
    debitBuyIn(conflictNk, 'user1', 1000, logger);
    expect(getWalletBalance(conflictNk, 'user1', logger)).toBe(4000);
  });

  it('serializes concurrent-style buy-ins without double-spend', () => {
    debitBuyIn(nk, 'user1', 1000, logger);
    debitBuyIn(nk, 'user1', 1000, logger);
    expect(getWalletBalance(nk, 'user1', logger)).toBe(3000);
  });
});

describe('match escrow', () => {
  const logger = createLogger();

  it('writes and clears durable buy-in escrow records', () => {
    const nk = createMockNk({ user1: 5000 });
    debitBuyIn(nk, 'user1', 1000, logger);
    writeMatchEscrow(nk, 'match-1', 'user1', 1000, logger);

    const objects = (nk.storageRead as Function)([
      { collection: 'match_escrow', key: 'escrow:match-1', userId: 'user1' },
    ]);
    expect(objects).toHaveLength(1);
    expect(objects[0].value.amount).toBe(1000);
    expect(objects[0].value.status).toBe('active');

    creditCashOut(nk, 'user1', 1000, logger);
    clearMatchEscrow(nk, 'match-1', 'user1', logger);

    const after = (nk.storageRead as Function)([
      { collection: 'match_escrow', key: 'escrow:match-1', userId: 'user1' },
    ]);
    expect(after).toHaveLength(0);
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
