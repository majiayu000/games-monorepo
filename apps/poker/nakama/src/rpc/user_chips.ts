/**
 * User Chips RPC Functions
 * Manages user chip balances using Nakama Storage with version-guarded writes.
 */

// Storage collection and key for user chips
const CHIPS_COLLECTION = 'user_data';
const CHIPS_KEY = 'chips';
const ESCROW_COLLECTION = 'match_escrow';

// Default starting chips for new users
export const DEFAULT_STARTING_CHIPS = 10000;

// Buy-in bounds for table seats / private matches
export const MIN_BUY_IN = 100;
export const MAX_STARTING_CHIPS = DEFAULT_STARTING_CHIPS;

/** Max retries for optimistic-concurrency storage conflicts */
const WALLET_WRITE_MAX_ATTEMPTS = 8;

interface UserChipsData {
  balance: number;
  totalWon: number;
  totalLost: number;
  handsPlayed: number;
  handsWon: number;
  lastUpdated: number;
  createdAt: number;
}

interface StoredChips {
  data: UserChipsData;
  /** Nakama OCC version; '*' means create-only / unconditional create path */
  version: string;
}

interface GetChipsResponse {
  balance: number;
  totalWon: number;
  totalLost: number;
  handsPlayed: number;
  handsWon: number;
}

interface DailyRewardResponse {
  rewarded: boolean;
  amount: number;
  balance: number;
  nextRewardTime: number;
  message: string;
}

export interface WalletMutationResult {
  balance: number;
  previousBalance: number;
  change: number;
}

export interface MatchEscrowRecord {
  matchId: string;
  userId: string;
  amount: number;
  status: 'active' | 'settled';
  createdAt: number;
  updatedAt: number;
}

export type MatchLiveness = 'alive' | 'dead' | 'unknown';

export const POKER_LEADERBOARD_ID = 'poker_total_won';

function isVersionConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  return (
    lower.includes('version') ||
    lower.includes('conflict') ||
    lower.includes('concurrent') ||
    lower.includes('cas')
  );
}

function escrowKey(matchId: string): string {
  return `escrow:${matchId}`;
}

// Helper to get or initialize user chips (with storage version for OCC)
function getUserChips(
  nk: nkruntime.Nakama,
  userId: string,
  logger: nkruntime.Logger
): StoredChips {
  const objects = nk.storageRead([
    {
      collection: CHIPS_COLLECTION,
      key: CHIPS_KEY,
      userId: userId,
    },
  ]);

  if (objects.length > 0 && objects[0].value) {
    return {
      data: objects[0].value as UserChipsData,
      version: objects[0].version || '*',
    };
  }

  // Initialize new user with starting chips (create-only via version '*')
  const now = Date.now();
  const initialData: UserChipsData = {
    balance: DEFAULT_STARTING_CHIPS,
    totalWon: 0,
    totalLost: 0,
    handsPlayed: 0,
    handsWon: 0,
    lastUpdated: now,
    createdAt: now,
  };

  try {
    const acks = nk.storageWrite([
      {
        collection: CHIPS_COLLECTION,
        key: CHIPS_KEY,
        userId: userId,
        value: initialData,
        permissionRead: 1, // Owner read
        permissionWrite: 0, // No client write
        version: '*', // create-only — concurrent init loses and retries via caller
      },
    ]);
    logger.info(`Initialized new user ${userId} with ${DEFAULT_STARTING_CHIPS} chips`);
    return {
      data: initialData,
      version: (acks && acks[0] && acks[0].version) || '1',
    };
  } catch (e) {
    if (!isVersionConflict(e)) {
      throw e;
    }
    // Another writer created the object; re-read
    const retry = nk.storageRead([
      {
        collection: CHIPS_COLLECTION,
        key: CHIPS_KEY,
        userId: userId,
      },
    ]);
    if (retry.length > 0 && retry[0].value) {
      return {
        data: retry[0].value as UserChipsData,
        version: retry[0].version || '1',
      };
    }
    throw e;
  }
}

// Helper to save user chips with optimistic concurrency
function saveUserChips(
  nk: nkruntime.Nakama,
  userId: string,
  data: UserChipsData,
  version: string
): void {
  data.lastUpdated = Date.now();

  nk.storageWrite([
    {
      collection: CHIPS_COLLECTION,
      key: CHIPS_KEY,
      userId: userId,
      value: data,
      permissionRead: 1,
      permissionWrite: 0,
      version,
    },
  ]);
}

