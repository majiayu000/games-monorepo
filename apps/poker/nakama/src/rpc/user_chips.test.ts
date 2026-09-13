/**
 * Unit tests for wallet buy-in / cash-out conservation
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  clampStartingChips,
  claimDailyRewardRpc,
  clearMatchEscrow,
  clearStalePendingLeaderboardUpdate,
  creditCashOut,
  creditCashOutWithEscrowSettle,
  debitBuyIn,
  debitBuyInWithEscrow,
  enqueuePendingHandStatistics,
  enqueuePendingHandStatisticsBatch,
  enqueuePendingLeaderboardUpdate,
  ensurePokerLeaderboard,
  flushPendingHandStatistics,
  flushPendingLeaderboardUpdates,
  getActiveEscrowTotal,
  getChipsRpc,
  getWalletBalance,
  isPositiveBlind,
  normalizeBlind,
  reconcileOrphanedEscrows,
  recordHandStatistics,
  settleCashOutsAndEscrowCheckpoint,
  updateChipsRpc,
  updateLeaderboardScore,
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
): nkruntime.Nakama & {
  __leaderboardCreates: string[];
  __leaderboardSortOrders: string[];
  __leaderboardWrites: { id: string; userId: string; score: number }[];
  __failLeaderboardWrites?: boolean;
} {
  const store = new Map<string, StoredObject>();
  let writeCount = 0;
  const failWritesUntil = options.failWritesUntil ?? 0;
  const matchesAlive = options.matchesAlive ?? {};
  const matchGetThrows = options.matchGetThrows ?? {};
  const leaderboardCreates: string[] = [];
  const leaderboardSortOrders: string[] = [];
  const leaderboardOperators: string[] = [];
  const leaderboardWrites: { id: string; userId: string; score: number }[] = [];
  const leaderboardScores = new Map<string, number>();
  let failLeaderboardWrites = false;

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
    __leaderboardSortOrders: leaderboardSortOrders,
    __leaderboardOperators: leaderboardOperators,
    __leaderboardWrites: leaderboardWrites,
    get __failLeaderboardWrites() {
      return failLeaderboardWrites;
    },
    set __failLeaderboardWrites(value: boolean) {
      failLeaderboardWrites = value;
    },
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
    leaderboardCreate: (id: string, _authoritative: boolean, sortOrder: string, operator?: string) => {
      leaderboardCreates.push(id);
      leaderboardSortOrders.push(sortOrder);
      leaderboardOperators.push(operator || 'set');
    },
    leaderboardRecordWrite: (id: string, userId: string, _username: string | undefined, score: number) => {
      if (failLeaderboardWrites) {
        throw new Error('transient leaderboard write failure');
      }
      const prev = leaderboardScores.get(`${id}:${userId}`);
      // Mirror monotonic guard / best operator for tests that write without going through updateLeaderboardScore
      if (prev === undefined || score >= prev) {
        leaderboardScores.set(`${id}:${userId}`, score);
      }
      leaderboardWrites.push({ id, userId, score });
    },
    leaderboardRecordsList: (
      id: string,
      ownerIds: string[],
      _limit?: number,
      _cursor?: string,
      _expiry?: number
    ) => {
      const ownerRecords = (ownerIds || [])
        .map((userId) => {
          const score = leaderboardScores.get(`${id}:${userId}`);
          if (score === undefined) {
            return null;
          }
          return { ownerId: userId, score };
        })
        .filter(Boolean);
      return { records: ownerRecords, ownerRecords, nextCursor: undefined };
    },
  } as unknown as nkruntime.Nakama & {
    __leaderboardCreates: string[];
    __leaderboardSortOrders: string[];
    __leaderboardOperators: string[];
    __leaderboardWrites: { id: string; userId: string; score: number }[];
    __failLeaderboardWrites?: boolean;
  };
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

describe('normalizeBlind / isPositiveBlind', () => {
  it('rejects non-positive blinds that would mint via postBlinds', () => {
    expect(isPositiveBlind(-10)).toBe(false);
    expect(isPositiveBlind(0)).toBe(false);
    expect(isPositiveBlind(Number.NaN)).toBe(false);
    expect(isPositiveBlind(10)).toBe(true);
  });

  it('falls back when blind is invalid', () => {
    expect(normalizeBlind(-1000, 10)).toBe(10);
    expect(normalizeBlind('20', 10)).toBe(20);
    expect(normalizeBlind(undefined, 10)).toBe(10);
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

  it('settles escrow atomically with cash-out so reconcile cannot double-credit', () => {
    const nk = createMockNk({ user1: 4000 }, { matchesAlive: {} });
    writeMatchEscrow(nk, 'match-1', 'user1', 1000, logger);

    creditCashOutWithEscrowSettle(nk, 'match-1', 'user1', 1000, logger);
    expect(getWalletBalance(nk, 'user1', logger)).toBe(5000);

    // Even if delete failed and the settled marker remained, reconciler must not refund again.
    // Simulate leftover settled record:
    writeMatchEscrow(nk, 'match-1', 'user1', 1000, logger);
    const objects = (nk.storageRead as Function)([
      { collection: 'match_escrow', key: 'escrow:match-1', userId: 'user1' },
    ]);
    objects[0].value.status = 'settled';
    (nk.storageWrite as Function)([
      {
        collection: 'match_escrow',
        key: 'escrow:match-1',
        userId: 'user1',
        value: objects[0].value,
        version: objects[0].version,
      },
    ]);

    const refunded = reconcileOrphanedEscrows(nk, 'user1', logger);
    expect(refunded).toBe(0);
    expect(getWalletBalance(nk, 'user1', logger)).toBe(5000);
  });

  it('does not double-credit when cash-out settle is retried after crash', () => {
    const nk = createMockNk({ user1: 4000 });
    writeMatchEscrow(nk, 'match-1', 'user1', 1000, logger);

    creditCashOutWithEscrowSettle(nk, 'match-1', 'user1', 1000, logger);
    // Force a settled leftover marker as if clearMatchEscrow failed
    writeMatchEscrow(nk, 'match-1', 'user1', 1000, logger);
    const objects = (nk.storageRead as Function)([
      { collection: 'match_escrow', key: 'escrow:match-1', userId: 'user1' },
    ]);
    (nk.storageWrite as Function)([
      {
        collection: 'match_escrow',
        key: 'escrow:match-1',
        userId: 'user1',
        value: { ...objects[0].value, status: 'settled' },
        version: objects[0].version,
      },
    ]);

    const second = creditCashOutWithEscrowSettle(nk, 'match-1', 'user1', 1000, logger);
    expect(second.change).toBe(0);
    expect(getWalletBalance(nk, 'user1', logger)).toBe(5000);
  });

  it('does not mint when cash-out is retried after clearMatchEscrow succeeded', () => {
    // Reproduces 5000→6000 mint: first settle+clear leaves no escrow; retry must not
    // fall back to plain wallet credit.
    const nk = createMockNk({ user1: 4000 });
    writeMatchEscrow(nk, 'match-1', 'user1', 1000, logger);

    const first = creditCashOutWithEscrowSettle(nk, 'match-1', 'user1', 1000, logger);
    expect(first.change).toBe(1000);
    expect(getWalletBalance(nk, 'user1', logger)).toBe(5000);

    const escrowGone = (nk.storageRead as Function)([
      { collection: 'match_escrow', key: 'escrow:match-1', userId: 'user1' },
    ]);
    expect(escrowGone).toHaveLength(0);

    const second = creditCashOutWithEscrowSettle(nk, 'match-1', 'user1', 1000, logger);
    expect(second.change).toBe(0);
    expect(getWalletBalance(nk, 'user1', logger)).toBe(5000);
  });

  it('does not mint when settle retries after clear, or after orphan reconcile', () => {
    const nk = createMockNk({ user1: 4000 }, { matchesAlive: {} });
    writeMatchEscrow(nk, 'match-hand', 'user1', 1000, logger);

    const first = settleCashOutsAndEscrowCheckpoint(
      nk,
      'match-hand',
      [{ userId: 'user1', amount: 1000 }],
      [],
      logger
    );
    expect(first.settledUserIds).toEqual(['user1']);
    expect(getWalletBalance(nk, 'user1', logger)).toBe(5000);

    const retry = settleCashOutsAndEscrowCheckpoint(
      nk,
      'match-hand',
      [{ userId: 'user1', amount: 1000 }],
      [],
      logger
    );
    expect(retry.settledUserIds).toEqual(['user1']);
    expect(getWalletBalance(nk, 'user1', logger)).toBe(5000);

    // Orphan reconcile then settle: chips already refunded; settle must not credit again.
    const nk2 = createMockNk({ user2: 4000 }, { matchesAlive: {} });
    writeMatchEscrow(nk2, 'dead-match', 'user2', 1000, logger);
    expect(reconcileOrphanedEscrows(nk2, 'user2', logger)).toBe(1000);
    expect(getWalletBalance(nk2, 'user2', logger)).toBe(5000);

    const afterReconcile = settleCashOutsAndEscrowCheckpoint(
      nk2,
      'dead-match',
      [{ userId: 'user2', amount: 1000 }],
      [],
      logger
    );
    expect(afterReconcile.settledUserIds).toEqual(['user2']);
    expect(getWalletBalance(nk2, 'user2', logger)).toBe(5000);
  });

  it('settles pending cash-outs and remaining escrow in one atomic write', () => {
    const nk = createMockNk({ winner: 4000, loser: 4000 }, { matchesAlive: {} });
    writeMatchEscrow(nk, 'match-hand', 'winner', 1000, logger);
    writeMatchEscrow(nk, 'match-hand', 'loser', 1000, logger);

    const result = settleCashOutsAndEscrowCheckpoint(
      nk,
      'match-hand',
      [{ userId: 'winner', amount: 1100 }],
      [{ userId: 'loser', amount: 900 }],
      logger
    );

    expect(result.settledUserIds).toEqual(['winner']);
    expect(getWalletBalance(nk, 'winner', logger)).toBe(5100);
    expect(getWalletBalance(nk, 'loser', logger)).toBe(4000);

    const objects = (nk.storageRead as Function)([
      { collection: 'match_escrow', key: 'escrow:match-hand', userId: 'loser' },
      { collection: 'match_escrow', key: 'escrow:match-hand', userId: 'winner' },
    ]);
    const loserEscrow = objects.find((o: StoredObject) => o.userId === 'loser');
    expect(loserEscrow.value.amount).toBe(900);
    expect(loserEscrow.value.status).toBe('active');

    // Winner escrow cleared (or settled-only); reconcile must not inflate totals.
    const refunded = reconcileOrphanedEscrows(nk, 'winner', logger);
    expect(refunded).toBe(0);
    expect(getWalletBalance(nk, 'winner', logger)).toBe(5100);
    expect(getWalletBalance(nk, 'loser', logger) + 900).toBe(4900);
  });
});

describe('pending hand statistics', () => {
  it('queues failed hand stats and flushes them later', () => {
    const nk = createMockNk({ user1: 5000 });
    const logger = createLogger();

    enqueuePendingHandStatistics(nk, 'match-1', 3, 'user1', 150, true, logger);
    expect(flushPendingHandStatistics(nk, 'user1', logger)).toBe(1);

    const payload = JSON.parse(
      getChipsRpc({ userId: 'user1' } as nkruntime.Context, logger, nk, '')
    );
    expect(payload.handsPlayed).toBe(1);
    expect(payload.handsWon).toBe(1);
    expect(payload.totalWon).toBe(150);
    expect(flushPendingHandStatistics(nk, 'user1', logger)).toBe(0);
  });

  it('claims pending stats with OCC so concurrent flushes cannot double-count', () => {
    const nk = createMockNk({ user1: 5000 });
    const logger = createLogger();

    enqueuePendingHandStatistics(nk, 'match-1', 7, 'user1', 100, true, logger);

    // First flush claims + applies; second flush must not increment again.
    expect(flushPendingHandStatistics(nk, 'user1', logger)).toBe(1);
    expect(flushPendingHandStatistics(nk, 'user1', logger)).toBe(0);

    const chips = (nk.storageRead as Function)([
      { collection: 'user_data', key: 'chips', userId: 'user1' },
    ])[0].value;
    expect(chips.handsPlayed).toBe(1);
    expect(chips.handsWon).toBe(1);
    expect(chips.totalWon).toBe(100);
  });
});

describe('terminate-style atomic cash-outs', () => {
  it('settles all terminating stacks in one write without partial credit', () => {
    const nk = createMockNk({ winner: 4000, loser: 4000 });
    const logger = createLogger();
    writeMatchEscrow(nk, 'match-term', 'winner', 1000, logger);
    writeMatchEscrow(nk, 'match-term', 'loser', 1000, logger);

    // Post-hand in-memory stacks differ from pre-hand escrow (checkpoint failed case)
    const result = settleCashOutsAndEscrowCheckpoint(
      nk,
      'match-term',
      [
        { userId: 'winner', amount: 1100 },
        { userId: 'loser', amount: 900 },
      ],
      [],
      logger
    );

    expect(result.settledUserIds.sort()).toEqual(['loser', 'winner']);
    expect(getWalletBalance(nk, 'winner', logger)).toBe(5100);
    expect(getWalletBalance(nk, 'loser', logger)).toBe(4900);
    // Total conserved: 8000 wallet start + 0 leftover escrow = 10000 chips system
    expect(
      getWalletBalance(nk, 'winner', logger) + getWalletBalance(nk, 'loser', logger)
    ).toBe(10000);

    expect(reconcileOrphanedEscrows(nk, 'winner', logger)).toBe(0);
    expect(reconcileOrphanedEscrows(nk, 'loser', logger)).toBe(0);
  });
});

describe('ensurePokerLeaderboard', () => {
  it('creates poker_total_won on initialization path with runtime desc sort', () => {
    const nk = createMockNk();
    const logger = createLogger();
    ensurePokerLeaderboard(nk, logger);
    expect(nk.__leaderboardCreates).toContain('poker_total_won');
    expect(nk.__leaderboardSortOrders).toContain('desc');
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

  it('uses committed mutation totals for leaderboard without a post-commit wallet re-read', () => {
    const nk = createMockNk({ user1: 5000 });
    const logger = createLogger();
    let chipReads = 0;
    const originalRead = nk.storageRead.bind(nk);
    nk.storageRead = ((queries: { collection: string; key: string; userId: string }[]) => {
      for (const q of queries) {
        if (q.collection === 'user_data' && q.key === 'chips') {
          chipReads += 1;
        }
      }
      return originalRead(queries);
    }) as typeof nk.storageRead;

    recordHandStatistics(nk, 'user1', 150, true, logger);

    // mutateWallet performs the only chips read; leaderboard must not re-read wallet storage
    expect(chipReads).toBe(1);
    const payload = JSON.parse(
      getChipsRpc({ userId: 'user1' } as nkruntime.Context, logger, nk, '')
    );
    expect(payload.handsPlayed).toBe(1);
    expect(payload.totalWon).toBe(150);
  });

  it('queues a pending leaderboard update when the leaderboard write fails after stats commit', () => {
    const nk = createMockNk({ user1: 5000 });
    const logger = createLogger();
    nk.__failLeaderboardWrites = true;

    recordHandStatistics(nk, 'user1', 200, true, logger);

    const payload = JSON.parse(
      getChipsRpc({ userId: 'user1' } as nkruntime.Context, logger, nk, '')
    );
    expect(payload.totalWon).toBe(200);
    expect(nk.__leaderboardWrites).toHaveLength(0);

    // Pending record exists; get_chips flush still fails while flag is set
    const listed = nk.storageList('user1', 'leaderboard_pending');
    expect(listed.objects).toHaveLength(1);
    expect((listed.objects[0].value as { totalWon: number }).totalWon).toBe(200);

    nk.__failLeaderboardWrites = false;
    expect(flushPendingLeaderboardUpdates(nk, 'user1', logger)).toBe(true);
    expect(nk.__leaderboardWrites).toEqual([
      { id: 'poker_total_won', userId: 'user1', score: 200 },
    ]);
    expect(nk.storageList('user1', 'leaderboard_pending').objects).toHaveLength(0);
  });

  it('does not throw when leaderboard retry enqueue fails after stats commit', () => {
    const nk = createMockNk({ user1: 5000 });
    const logger = createLogger();
    nk.__failLeaderboardWrites = true;
    const originalWrite = nk.storageWrite.bind(nk);
    nk.storageWrite = ((objects: {
      collection: string;
      key: string;
      userId: string;
      value: Record<string, unknown>;
    }[]) => {
      if (objects.some((o) => o.collection === 'leaderboard_pending')) {
        throw new Error('leaderboard pending write failed');
      }
      return originalWrite(objects);
    }) as typeof nk.storageWrite;

    // Must not throw — otherwise callers would re-queue and double-count handsPlayed
    expect(() => recordHandStatistics(nk, 'user1', 200, true, logger)).not.toThrow();

    const chips = (nk.storageRead as Function)([
      { collection: 'user_data', key: 'chips', userId: 'user1' },
    ])[0].value;
    expect(chips.handsPlayed).toBe(1);
    expect(chips.totalWon).toBe(200);
    expect(nk.storageList('user1', 'leaderboard_pending').objects).toHaveLength(0);
  });

  it('clears stale leaderboard_pending after a successful newer direct write', () => {
    const nk = createMockNk({ user1: 5000 });
    const logger = createLogger();

    enqueuePendingLeaderboardUpdate(nk, 'user1', 100, logger);
    expect(nk.storageList('user1', 'leaderboard_pending').objects).toHaveLength(1);

    recordHandStatistics(nk, 'user1', 250, true, logger);

    expect(nk.__leaderboardWrites).toEqual([
      { id: 'poker_total_won', userId: 'user1', score: 250 },
    ]);
    expect(nk.storageList('user1', 'leaderboard_pending').objects).toHaveLength(0);
  });

  it('preserves a newer pending leaderboard retry when clearing after an older write', () => {
    const nk = createMockNk({ user1: 5000 });
    const logger = createLogger();

    enqueuePendingLeaderboardUpdate(nk, 'user1', 500, logger);
    clearStalePendingLeaderboardUpdate(nk, 'user1', 200, logger);

    const listed = nk.storageList('user1', 'leaderboard_pending');
    expect(listed.objects).toHaveLength(1);
    expect((listed.objects[0].value as { totalWon: number }).totalWon).toBe(500);
  });
});

describe('enqueuePendingHandStatisticsBatch', () => {
  it('journals all participants in one write before any apply', () => {
    const nk = createMockNk({ a: 5000, b: 5000 });
    const logger = createLogger();

    enqueuePendingHandStatisticsBatch(
      nk,
      'match-batch',
      4,
      [
        { userId: 'a', netChange: 100, wonHand: true },
        { userId: 'b', netChange: -100, wonHand: false },
      ],
      logger
    );

    expect(nk.storageList('a', 'hand_stats_pending').objects).toHaveLength(1);
    expect(nk.storageList('b', 'hand_stats_pending').objects).toHaveLength(1);

    expect(flushPendingHandStatistics(nk, 'a', logger)).toBe(1);
    expect(flushPendingHandStatistics(nk, 'b', logger)).toBe(1);

    const chipsA = (nk.storageRead as Function)([
      { collection: 'user_data', key: 'chips', userId: 'a' },
    ])[0].value;
    const chipsB = (nk.storageRead as Function)([
      { collection: 'user_data', key: 'chips', userId: 'b' },
    ])[0].value;
    expect(chipsA.handsPlayed).toBe(1);
    expect(chipsA.handsWon).toBe(1);
    expect(chipsB.handsPlayed).toBe(1);
    expect(chipsB.totalLost).toBe(100);
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

describe('monotonic leaderboard writes', () => {
  it('creates poker_total_won with best operator', () => {
    const nk = createMockNk({ user1: 5000 }) as ReturnType<typeof createMockNk> & {
      __leaderboardOperators: string[];
    };
    const logger = createLogger();
    ensurePokerLeaderboard(nk, logger);
    expect(nk.__leaderboardOperators).toContain('best');
  });

  it('skips a stale lower totalWon after a higher concurrent write', () => {
    const nk = createMockNk({ user1: 5000 });
    const logger = createLogger();

    expect(updateLeaderboardScore(nk, 'user1', 200, logger)).toBe(true);
    expect(updateLeaderboardScore(nk, 'user1', 100, logger)).toBe(true);

    expect(nk.__leaderboardWrites).toEqual([
      { id: 'poker_total_won', userId: 'user1', score: 200 },
    ]);
  });
});

describe('getActiveEscrowTotal / get_chips escrow signal', () => {
  it('reports active escrow so clients can poll deferred cash-outs', () => {
    const nk = createMockNk(
      { user1: 5000 },
      { matchesAlive: { 'match-live': true } }
    );
    const logger = createLogger();

    debitBuyInWithEscrow(nk, 'user1', 'match-live', 1000, logger);
    expect(getActiveEscrowTotal(nk, 'user1', logger)).toBe(1000);

    const payload = JSON.parse(
      getChipsRpc({ userId: 'user1' } as nkruntime.Context, logger, nk, '')
    );
    expect(payload.activeEscrowTotal).toBe(1000);
    expect(payload.balance).toBe(4000);

    creditCashOutWithEscrowSettle(nk, 'match-live', 'user1', 1000, logger);
    expect(getActiveEscrowTotal(nk, 'user1', logger)).toBe(0);
  });
});
