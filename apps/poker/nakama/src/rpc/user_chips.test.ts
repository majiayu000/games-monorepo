/**
 * User chips helper tests (SEC-01)
 * Ensures chip mutations stay internal and are not registered as client RPCs.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { updateUserChips } from './user_chips';

const __dirname = dirname(fileURLToPath(import.meta.url));

function createMockLogger(): nkruntime.Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as nkruntime.Logger;
}

function createMockNk(initialBalance = 10000): nkruntime.Nakama & {
  _store: Record<string, unknown>;
} {
  const store: Record<string, unknown> = {};

  if (initialBalance !== null) {
    store['user_data:chips:user-1'] = {
      balance: initialBalance,
      totalWon: 0,
      totalLost: 0,
      handsPlayed: 0,
      handsWon: 0,
      lastUpdated: Date.now(),
      createdAt: Date.now(),
    };
  }

  return {
    _store: store,
    storageRead: (keys: nkruntime.StorageReadRequest[]) => {
      return keys
        .map((key) => {
          const value = store[`${key.collection}:${key.key}:${key.userId}`];
          if (!value) {
            return null;
          }
          return {
            collection: key.collection,
            key: key.key,
            userId: key.userId,
            value,
            version: '1',
            permissionRead: 1,
            permissionWrite: 0,
          };
        })
        .filter(Boolean) as nkruntime.StorageObject[];
    },
    storageWrite: (reqs: nkruntime.StorageWriteRequest[]) => {
      for (const req of reqs) {
        store[`${req.collection}:${req.key}:${req.userId}`] = req.value;
      }
      return [];
    },
  } as unknown as nkruntime.Nakama & { _store: Record<string, unknown> };
}

describe('updateUserChips', () => {
  let logger: nkruntime.Logger;

  beforeEach(() => {
    logger = createMockLogger();
  });

  it('deducts buy-in from balance when funds are sufficient', () => {
    const nk = createMockNk(10000);
    const result = updateUserChips(nk, logger, 'user-1', 500, 'buy_in');
    expect(result.previousBalance).toBe(10000);
    expect(result.balance).toBe(9500);
    expect(result.change).toBe(-500);
  });

  it('credits cash_out and win amounts on the server helper path', () => {
    const nk = createMockNk(1000);
    const cashOut = updateUserChips(nk, logger, 'user-1', 250, 'cash_out');
    expect(cashOut.balance).toBe(1250);

    const win = updateUserChips(nk, logger, 'user-1', 100, 'win');
    expect(win.balance).toBe(1350);
    expect(win.change).toBe(100);
  });

  it('rejects buy-in below minimum and insufficient balance', () => {
    const nk = createMockNk(50);
    expect(() => updateUserChips(nk, logger, 'user-1', 50, 'buy_in')).toThrow(
      /Minimum buy-in/
    );
    expect(() => updateUserChips(nk, logger, 'user-1', 200, 'buy_in')).toThrow(
      /Insufficient chips/
    );
  });

  it('rejects invalid reason', () => {
    const nk = createMockNk(10000);
    expect(() =>
      updateUserChips(nk, logger, 'user-1', 10, 'hack' as never)
    ).toThrow(/Invalid reason/);
  });
});

describe('update_chips RPC removal', () => {
  it('main.ts no longer registers update_chips', () => {
    const mainSource = readFileSync(join(__dirname, '../main.ts'), 'utf8');
    expect(mainSource).not.toContain("registerRpc('update_chips'");
    expect(mainSource).not.toContain('updateChipsRpc');
    expect(mainSource).toContain("registerRpc('get_chips'");
    expect(mainSource).toContain("registerRpc('claim_daily_reward'");
  });

  it('user_chips.ts exports updateUserChips instead of updateChipsRpc', () => {
    const source = readFileSync(join(__dirname, './user_chips.ts'), 'utf8');
    expect(source).toContain('export function updateUserChips');
    expect(source).not.toContain('export const updateChipsRpc');
  });
});