function mutateWallet(
  nk: nkruntime.Nakama,
  userId: string,
  logger: nkruntime.Logger,
  mutate: (data: UserChipsData) => void
): WalletMutationResult {
  let lastError: unknown;

  for (let attempt = 1; attempt <= WALLET_WRITE_MAX_ATTEMPTS; attempt++) {
    try {
      const stored = getUserChips(nk, userId, logger);
      const previousBalance = stored.data.balance;
      const next: UserChipsData = { ...stored.data };
      mutate(next);
      saveUserChips(nk, userId, next, stored.version);
      return {
        balance: next.balance,
        previousBalance,
        change: next.balance - previousBalance,
      };
    } catch (e) {
      lastError = e;
      if (!isVersionConflict(e) || attempt === WALLET_WRITE_MAX_ATTEMPTS) {
        throw e;
      }
      logger.warn(
        `Wallet write conflict for ${userId}, retrying (${attempt}/${WALLET_WRITE_MAX_ATTEMPTS})`
      );
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Read wallet balance (initializes storage for new users).
 */
export function getWalletBalance(
  nk: nkruntime.Nakama,
  userId: string,
  logger: nkruntime.Logger
): number {
  return getUserChips(nk, userId, logger).data.balance;
}

/**
 * Clamp table buy-in / private-match starting chips to server bounds.
 */
export function clampStartingChips(value: number): number {
  if (!Number.isFinite(value)) {
    return MIN_BUY_IN;
  }
  return Math.min(Math.max(Math.floor(value), MIN_BUY_IN), MAX_STARTING_CHIPS);
}

/**
 * Persist durable match escrow so buy-ins can be reconciled after a crash.
 * Uses unconditional writes (last-write-wins) for mid-match amount refreshes.
 */
export function writeMatchEscrow(
  nk: nkruntime.Nakama,
  matchId: string,
  userId: string,
  amount: number,
  logger: nkruntime.Logger
): void {
  writeMatchEscrowBatch(nk, matchId, [{ userId, amount }], logger);
}

/**
 * Persist a full post-hand escrow checkpoint for every seated player in one
 * storageWrite so a mid-loop crash cannot leave mixed pre/post-hand amounts.
 */
export function writeMatchEscrowBatch(
  nk: nkruntime.Nakama,
  matchId: string,
  entries: { userId: string; amount: number }[],
  logger: nkruntime.Logger
): void {
  if (!matchId || entries.length === 0) {
    return;
  }

  const now = Date.now();
  const reads = nk.storageRead(
    entries
      .filter((entry) => !!entry.userId)
      .map((entry) => ({
        collection: ESCROW_COLLECTION,
        key: escrowKey(matchId),
        userId: entry.userId,
      }))
  );
  const previousByUser = new Map<string, MatchEscrowRecord>();
  for (const obj of reads) {
    if (obj.value) {
      previousByUser.set(obj.userId, obj.value as MatchEscrowRecord);
    }
  }

  const writes = entries
    .filter((entry) => !!entry.userId)
    .map((entry) => {
      const credit = Math.max(0, Math.floor(entry.amount));
      const previous = previousByUser.get(entry.userId) || null;
      const record: MatchEscrowRecord = {
        matchId,
        userId: entry.userId,
        amount: credit,
        status: 'active',
        createdAt: previous?.createdAt || now,
        updatedAt: now,
      };
      return {
        collection: ESCROW_COLLECTION,
        key: escrowKey(matchId),
        userId: entry.userId,
        value: record,
        permissionRead: 1,
        permissionWrite: 0,
      };
    });

  if (writes.length === 0) {
    return;
  }

  try {
    nk.storageWrite(writes as nkruntime.StorageWriteRequest[]);
    logger.info(
      `Wrote match escrow batch for ${matchId}: ${writes
        .map((w) => `${w.userId}=${(w.value as MatchEscrowRecord).amount}`)
        .join(',')}`
    );
  } catch (e) {
    logger.error(`Failed to write match escrow batch for ${matchId}: ${e}`);
    throw e;
  }
}

/**
 * Atomically debit wallet and create/update match escrow in one storageWrite.
 * Avoids the debit-without-escrow window if the process dies mid-join.
 */
export function debitBuyInWithEscrow(
  nk: nkruntime.Nakama,
  userId: string,
  matchId: string,
  amount: number,
  logger: nkruntime.Logger
): WalletMutationResult {
  if (!matchId) {
    throw new Error('Match id is required for escrowed buy-in');
  }
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < MIN_BUY_IN) {
    throw new Error(`Minimum buy-in is ${MIN_BUY_IN} chips`);
  }

  const buyIn = Math.floor(amount);
  let lastError: unknown;

  for (let attempt = 1; attempt <= WALLET_WRITE_MAX_ATTEMPTS; attempt++) {
    try {
      const stored = getUserChips(nk, userId, logger);
      if (stored.data.balance < buyIn) {
        throw new Error('Insufficient chips for buy-in');
      }

      const previousBalance = stored.data.balance;
      const next: UserChipsData = { ...stored.data, balance: previousBalance - buyIn };
      next.lastUpdated = Date.now();

      const now = Date.now();
      const existingEscrow = nk.storageRead([
        {
          collection: ESCROW_COLLECTION,
          key: escrowKey(matchId),
          userId,
        },
      ]);
      const previous =
        existingEscrow.length > 0 && existingEscrow[0].value
          ? (existingEscrow[0].value as MatchEscrowRecord)
          : null;

      const escrowRecord: MatchEscrowRecord = {
        matchId,
        userId,
        amount: buyIn,
        status: 'active',
        createdAt: previous?.createdAt || now,
        updatedAt: now,
      };

      // Single multi-object write: wallet debit + escrow succeed or fail together
      nk.storageWrite([
        {
          collection: CHIPS_COLLECTION,
          key: CHIPS_KEY,
          userId,
          value: next,
          permissionRead: 1,
          permissionWrite: 0,
          version: stored.version,
        },
        {
          collection: ESCROW_COLLECTION,
          key: escrowKey(matchId),
          userId,
          value: escrowRecord,
          permissionRead: 1,
          permissionWrite: 0,
        },
      ]);

      logger.info(
        `User ${userId} escrowed buy-in in ${matchId}: ${previousBalance} -> ${next.balance} (amount: ${buyIn})`
      );

      return {
        balance: next.balance,
        previousBalance,
        change: next.balance - previousBalance,
      };
    } catch (e) {
      lastError = e;
      if (
        e instanceof Error &&
        (e.message === 'Insufficient chips for buy-in' ||
          e.message.startsWith('Minimum buy-in'))
      ) {
        throw e;
      }
      if (!isVersionConflict(e) || attempt === WALLET_WRITE_MAX_ATTEMPTS) {
        throw e;
      }
      logger.warn(
        `Escrowed buy-in conflict for ${userId}, retrying (${attempt}/${WALLET_WRITE_MAX_ATTEMPTS})`
      );
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Distinguish a successful null matchGet (dead) from a transient lookup error.
 * Unknown liveness must not trigger escrow refunds.
 */
export function getMatchLiveness(
  nk: nkruntime.Nakama,
  matchId: string
): MatchLiveness {
  try {
    const match = nk.matchGet(matchId);
    return match ? 'alive' : 'dead';
  } catch {
    return 'unknown';
  }
}

/**
 * Atomically credit wallet and claim escrow (status -> settled) with OCC versions.
 * Only one concurrent reconciler can win the escrow version race.
 */
function claimOrphanedEscrowRefund(
  nk: nkruntime.Nakama,
  userId: string,
  matchId: string,
  escrowVersion: string,
  amount: number,
  logger: nkruntime.Logger
): number {
  const credit = Math.max(0, Math.floor(amount));
  let lastError: unknown;

  for (let attempt = 1; attempt <= WALLET_WRITE_MAX_ATTEMPTS; attempt++) {
    try {
      // Re-read escrow — may already be claimed by a concurrent reconciler
      const escrowObjects = nk.storageRead([
        {
          collection: ESCROW_COLLECTION,
          key: escrowKey(matchId),
          userId,
        },
      ]);
      if (escrowObjects.length === 0 || !escrowObjects[0].value) {
        return 0;
      }
      const current = escrowObjects[0].value as MatchEscrowRecord;
      if (current.status !== 'active') {
        return 0;
      }
      const version = escrowObjects[0].version || escrowVersion;
      const claimAmount = Math.max(0, Math.floor(current.amount || credit));

      const stored = getUserChips(nk, userId, logger);
      const previousBalance = stored.data.balance;
      const nextWallet: UserChipsData = {
        ...stored.data,
        balance: previousBalance + claimAmount,
      };
      nextWallet.lastUpdated = Date.now();

      const settled: MatchEscrowRecord = {
        ...current,
        status: 'settled',
        updatedAt: Date.now(),
      };

      // Single multi-object write: wallet credit + escrow claim succeed or fail together
      nk.storageWrite([
        {
          collection: CHIPS_COLLECTION,
          key: CHIPS_KEY,
          userId,
          value: nextWallet,
          permissionRead: 1,
          permissionWrite: 0,
          version: stored.version,
        },
        {
          collection: ESCROW_COLLECTION,
          key: escrowKey(matchId),
          userId,
          value: settled,
          permissionRead: 1,
          permissionWrite: 0,
          version,
        },
      ]);

      // Best-effort cleanup of the settled claim marker
      clearMatchEscrow(nk, matchId, userId, logger);

      logger.info(
        `Reconciled orphaned escrow for ${userId} match ${matchId}: +${claimAmount} (${previousBalance} -> ${nextWallet.balance})`
      );
      return claimAmount;
    } catch (e) {
      lastError = e;
      if (!isVersionConflict(e) || attempt === WALLET_WRITE_MAX_ATTEMPTS) {
        throw e;
      }
      logger.warn(
        `Orphaned escrow claim conflict for ${userId} match ${matchId}, retrying (${attempt}/${WALLET_WRITE_MAX_ATTEMPTS})`
      );
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Credit back active escrow records whose matches are no longer running.
 * Called from get_chips so crash-orphaned buy-ins are recovered on next wallet read.
 */
export function reconcileOrphanedEscrows(
  nk: nkruntime.Nakama,
  userId: string,
  logger: nkruntime.Logger
): number {
  if (!userId) {
    return 0;
  }

  let refunded = 0;
  let cursor: string | undefined;

  do {
    let listed: nkruntime.StorageObjectList;
    try {
      listed = nk.storageList(userId, ESCROW_COLLECTION, 100, cursor);
    } catch (e) {
      logger.warn(`Failed to list escrow for ${userId}: ${e}`);
      return refunded;
    }

    const objects = listed.objects || [];
    for (const obj of objects) {
      const record = obj.value as MatchEscrowRecord | undefined;
      if (!record || record.status !== 'active' || !record.matchId) {
        continue;
      }

      const liveness = getMatchLiveness(nk, record.matchId);
      if (liveness === 'alive') {
        continue;
      }
      if (liveness === 'unknown') {
        logger.warn(
          `Skipping escrow reconcile for ${userId} match ${record.matchId}: match liveness unknown`
        );
        continue;
      }

      const amount = Math.max(0, Math.floor(record.amount || 0));
      try {
        refunded += claimOrphanedEscrowRefund(
          nk,
          userId,
          record.matchId,
          obj.version || '*',
          amount,
          logger
        );
      } catch (e) {
        logger.error(
          `Failed to claim orphaned escrow for ${userId} match ${record.matchId}: ${e}`
        );
      }
    }

    cursor = listed.cursor || undefined;
  } while (cursor);

  return refunded;
}

/**
 * Clear match escrow after a successful cash-out / settlement.
 */
export function clearMatchEscrow(
  nk: nkruntime.Nakama,
  matchId: string,
  userId: string,
  logger: nkruntime.Logger
): void {
  if (!matchId || !userId) {
    return;
  }
  try {
    nk.storageDelete([
      {
        collection: ESCROW_COLLECTION,
        key: escrowKey(matchId),
        userId,
      },
    ]);
    logger.info(`Cleared match escrow for ${userId} in ${matchId}`);
  } catch (e) {
    logger.warn(`Failed to clear match escrow for ${userId} in ${matchId}: ${e}`);
  }
}

/**
 * Server-internal: debit wallet for table buy-in. Does not mint chips.
 */
export function debitBuyIn(
  nk: nkruntime.Nakama,
  userId: string,
  amount: number,
  logger: nkruntime.Logger
): WalletMutationResult {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < MIN_BUY_IN) {
    throw new Error(`Minimum buy-in is ${MIN_BUY_IN} chips`);
  }

  const buyIn = Math.floor(amount);
  const result = mutateWallet(nk, userId, logger, (chipsData) => {
    if (chipsData.balance < buyIn) {
      throw new Error('Insufficient chips for buy-in');
    }
    chipsData.balance -= buyIn;
  });

  logger.info(
    `User ${userId} buy-in debit: ${result.previousBalance} -> ${result.balance} (amount: ${buyIn})`
  );

  return result;
}

/**
 * Server-internal: credit remaining table chips back to wallet on cash-out.
 */
export function creditCashOut(
  nk: nkruntime.Nakama,
  userId: string,
  amount: number,
  logger: nkruntime.Logger
): WalletMutationResult {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
    throw new Error('Cash out amount must be non-negative');
  }

  const credit = Math.floor(amount);
  const result = mutateWallet(nk, userId, logger, (chipsData) => {
    chipsData.balance += credit;
  });

  logger.info(
    `User ${userId} cash-out credit: ${result.previousBalance} -> ${result.balance} (amount: ${credit})`
  );

  return result;
}

/**
 * Get user's chip balance and stats.
 * Also reconciles orphaned match escrow left behind by crash/shutdown.
 */
export const getChipsRpc: nkruntime.RpcFunction = (
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  _payload: string
): string => {
  const userId = ctx.userId;
  if (!userId) {
    throw new Error('User not authenticated');
  }

  reconcileOrphanedEscrows(nk, userId, logger);
  const chipsData = getUserChips(nk, userId, logger).data;

  const response: GetChipsResponse = {
    balance: chipsData.balance,
    totalWon: chipsData.totalWon,
    totalLost: chipsData.totalLost,
    handsPlayed: chipsData.handsPlayed,
    handsWon: chipsData.handsWon,
  };

  return JSON.stringify(response);
};

/**
 * Legacy client-callable update_chips — hard-rejected to prevent balance minting.
 * Wallet mutations must go through debitBuyIn / creditCashOut from match handlers.
 */
export const updateChipsRpc: nkruntime.RpcFunction = (
  _ctx: nkruntime.Context,
  _logger: nkruntime.Logger,
  _nk: nkruntime.Nakama,
  _payload: string
): string => {
  throw new Error('update_chips is not available to clients');
};

/**
 * Claim daily reward
 * Players can claim once every 24 hours.
 * Cooldown claim and wallet credit are written in one atomic storageWrite.
 */
export const claimDailyRewardRpc: nkruntime.RpcFunction = (
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  _payload: string
): string => {
  const userId = ctx.userId;
  if (!userId) {
    throw new Error('User not authenticated');
  }

  const DAILY_REWARD_KEY = 'daily_reward';
  const DAILY_REWARD_AMOUNT = 500;
  const REWARD_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours

  let lastError: unknown;

  for (let attempt = 1; attempt <= WALLET_WRITE_MAX_ATTEMPTS; attempt++) {
    const now = Date.now();

    const rewardObjects = nk.storageRead([
      {
        collection: CHIPS_COLLECTION,
        key: DAILY_REWARD_KEY,
        userId: userId,
      },
    ]);

    let lastClaimTime = 0;
    let rewardVersion: string | undefined;
    if (rewardObjects.length > 0 && rewardObjects[0].value) {
      lastClaimTime = (rewardObjects[0].value as { lastClaim: number }).lastClaim || 0;
      rewardVersion = rewardObjects[0].version;
    }

    const timeSinceLastClaim = now - lastClaimTime;
    const nextRewardTime = lastClaimTime + REWARD_COOLDOWN_MS;

    if (timeSinceLastClaim < REWARD_COOLDOWN_MS) {
      const hoursRemaining = Math.ceil(
        (REWARD_COOLDOWN_MS - timeSinceLastClaim) / (60 * 60 * 1000)
      );
      const chipsData = getUserChips(nk, userId, logger).data;
      const response: DailyRewardResponse = {
        rewarded: false,
        amount: 0,
        balance: chipsData.balance,
        nextRewardTime,
        message: `Come back in ${hoursRemaining} hour(s) for your daily reward!`,
      };
      return JSON.stringify(response);
    }

    try {
      const stored = getUserChips(nk, userId, logger);
      const previousBalance = stored.data.balance;
      const next: UserChipsData = {
        ...stored.data,
        balance: previousBalance + DAILY_REWARD_AMOUNT,
      };
      next.lastUpdated = now;

      // Atomic: wallet credit + cooldown claim succeed or fail together
      nk.storageWrite([
        {
          collection: CHIPS_COLLECTION,
          key: CHIPS_KEY,
          userId,
          value: next,
          permissionRead: 1,
          permissionWrite: 0,
          version: stored.version,
        },
        {
          collection: CHIPS_COLLECTION,
          key: DAILY_REWARD_KEY,
          userId,
          value: { lastClaim: now },
          permissionRead: 1,
          permissionWrite: 0,
          version: rewardVersion || '*',
        },
      ]);

      logger.info(`User ${userId} claimed daily reward: ${DAILY_REWARD_AMOUNT} chips`);

      const response: DailyRewardResponse = {
        rewarded: true,
        amount: DAILY_REWARD_AMOUNT,
        balance: next.balance,
        nextRewardTime: now + REWARD_COOLDOWN_MS,
        message: `You received ${DAILY_REWARD_AMOUNT} chips!`,
      };
      return JSON.stringify(response);
    } catch (e) {
      lastError = e;
      if (!isVersionConflict(e) || attempt === WALLET_WRITE_MAX_ATTEMPTS) {
        throw e;
      }
      logger.warn(
        `Daily reward conflict for ${userId}, retrying (${attempt}/${WALLET_WRITE_MAX_ATTEMPTS})`
      );
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
};

/**
 * Authoritative hand bookkeeping after a hand resolves (replaces client update_chips).
 */
export function recordHandStatistics(
  nk: nkruntime.Nakama,
  userId: string,
  netChange: number,
  wonHand: boolean,
  logger: nkruntime.Logger
): void {
  mutateWallet(nk, userId, logger, (chipsData) => {
    chipsData.handsPlayed += 1;
    if (wonHand) {
      chipsData.handsWon += 1;
    }
    if (netChange > 0) {
      chipsData.totalWon += netChange;
    } else if (netChange < 0) {
      chipsData.totalLost += Math.abs(netChange);
    }
  });

  const chipsData = getUserChips(nk, userId, logger).data;
  updateLeaderboardScore(nk, userId, chipsData.totalWon, logger);
}

/**
 * Get leaderboard data
 * Returns top players by total chips won
 */
export const getLeaderboardRpc: nkruntime.RpcFunction = (
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  payload: string
): string => {
  let limit = 10;

  try {
    const request = JSON.parse(payload || '{}');
    if (request.limit && typeof request.limit === 'number') {
      limit = Math.min(Math.max(request.limit, 1), 100);
    }
  } catch {
    // Use default limit
  }

  ensurePokerLeaderboard(nk, logger);

  // Get leaderboard records
  const result = nk.leaderboardRecordsList(
    POKER_LEADERBOARD_ID,
    [], // owner IDs (empty = all)
    limit,
    undefined, // cursor
    0 // expiry (0 = no expiry filter)
  );

  const leaderboard = (result.records || []).map((record, index) => ({
    rank: index + 1,
    odid: record.ownerId,
    username: record.username || 'Unknown',
    totalWon: record.score,
  }));

  return JSON.stringify({ leaderboard });
};

/**
 * Ensure the career leaderboard exists (safe to call repeatedly).
 */
export function ensurePokerLeaderboard(
  nk: nkruntime.Nakama,
  logger: nkruntime.Logger
): void {
  try {
    // Use string literals — nkruntime.SortOrder/Operator enums are runtime globals
    // in Nakama but undefined under vitest, which would silently skip create.
    nk.leaderboardCreate(
      POKER_LEADERBOARD_ID,
      true, // authoritative
      'descending' as unknown as nkruntime.SortOrder,
      'set' as unknown as nkruntime.Operator,
      null, // never reset
      undefined // metadata
    );
    logger.info(`Ensured leaderboard ${POKER_LEADERBOARD_ID}`);
  } catch (e) {
    // Leaderboard already exists (or create is idempotent-conflict)
    logger.debug(`Leaderboard ensure note for ${POKER_LEADERBOARD_ID}: ${e}`);
  }
}

/**
 * Update leaderboard score (called after winning)
 */
export function updateLeaderboardScore(
  nk: nkruntime.Nakama,
  userId: string,
  totalWon: number,
  logger: nkruntime.Logger
): void {
  ensurePokerLeaderboard(nk, logger);

  try {
    nk.leaderboardRecordWrite(
      POKER_LEADERBOARD_ID,
      userId,
      undefined, // username (will use account username)
      totalWon,
      0, // subscore
      undefined // metadata
    );
    logger.debug(`Updated leaderboard for user ${userId}: ${totalWon}`);
  } catch (e) {
    logger.error(`Failed to update leaderboard: ${e}`);
  }
}
