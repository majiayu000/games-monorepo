/**
 * Achievement update helper tests (SEC-03)
 * Ensures unlocks are driven by server-built outcome fields, not client payloads.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  applyAchievementUpdates,
  readAchievements,
} from '../werewolf/achievements';
import {
  AchievementId,
  createInitialUserStats,
  Faction,
  Role,
  ACHIEVEMENT_CONFIG,
} from '../werewolf/types';

function createMockLogger(): nkruntime.Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as nkruntime.Logger;
}

function createMockNk(options?: {
  achievementsByUser?: Record<string, any>;
  statsByUser?: Record<string, any>;
}): nkruntime.Nakama {
  const achievementsByUser = options?.achievementsByUser ?? {};
  const statsByUser = options?.statsByUser ?? {};
  const writes: any[] = [];

  return {
    storageRead: (keys: nkruntime.StorageReadRequest[]) => {
      return keys.map((key) => {
        if (key.collection === ACHIEVEMENT_CONFIG.STORAGE_COLLECTION) {
          const value = achievementsByUser[key.userId];
          return value
            ? { collection: key.collection, key: key.key, userId: key.userId, value, version: '1', permissionRead: 2, permissionWrite: 0 }
            : null;
        }
        if (key.collection === 'werewolf_stats') {
          const value = statsByUser[key.userId];
          return value
            ? { collection: key.collection, key: key.key, userId: key.userId, value, version: '1', permissionRead: 2, permissionWrite: 0 }
            : null;
        }
        return null;
      }).filter(Boolean) as nkruntime.StorageObject[];
    },
    storageWrite: (reqs: nkruntime.StorageWriteRequest[]) => {
      for (const req of reqs) {
        writes.push(req);
        if (req.collection === ACHIEVEMENT_CONFIG.STORAGE_COLLECTION) {
          achievementsByUser[req.userId] = req.value;
        }
        if (req.collection === 'werewolf_stats') {
          statsByUser[req.userId] = req.value;
        }
      }
      return [];
    },
    _writes: writes,
    _achievementsByUser: achievementsByUser,
  } as unknown as nkruntime.Nakama;
}

describe('applyAchievementUpdates', () => {
  let logger: nkruntime.Logger;

  beforeEach(() => {
    logger = createMockLogger();
  });

  it('unlocks first-game and first-win from server-built stats/outcome', () => {
    const nk = createMockNk();
    const stats = createInitialUserStats('user-1');
    stats.totalGames = 1;
    stats.wins = 1;
    stats.villagerWins = 1;
    stats.winStreak = 1;

    const result = applyAchievementUpdates(nk, logger, stats, {
      userId: 'user-1',
      won: true,
      role: Role.VILLAGER,
      faction: Faction.VILLAGER,
      survived: true,
      wasSheriff: false,
      isLover: false,
      loversWon: false,
      idiotRevealed: false,
    });

    expect(result.newUnlocks.map((u) => u.achievement.id)).toContain(AchievementId.FIRST_GAME);
    expect(result.newUnlocks.map((u) => u.achievement.id)).toContain(AchievementId.FIRST_WIN);
    expect(result.totalXPGained).toBeGreaterThan(0);

    const stored = readAchievements(nk, 'user-1');
    expect(stored.achievements[AchievementId.FIRST_GAME]?.completed).toBe(true);
    expect(stored.achievements[AchievementId.FIRST_WIN]?.completed).toBe(true);
  });

  it('does not unlock skill achievements when skill flags are omitted/false', () => {
    const nk = createMockNk();
    const stats = createInitialUserStats('user-2');
    stats.totalGames = 1;
    stats.wins = 1;
    stats.roleStats[Role.WITCH] = { played: 1, wins: 1 };

    const result = applyAchievementUpdates(nk, logger, stats, {
      userId: 'user-2',
      won: true,
      role: Role.WITCH,
      faction: Faction.VILLAGER,
      survived: true,
      wasSheriff: false,
      isLover: false,
      loversWon: false,
      // skill fields intentionally omitted
    });

    const unlockedIds = result.newUnlocks.map((u) => u.achievement.id);
    expect(unlockedIds).not.toContain(AchievementId.WITCH_SAVE_10);
    expect(unlockedIds).not.toContain(AchievementId.WITCH_POISON_WOLF_10);
    expect(unlockedIds).not.toContain(AchievementId.DOUBLE_KILL_WITCH);
  });

  it('unlocks idiot reveal only when match-derived idiotRevealed and survived are true', () => {
    const nk = createMockNk();
    const stats = createInitialUserStats('user-3');
    stats.totalGames = 1;
    stats.wins = 1;
    stats.roleStats[Role.IDIOT] = { played: 1, wins: 1 };

    const withoutReveal = applyAchievementUpdates(nk, logger, { ...stats }, {
      userId: 'user-3',
      won: true,
      role: Role.IDIOT,
      faction: Faction.VILLAGER,
      survived: true,
      wasSheriff: false,
      isLover: false,
      loversWon: false,
      idiotRevealed: false,
    });
    expect(withoutReveal.newUnlocks.map((u) => u.achievement.id)).not.toContain(AchievementId.IDIOT_REVEAL);

    const withReveal = applyAchievementUpdates(nk, logger, { ...stats }, {
      userId: 'user-3',
      won: true,
      role: Role.IDIOT,
      faction: Faction.VILLAGER,
      survived: true,
      wasSheriff: false,
      isLover: false,
      loversWon: false,
      idiotRevealed: true,
    });
    expect(withReveal.newUnlocks.map((u) => u.achievement.id)).toContain(AchievementId.IDIOT_REVEAL);
  });
  it('skips SILENT_KILLER when wasExposed is omitted; grants only when explicitly false', () => {
    const nk = createMockNk();
    const stats = createInitialUserStats('user-wolf');
    stats.totalGames = 1;
    stats.wins = 1;
    stats.werewolfWins = 1;
    stats.roleStats[Role.WEREWOLF] = { played: 1, wins: 1 };

    const omitted = applyAchievementUpdates(nk, logger, { ...stats }, {
      userId: 'user-wolf',
      won: true,
      role: Role.WEREWOLF,
      faction: Faction.WEREWOLF,
      survived: true,
      wasSheriff: false,
      isLover: false,
      loversWon: false,
    });
    expect(omitted.newUnlocks.map((u) => u.achievement.id)).not.toContain(AchievementId.SILENT_KILLER);

    const exposed = applyAchievementUpdates(nk, logger, { ...stats }, {
      userId: 'user-wolf',
      won: true,
      role: Role.WEREWOLF,
      faction: Faction.WEREWOLF,
      survived: true,
      wasSheriff: false,
      isLover: false,
      loversWon: false,
      wasExposed: true,
    });
    expect(exposed.newUnlocks.map((u) => u.achievement.id)).not.toContain(AchievementId.SILENT_KILLER);

    const silent = applyAchievementUpdates(nk, logger, { ...stats }, {
      userId: 'user-wolf',
      won: true,
      role: Role.WEREWOLF,
      faction: Faction.WEREWOLF,
      survived: true,
      wasSheriff: false,
      isLover: false,
      loversWon: false,
      wasExposed: false,
    });
    expect(silent.newUnlocks.map((u) => u.achievement.id)).toContain(AchievementId.SILENT_KILLER);
  });
});

describe('update_achievements RPC removal', () => {
  it('main.ts no longer registers update_achievements', async () => {
    const mainSource = await Bun.file(
      new URL('../main.ts', import.meta.url)
    ).text();
    expect(mainSource).not.toContain("registerRpc('update_achievements'");
    expect(mainSource).not.toContain('rpcUpdateAchievements');
    expect(mainSource).toContain("registerRpc('get_achievements'");
  });

  it('main.ts no longer registers client-writable record_game_result', async () => {
    const mainSource = await Bun.file(
      new URL('../main.ts', import.meta.url)
    ).text();
    expect(mainSource).not.toContain("registerRpc('record_game_result'");
  });
});
