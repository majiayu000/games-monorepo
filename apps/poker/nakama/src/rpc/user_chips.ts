/**
 * User Chips RPC Functions
 * Manages user chip balances using Nakama Storage
 */

// Storage collection and key for user chips
const CHIPS_COLLECTION = 'user_data';
const CHIPS_KEY = 'chips';

// Default starting chips for new users
export const DEFAULT_STARTING_CHIPS = 10000;

// Buy-in bounds for table seats / private matches
export const MIN_BUY_IN = 100;
export const MAX_STARTING_CHIPS = DEFAULT_STARTING_CHIPS;

interface UserChipsData {
  balance: number;
  totalWon: number;
  totalLost: number;
  handsPlayed: number;
  handsWon: number;
  lastUpdated: number;
  createdAt: number;
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

// Helper to get or initialize user chips
function getUserChips(
  nk: nkruntime.Nakama,
  userId: string,
  logger: nkruntime.Logger
): UserChipsData {
  const objects = nk.storageRead([
    {
      collection: CHIPS_COLLECTION,
      key: CHIPS_KEY,
      userId: userId,
    },
  ]);

  if (objects.length > 0 && objects[0].value) {
    return objects[0].value as UserChipsData;
  }

  // Initialize new user with starting chips
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

  nk.storageWrite([
    {
      collection: CHIPS_COLLECTION,
      key: CHIPS_KEY,
      userId: userId,
      value: initialData,
      permissionRead: 1, // Owner read
      permissionWrite: 0, // No client write
    },
  ]);

  logger.info(`Initialized new user ${userId} with ${DEFAULT_STARTING_CHIPS} chips`);
  return initialData;
}

// Helper to save user chips
function saveUserChips(
  nk: nkruntime.Nakama,
  userId: string,
  data: UserChipsData
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
    },
  ]);
}

/**
 * Read wallet balance (initializes storage for new users).
 */
export function getWalletBalance(
  nk: nkruntime.Nakama,
  userId: string,
  logger: nkruntime.Logger
): number {
  return getUserChips(nk, userId, logger).balance;
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
  const chipsData = getUserChips(nk, userId, logger);
  const previousBalance = chipsData.balance;

  if (chipsData.balance < buyIn) {
    throw new Error('Insufficient chips for buy-in');
  }

  chipsData.balance -= buyIn;
  saveUserChips(nk, userId, chipsData);
  logger.info(
    `User ${userId} buy-in debit: ${previousBalance} -> ${chipsData.balance} (amount: ${buyIn})`
  );

  return {
    balance: chipsData.balance,
    previousBalance,
    change: chipsData.balance - previousBalance,
  };
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
  const chipsData = getUserChips(nk, userId, logger);
  const previousBalance = chipsData.balance;

  chipsData.balance += credit;
  saveUserChips(nk, userId, chipsData);
  logger.info(
    `User ${userId} cash-out credit: ${previousBalance} -> ${chipsData.balance} (amount: ${credit})`
  );

  return {
    balance: chipsData.balance,
    previousBalance,
    change: chipsData.balance - previousBalance,
  };
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

  const chipsData = getUserChips(nk, userId, logger);

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

  if (rewardObjects.length > 0 && rewardObjects[0].value) {
    lastClaimTime = (rewardObjects[0].value as { lastClaim: number }).lastClaim || 0;
  }

  const timeSinceLastClaim = now - lastClaimTime;
  const nextRewardTime = lastClaimTime + REWARD_COOLDOWN_MS;

  if (timeSinceLastClaim < REWARD_COOLDOWN_MS) {
    const hoursRemaining = Math.ceil((REWARD_COOLDOWN_MS - timeSinceLastClaim) / (60 * 60 * 1000));

    const chipsData = getUserChips(nk, userId, logger);
    const response: DailyRewardResponse = {
      rewarded: false,
      amount: 0,
      balance: chipsData.balance,
      nextRewardTime,
      message: `Come back in ${hoursRemaining} hour(s) for your daily reward!`,
    };
    return JSON.stringify(response);
  }

  // Give the reward
  const chipsData = getUserChips(nk, userId, logger);
  chipsData.balance += DAILY_REWARD_AMOUNT;
  saveUserChips(nk, userId, chipsData);

  // Update last claim time
  nk.storageWrite([
    {
      collection: CHIPS_COLLECTION,
      key: DAILY_REWARD_KEY,
      userId: userId,
      value: { lastClaim: now },
      permissionRead: 1,
      permissionWrite: 0,
    },
  ]);

  logger.info(`User ${userId} claimed daily reward: ${DAILY_REWARD_AMOUNT} chips`);

  const response: DailyRewardResponse = {
    rewarded: true,
    amount: DAILY_REWARD_AMOUNT,
    balance: chipsData.balance,
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
