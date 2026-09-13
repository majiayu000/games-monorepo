/**
 * Server-side achievement progress updates.
 * Must only be invoked from authoritative match/server paths — never from client RPCs.
 */

import {
  UserStats,
  calculateLevelInfo,
  AchievementId,
  AchievementUnlock,
  UserAchievements,
  ACHIEVEMENT_DEFINITIONS,
  ACHIEVEMENT_CONFIG,
  createInitialUserAchievements,
  checkAchievementUnlock,
  Role,
  Faction,
  isWerewolf,
} from './types';

const STATS_COLLECTION = 'werewolf_stats';
const STATS_KEY = 'user_stats';

/** Match-derived outcome fields used to evaluate achievements. */
export interface AchievementGameOutcome {
  userId: string;
  won: boolean;
  role?: Role | string | null;
  faction?: Faction | string | null;
  survived: boolean;
  wasSheriff: boolean;
  isLover: boolean;
  loversWon: boolean;
  idiotRevealed?: boolean;
  /** Skill counters — leave unset/0/false when not yet derived from GameState. */
  seerCheckedWolves?: number;
  witchSaved?: boolean;
  witchPoisonedWolf?: boolean;
  guardSaved?: boolean;
  hunterKilledWolf?: boolean;
  playerFactionSize?: number;
  votedOutWolves?: number;
  wasExposed?: boolean;
}

export interface ApplyAchievementUpdatesResult {
  newUnlocks: AchievementUnlock[];
  totalXPGained: number;
  totalUnlocked: number;
}

/**
 * Helper: Read achievements from storage
 */
export function readAchievements(nk: nkruntime.Nakama, userId: string): UserAchievements {
  try {
    const objects = nk.storageRead([{
      collection: ACHIEVEMENT_CONFIG.STORAGE_COLLECTION,
      key: ACHIEVEMENT_CONFIG.STORAGE_KEY,
      userId,
    }]);

    if (objects.length > 0 && objects[0].value) {
      return objects[0].value as UserAchievements;
    }
  } catch {
    // Return initial achievements if storage doesn't exist
  }
  return createInitialUserAchievements(userId);
}

/**
 * Helper: Write achievements to storage
 */
export function writeAchievements(
  nk: nkruntime.Nakama,
  userId: string,
  achievements: UserAchievements
): void {
  nk.storageWrite([{
    collection: ACHIEVEMENT_CONFIG.STORAGE_COLLECTION,
    key: ACHIEVEMENT_CONFIG.STORAGE_KEY,
    userId,
    value: achievements as { [key: string]: any },
    permissionRead: 2, // Public read
    permissionWrite: 0, // Server only
  }]);
}

/**
 * Apply achievement unlocks from authoritative post-game stats and match outcome.
 * Mutates `stats` in place when achievement XP is gained; caller owns stats persistence
 * unless `persistStats` is true.
 */
