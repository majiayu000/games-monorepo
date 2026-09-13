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
 * Uses unconditional writes (last-write-wins) so escrow never blocks a completed debit.
 */
export function writeMatchEscrow(
  nk: nkruntime.Nakama,
  matchId: string,
  userId: string,
  amount: number,
  logger: nkruntime.Logger
): void {
  if (!matchId || !userId) {
    return;
  }
  const credit = Math.max(0, Math.floor(amount));
  const now = Date.now();
  const existing = nk.storageRead([
    {
      collection: ESCROW_COLLECTION,
      key: escrowKey(matchId),
      userId,
    },
  ]);

  const previous =
    existing.length > 0 && existing[0].value
      ? (existing[0].value as MatchEscrowRecord)
      : null;

  const record: MatchEscrowRecord = {
    matchId,
    userId,
    amount: credit,
    status: 'active',
    createdAt: previous?.createdAt || now,
    updatedAt: now,
  };

  try {
    nk.storageWrite([
      {
        collection: ESCROW_COLLECTION,
        key: escrowKey(matchId),
        userId,
        value: record,
        permissionRead: 1,
        permissionWrite: 0,
        // Unconditional write — escrow is a recovery snapshot, not a balance source of truth
      },
    ]);
    logger.info(`Wrote match escrow for ${userId} in ${matchId}: ${credit}`);
  } catch (e) {
    logger.error(`Failed to write match escrow for ${userId} in ${matchId}: ${e}`);
    throw e;
  }
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
 * Get user's chip balance and stats
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
 * Players can claim once every 24 hours
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

  // Daily reward storage
  const DAILY_REWARD_KEY = 'daily_reward';
  const DAILY_REWARD_AMOUNT = 500;
  const REWARD_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours

  // Check last claim time
  const rewardObjects = nk.storageRead([
    {
      collection: CHIPS_COLLECTION,
      key: DAILY_REWARD_KEY,
      userId: userId,
    },
  ]);

  const now = Date.now();
  let lastClaimTime = 0;
  let rewardVersion: string | undefined;

  if (rewardObjects.length > 0 && rewardObjects[0].value) {
    lastClaimTime = (rewardObjects[0].value as { lastClaim: number }).lastClaim || 0;
    rewardVersion = rewardObjects[0].version;
  }

  const timeSinceLastClaim = now - lastClaimTime;
  const nextRewardTime = lastClaimTime + REWARD_COOLDOWN_MS;

  if (timeSinceLastClaim < REWARD_COOLDOWN_MS) {
    const hoursRemaining = Math.ceil((REWARD_COOLDOWN_MS - timeSinceLastClaim) / (60 * 60 * 1000));

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

  // Give the reward with version-guarded wallet write
  const walletResult = mutateWallet(nk, userId, logger, (chipsData) => {
    chipsData.balance += DAILY_REWARD_AMOUNT;
  });

  // Update last claim time (version-guarded when possible)
  nk.storageWrite([
    {
      collection: CHIPS_COLLECTION,
      key: DAILY_REWARD_KEY,
      userId: userId,
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
    balance: walletResult.balance,
    nextRewardTime: now + REWARD_COOLDOWN_MS,
    message: `You received ${DAILY_REWARD_AMOUNT} chips!`,
  };

  return JSON.stringify(response);
};

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

  // Use Nakama leaderboard for rankings
  const LEADERBOARD_ID = 'poker_total_won';

  // Ensure leaderboard exists
  try {
    nk.leaderboardCreate(
      LEADERBOARD_ID,
      true, // authoritative
      nkruntime.SortOrder.DESCENDING, // highest score wins
      nkruntime.Operator.SET, // set score directly
      null, // never reset
      undefined // metadata
    );
  } catch {
    // Leaderboard already exists
  }

  // Get leaderboard records
  const result = nk.leaderboardRecordsList(
    LEADERBOARD_ID,
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
 * Update leaderboard score (called after winning)
 */
export function updateLeaderboardScore(
  nk: nkruntime.Nakama,
  userId: string,
  totalWon: number,
  logger: nkruntime.Logger
): void {
  const LEADERBOARD_ID = 'poker_total_won';

  try {
    nk.leaderboardRecordWrite(
      LEADERBOARD_ID,
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
