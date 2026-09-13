/**
 * Unit tests for wallet buy-in / cash-out conservation
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  clampStartingChips,
  claimDailyRewardRpc,
  clearMatchEscrow,
  creditCashOut,
  debitBuyIn,
  debitBuyInWithEscrow,
  ensurePokerLeaderboard,
  getChipsRpc,
  getWalletBalance,
  reconcileOrphanedEscrows,
  recordHandStatistics,
  updateChipsRpc,
  writeMatchEscrow,
  writeMatchEscrowBatch,
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
  options: {
    failWritesUntil?: number;
    matchesAlive?: Record<string, boolean>;
    matchGetThrows?: Record<string, boolean>;
  } = {}
): nkruntime.Nakama & { __leaderboardCreates: string[] } {
  const store = new Map<string, StoredObject>();
  let writeCount = 0;
  const failWritesUntil = options.failWritesUntil ?? 0;
  const matchesAlive = options.matchesAlive ?? {};
  const matchGetThrows = options.matchGetThrows ?? {};
  const leaderboardCreates: string[] = [];

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
    __leaderboardCreates: leaderboardCreates,
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

      // Validate all version constraints before applying any write (atomic batch)
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
      }

      const acks: { collection: string; key: string; userId: string; version: string }[] = [];
      for (const obj of objects) {
        const storeKey = `${obj.userId}:${obj.collection}:${obj.key}`;
        const existing = store.get(storeKey);
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
    storageList: (userId: string, collection: string) => {
      const objects: StoredObject[] = [];
      for (const obj of store.values()) {
        if (obj.userId === userId && obj.collection === collection) {
          objects.push(obj);
        }
      }
      return {
        objects: objects.map((obj) => ({
          collection: obj.collection,
          key: obj.key,
          userId: obj.userId,
          value: { ...obj.value },
          version: obj.version,
          permissionRead: 1,
          permissionWrite: 0,
        })),
        cursor: undefined,
      };
    },
    matchGet: (matchId: string) => {
      if (matchGetThrows[matchId]) {
        throw new Error('transient matchGet failure');
      }
      if (matchesAlive[matchId]) {
        return { matchId } as nkruntime.Match;
      }
      return null;
    },
    leaderboardCreate: (id: string) => {
      leaderboardCreates.push(id);
    },
    leaderboardRecordWrite: () => undefined,
  } as unknown as nkruntime.Nakama & { __leaderboardCreates: string[] };
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

  it('debits wallet and writes escrow in one atomic batch', () => {
    const nk = createMockNk({ user1: 5000 });
    debitBuyInWithEscrow(nk, 'user1', 'match-1', 1000, logger);

    expect(getWalletBalance(nk, 'user1', logger)).toBe(4000);
    const objects = (nk.storageRead as Function)([
      { collection: 'match_escrow', key: 'escrow:match-1', userId: 'user1' },
    ]);
    expect(objects).toHaveLength(1);
    expect(objects[0].value.amount).toBe(1000);
  });

  it('refunds orphaned escrow when match is gone', () => {
    const nk = createMockNk({ user1: 4000 }, { matchesAlive: {} });
    writeMatchEscrow(nk, 'dead-match', 'user1', 1000, logger);

    const refunded = reconcileOrphanedEscrows(nk, 'user1', logger);
    expect(refunded).toBe(1000);
    expect(getWalletBalance(nk, 'user1', logger)).toBe(5000);

    const after = (nk.storageRead as Function)([
      { collection: 'match_escrow', key: 'escrow:dead-match', userId: 'user1' },
    ]);
    expect(after).toHaveLength(0);
  });

  it('leaves escrow untouched while match is still alive', () => {
    const nk = createMockNk({ user1: 4000 }, { matchesAlive: { 'live-match': true } });
    writeMatchEscrow(nk, 'live-match', 'user1', 1000, logger);

    const refunded = reconcileOrphanedEscrows(nk, 'user1', logger);
    expect(refunded).toBe(0);
    expect(getWalletBalance(nk, 'user1', logger)).toBe(4000);
  });

  it('skips reconcile when matchGet throws (liveness unknown)', () => {
    const nk = createMockNk(
      { user1: 4000 },
      { matchesAlive: {}, matchGetThrows: { 'maybe-live': true } }
    );
    writeMatchEscrow(nk, 'maybe-live', 'user1', 1000, logger);

    const refunded = reconcileOrphanedEscrows(nk, 'user1', logger);
    expect(refunded).toBe(0);
    expect(getWalletBalance(nk, 'user1', logger)).toBe(4000);

    const stillThere = (nk.storageRead as Function)([
      { collection: 'match_escrow', key: 'escrow:maybe-live', userId: 'user1' },
    ]);
    expect(stillThere).toHaveLength(1);
    expect(stillThere[0].value.status).toBe('active');
  });

  it('refunds orphaned escrow only once across concurrent reconciles', () => {
    const nk = createMockNk({ user1: 4000 }, { matchesAlive: {} });
    writeMatchEscrow(nk, 'dead-match', 'user1', 1000, logger);

    const first = reconcileOrphanedEscrows(nk, 'user1', logger);
    const second = reconcileOrphanedEscrows(nk, 'user1', logger);
    expect(first).toBe(1000);
    expect(second).toBe(0);
    expect(getWalletBalance(nk, 'user1', logger)).toBe(5000);
  });

  it('checkpoints multiple player escrows in one atomic batch', () => {
    const nk = createMockNk({ user1: 5000, user2: 5000 });
    writeMatchEscrowBatch(
      nk,
      'match-batch',
      [
        { userId: 'user1', amount: 1100 },
        { userId: 'user2', amount: 900 },
      ],
      logger
    );

    const objects = (nk.storageRead as Function)([
      { collection: 'match_escrow', key: 'escrow:match-batch', userId: 'user1' },
      { collection: 'match_escrow', key: 'escrow:match-batch', userId: 'user2' },
    ]);
    expect(objects).toHaveLength(2);
    expect(objects.find((o: StoredObject) => o.userId === 'user1').value.amount).toBe(1100);
    expect(objects.find((o: StoredObject) => o.userId === 'user2').value.amount).toBe(900);
  });
});

describe('ensurePokerLeaderboard', () => {
  it('creates poker_total_won on initialization path', () => {
    const nk = createMockNk();
    const logger = createLogger();
    ensurePokerLeaderboard(nk, logger);
    expect(nk.__leaderboardCreates).toContain('poker_total_won');
  });
});

describe('claimDailyRewardRpc atomicity', () => {
  it('credits wallet and claims cooldown in one write', () => {
    const nk = createMockNk({ user1: 1000 });
    const logger = createLogger();
    const ctx = { userId: 'user1' } as nkruntime.Context;

    const first = JSON.parse(claimDailyRewardRpc(ctx, logger, nk, ''));
    expect(first.rewarded).toBe(true);
    expect(first.balance).toBe(1500);

    const second = JSON.parse(claimDailyRewardRpc(ctx, logger, nk, ''));
    expect(second.rewarded).toBe(false);
    expect(getWalletBalance(nk, 'user1', logger)).toBe(1500);
  });
});

describe('recordHandStatistics', () => {
  it('updates handsPlayed/handsWon and career totals without minting balance', () => {
    const nk = createMockNk({ user1: 5000 });
    const logger = createLogger();

    recordHandStatistics(nk, 'user1', 200, true, logger);
    const payload = JSON.parse(
      getChipsRpc({ userId: 'user1' } as nkruntime.Context, logger, nk, '')
    );
    expect(payload.balance).toBe(5000);
    expect(payload.handsPlayed).toBe(1);
    expect(payload.handsWon).toBe(1);
    expect(payload.totalWon).toBe(200);
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