export function applyAchievementUpdates(
  nk: nkruntime.Nakama,
  logger: nkruntime.Logger,
  stats: UserStats,
  outcome: AchievementGameOutcome,
  options?: { persistStats?: boolean }
): ApplyAchievementUpdatesResult {
  const {
    userId,
    won,
    role,
    faction,
    survived,
    wasSheriff,
    isLover,
    loversWon,
    idiotRevealed = false,
    seerCheckedWolves = 0,
    witchSaved = false,
    witchPoisonedWolf = false,
    guardSaved = false,
    hunterKilledWolf = false,
    playerFactionSize = 0,
    votedOutWolves = 0,
    wasExposed = false,
  } = outcome;

  logger.info(`Updating achievements for user ${userId}, won: ${won}, role: ${role}`);

  const userAchievements = readAchievements(nk, userId);
  const newUnlocks: AchievementUnlock[] = [];
  let totalXPGained = 0;

  const checkAndUnlock = (achievementId: AchievementId, currentValue: number) => {
    const progress = userAchievements.achievements[achievementId] || {
      achievementId,
      current: 0,
      required: ACHIEVEMENT_DEFINITIONS[achievementId].requirement,
      completed: false,
    };

    const result = checkAchievementUnlock(progress, currentValue);
    userAchievements.achievements[achievementId] = result.progress;

    if (result.unlocked) {
      const definition = ACHIEVEMENT_DEFINITIONS[achievementId];
      newUnlocks.push({
        achievement: definition,
        progress: result.progress,
        xpEarned: definition.xpReward,
      });
      totalXPGained += definition.xpReward;
      userAchievements.totalUnlocked++;
      logger.info(`User ${userId} unlocked achievement: ${definition.name}`);
    }
  };

  const incrementAndCheck = (achievementId: AchievementId) => {
    const progress = userAchievements.achievements[achievementId] || {
      achievementId,
      current: 0,
      required: ACHIEVEMENT_DEFINITIONS[achievementId].requirement,
      completed: false,
    };
    if (!progress.completed) {
      checkAndUnlock(achievementId, progress.current + 1);
    }
  };

  // ==================== Check Beginner Achievements ====================
  checkAndUnlock(AchievementId.FIRST_GAME, stats.totalGames);

  if (won) {
    checkAndUnlock(AchievementId.FIRST_WIN, stats.wins);
  }

  if (won && faction === Faction.WEREWOLF) {
    checkAndUnlock(AchievementId.FIRST_WOLF_WIN, stats.werewolfWins);
  }

  if (won && (faction === Faction.VILLAGER || faction === 'villager')) {
    checkAndUnlock(AchievementId.FIRST_VILLAGER_WIN, stats.villagerWins);
  }

  // ==================== Check Games Achievements ====================
  checkAndUnlock(AchievementId.GAMES_10, stats.totalGames);
  checkAndUnlock(AchievementId.GAMES_50, stats.totalGames);
  checkAndUnlock(AchievementId.GAMES_100, stats.totalGames);
  checkAndUnlock(AchievementId.GAMES_500, stats.totalGames);
  checkAndUnlock(AchievementId.GAMES_1000, stats.totalGames);

  // ==================== Check Wins Achievements ====================
  checkAndUnlock(AchievementId.WINS_10, stats.wins);
  checkAndUnlock(AchievementId.WINS_50, stats.wins);
  checkAndUnlock(AchievementId.WINS_100, stats.wins);
  checkAndUnlock(AchievementId.WINS_500, stats.wins);

  // ==================== Check Win Streak Achievements ====================
  if (won) {
    checkAndUnlock(AchievementId.WIN_STREAK_3, stats.winStreak || 0);
    checkAndUnlock(AchievementId.WIN_STREAK_5, stats.winStreak || 0);
    checkAndUnlock(AchievementId.WIN_STREAK_10, stats.winStreak || 0);
    checkAndUnlock(AchievementId.WIN_STREAK_20, stats.winStreak || 0);
  }

  // ==================== Check Role Master Achievements ====================
  if (won && role) {
    const roleStats = stats.roleStats[role];
    if (roleStats) {
      switch (role) {
        case Role.VILLAGER:
          checkAndUnlock(AchievementId.VILLAGER_MASTER, roleStats.wins);
          break;
        case Role.SEER:
          checkAndUnlock(AchievementId.SEER_MASTER, roleStats.wins);
          break;
        case Role.WITCH:
          checkAndUnlock(AchievementId.WITCH_MASTER, roleStats.wins);
          break;
        case Role.HUNTER:
          checkAndUnlock(AchievementId.HUNTER_MASTER, roleStats.wins);
          break;
        case Role.GUARD:
          checkAndUnlock(AchievementId.GUARD_MASTER, roleStats.wins);
          break;
        case Role.IDIOT:
          checkAndUnlock(AchievementId.IDIOT_MASTER, roleStats.wins);
          break;
        case Role.WEREWOLF:
          checkAndUnlock(AchievementId.WEREWOLF_MASTER, roleStats.wins);
          break;
        case Role.ALPHA_WOLF:
          checkAndUnlock(AchievementId.ALPHA_WOLF_MASTER, roleStats.wins);
          break;
        case Role.CUPID:
          checkAndUnlock(AchievementId.CUPID_MASTER, roleStats.wins);
          break;
      }
    }
  }

  // ==================== Check Skill Achievements ====================
  if (role === Role.SEER && seerCheckedWolves > 0) {
    const currentProgress = userAchievements.achievements[AchievementId.SEER_CORRECT_10]?.current || 0;
    const newTotal = currentProgress + seerCheckedWolves;
    checkAndUnlock(AchievementId.SEER_CORRECT_10, newTotal);
    checkAndUnlock(AchievementId.SEER_CORRECT_50, newTotal);
  }

  if (role === Role.WITCH && witchSaved) {
    incrementAndCheck(AchievementId.WITCH_SAVE_10);
  }

  if (role === Role.WITCH && witchPoisonedWolf) {
    incrementAndCheck(AchievementId.WITCH_POISON_WOLF_10);
  }

  if (role === Role.GUARD && guardSaved) {
    incrementAndCheck(AchievementId.GUARD_SAVE_10);
  }

  if ((role === Role.HUNTER || role === Role.ALPHA_WOLF) && hunterKilledWolf) {
    incrementAndCheck(AchievementId.HUNTER_KILL_WOLF_10);
  }

  // ==================== Check Sheriff Achievements ====================
  if (wasSheriff) {
    checkAndUnlock(AchievementId.SHERIFF_ELECTED_10, stats.gamesAsSheriff);
    if (won) {
      checkAndUnlock(AchievementId.SHERIFF_WIN_10, stats.sheriffWins);
    }
  }

  // ==================== Check Special Achievements ====================
  if (isLover && loversWon) {
    incrementAndCheck(AchievementId.LOVER_VICTORY);
  }

  if (role === Role.IDIOT && idiotRevealed && survived) {
    incrementAndCheck(AchievementId.IDIOT_REVEAL);
  }

  if (role === Role.WITCH && witchSaved && witchPoisonedWolf) {
    incrementAndCheck(AchievementId.DOUBLE_KILL_WITCH);
  }

  if (won && role && !isWerewolf(role as Role) && votedOutWolves >= 2) {
    incrementAndCheck(AchievementId.WOLF_EXTERMINATOR);
  }

  if (won && role && isWerewolf(role as Role) && !wasExposed) {
    incrementAndCheck(AchievementId.SILENT_KILLER);
  }

  if (won && role && !isWerewolf(role as Role) && playerFactionSize === 1) {
    incrementAndCheck(AchievementId.LAST_STAND);
  }

  if (won && playerFactionSize === 1) {
    incrementAndCheck(AchievementId.COMEBACK_KING);
  }

  // ==================== Check Survival Achievements ====================
  if (survived) {
    const survivalProgress = userAchievements.achievements[AchievementId.SURVIVOR_10]?.current || 0;
    const newSurvivals = survivalProgress + 1;
    checkAndUnlock(AchievementId.SURVIVOR_10, newSurvivals);
    checkAndUnlock(AchievementId.SURVIVOR_50, newSurvivals);
  }

  // ==================== Check Level Achievements ====================
  const levelInfo = calculateLevelInfo(stats.totalXP || 0);
  checkAndUnlock(AchievementId.LEVEL_10, levelInfo.level);
  checkAndUnlock(AchievementId.LEVEL_25, levelInfo.level);
  checkAndUnlock(AchievementId.LEVEL_50, levelInfo.level);
  checkAndUnlock(AchievementId.LEVEL_75, levelInfo.level);
  checkAndUnlock(AchievementId.LEVEL_100, levelInfo.level);

  // ==================== Save achievements ====================
  userAchievements.totalXPFromAchievements += totalXPGained;
  userAchievements.lastUpdated = Date.now();
  writeAchievements(nk, userId, userAchievements);

  if (totalXPGained > 0) {
    stats.totalXP = (stats.totalXP || 0) + totalXPGained;
    const newLevelInfo = calculateLevelInfo(stats.totalXP);
    stats.level = newLevelInfo.level;
    stats.currentXP = newLevelInfo.currentXP;

    if (options?.persistStats) {
      nk.storageWrite([{
        collection: STATS_COLLECTION,
        key: STATS_KEY,
        userId,
        value: stats as { [key: string]: any },
        permissionRead: 2,
        permissionWrite: 0,
      }]);
    }
  }

  return {
    newUnlocks,
    totalXPGained,
    totalUnlocked: userAchievements.totalUnlocked,
  };
}
