import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config/index.js';

type LocalValue = { value: string; expiresAt: number | null };

export class SupabaseStateStore {
  private client: SupabaseClient | null = null;
  private healthy = false;
  private readonly values = new Map<string, LocalValue>();
  private readonly sets = new Map<string, Set<string>>();
  private readonly locks = new Map<string, { token: string; expiresAt: number }>();
  private readonly rateEvents = new Map<string, number[]>();

  constructor() {
    if (config.NODE_ENV !== 'test' && config.SUPABASE_URL && config.SUPABASE_SERVICE_ROLE_KEY && !config.SUPABASE_URL.includes('mock-supabase')) {
      try {
        this.client = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
          auth: { persistSession: false },
        });
      } catch {
        this.healthy = false;
      }
    }
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  async waitForConnection(): Promise<boolean> {
    if (!this.client) return false;
    const { error } = await this.client.from('runtime_kv').select('key').limit(1);
    this.healthy = !error;
    return this.healthy;
  }

  private requireClient(operation: string): SupabaseClient | null {
    if (this.client) return this.client;
    if (config.NODE_ENV === 'production') {
      throw new Error(`Supabase is unavailable during ${operation}; refusing in-memory production state.`);
    }
    return null;
  }

  private async call<T>(operation: string, request: PromiseLike<{ data: T; error: { message: string } | null }>): Promise<T> {
    try {
      const { data, error } = await request;
      if (error) throw new Error(error.message);
      this.healthy = true;
      return data;
    } catch (error) {
      this.healthy = false;
      throw new Error(`Supabase ${operation} failed: ${error instanceof Error ? error.message : 'request error'}`);
    }
  }

  async get(key: string): Promise<string | null> {
    const client = this.requireClient('get');
    if (!client) {
      const item = this.values.get(key);
      if (!item || (item.expiresAt !== null && item.expiresAt <= Date.now())) {
        this.values.delete(key);
        return null;
      }
      return item.value;
    }
    const data = await this.call('state read', client.from('runtime_kv').select('value,expires_at').eq('key', key).maybeSingle());
    if (!data) return null;
    const row = data as { value: string; expires_at: string | null };
    if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) {
      await this.del(key);
      return null;
    }
    return row.value;
  }

  /**
   * Fetch multiple runtime values in one database round trip.
   * Expired values are returned as null; periodic runtime-state pruning removes
   * their physical rows without serializing every queue scan behind N reads.
   */
  async getMany(keys: string[]): Promise<Map<string, string | null>> {
    const uniqueKeys = Array.from(new Set(keys.filter((key) => typeof key === 'string' && key.length > 0)));
    const result = new Map<string, string | null>(uniqueKeys.map((key) => [key, null] as const));
    if (uniqueKeys.length === 0) return result;

    const client = this.requireClient('batch get');
    if (!client) {
      const now = Date.now();
      for (const key of uniqueKeys) {
        const item = this.values.get(key);
        if (item && (item.expiresAt === null || item.expiresAt > now)) result.set(key, item.value);
        else if (item) this.values.delete(key);
      }
      return result;
    }

    const rows = await this.call('batch state read', client.from('runtime_kv')
      .select('key,value,expires_at')
      .in('key', uniqueKeys));
    const now = Date.now();
    for (const row of (rows || []) as Array<{ key: string; value: string; expires_at: string | null }>) {
      if (!row.expires_at || Date.parse(row.expires_at) > now) result.set(row.key, row.value);
    }
    return result;
  }

  async getBuffer(key: string): Promise<Buffer | null> {
    const value = await this.get(key);
    return value === null ? null : Buffer.from(value, 'base64');
  }

  async setBuffer(key: string, buffer: Buffer, ttlSeconds?: number): Promise<boolean> {
    return this.set(key, buffer.toString('base64'), ttlSeconds);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<boolean> {
    if (ttlSeconds !== undefined && (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1)) {
      throw new Error('TTL must be a positive integer.');
    }
    const client = this.requireClient('set');
    if (!client) {
      this.values.set(key, { value, expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null });
      return true;
    }
    const expiresAt = ttlSeconds ? new Date(Date.now() + ttlSeconds * 1000).toISOString() : null;
    await this.call('state write', client.from('runtime_kv').upsert({
      key,
      value,
      expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'key' }));
    return true;
  }

  async del(key: string): Promise<boolean> {
    const client = this.requireClient('delete');
    if (!client) return this.values.delete(key);
    const rows = await this.call('state delete', client.from('runtime_kv').delete().eq('key', key).select('key'));
    return Array.isArray(rows) && rows.length > 0;
  }

  async delIfValue(key: string, expectedValue: string): Promise<boolean> {
    const client = this.requireClient('conditional delete');
    if (!client) {
      const item = this.values.get(key);
      if (!item || item.value !== expectedValue) return false;
      this.values.delete(key);
      return true;
    }
    return Boolean(await this.call('conditional state delete', client.rpc('delete_runtime_value_if_equal', {
      p_key: key,
      p_value: expectedValue,
    })));
  }

  async setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1) throw new Error('setIfAbsent requires a positive integer TTL.');
    const client = this.requireClient('conditional set');
    if (!client) {
      const item = this.values.get(key);
      if (item && (item.expiresAt === null || item.expiresAt > Date.now())) return false;
      this.values.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
      return true;
    }
    return Boolean(await this.call('conditional state write', client.rpc('set_runtime_value_if_absent', {
      p_key: key,
      p_value: value,
      p_ttl_seconds: ttlSeconds,
    })));
  }

  async sAdd(key: string, member: string): Promise<number> {
    const client = this.requireClient('set add');
    if (!client) {
      const set = this.sets.get(key) || new Set<string>();
      const before = set.size;
      set.add(member);
      this.sets.set(key, set);
      return set.size > before ? 1 : 0;
    }
    const result = await this.call('set add', client.from('runtime_kv_sets').upsert({ key, member }, {
      onConflict: 'key,member',
      ignoreDuplicates: true,
    }).select('member'));
    return Array.isArray(result) && result.length > 0 ? 1 : 0;
  }

  async sRem(key: string, member: string): Promise<number> {
    const client = this.requireClient('set removal');
    if (!client) {
      const set = this.sets.get(key);
      if (!set?.delete(member)) return 0;
      if (set.size === 0) this.sets.delete(key);
      return 1;
    }
    const rows = await this.call('set removal', client.from('runtime_kv_sets').delete().eq('key', key).eq('member', member).select('member'));
    return Array.isArray(rows) ? rows.length : 0;
  }

  async sMembers(key: string): Promise<string[]> {
    const client = this.requireClient('set lookup');
    if (!client) return [...(this.sets.get(key) || [])];
    const rows = await this.call('set lookup', client.from('runtime_kv_sets').select('member').eq('key', key));
    return Array.isArray(rows) ? rows.map((row: { member: string }) => row.member) : [];
  }

  async checkRateLimit(key: string, limit: number, windowSeconds: number): Promise<{ allowed: boolean; remaining: number }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(windowSeconds) || windowSeconds < 1) {
      return { allowed: false, remaining: 0 };
    }
    const client = this.requireClient('rate limiting');
    if (!client) {
      const cutoff = Date.now() - windowSeconds * 1000;
      const active = (this.rateEvents.get(key) || []).filter((time) => time > cutoff);
      if (active.length >= limit) {
        this.rateEvents.set(key, active);
        return { allowed: false, remaining: 0 };
      }
      active.push(Date.now());
      this.rateEvents.set(key, active);
      return { allowed: true, remaining: limit - active.length };
    }
    const result = await this.call('rate limit', client.rpc('take_runtime_rate_limit', {
      p_key: key,
      p_limit: limit,
      p_window_seconds: windowSeconds,
    }));
    const row = Array.isArray(result) ? result[0] : result;
    const parsed = row as { allowed?: boolean; remaining?: number } | null;
    return { allowed: parsed?.allowed === true, remaining: Number(parsed?.remaining || 0) };
  }

  async tryAcquireLock(key: string, token: string, ttlMs: number): Promise<boolean> {
    const client = this.requireClient('lock acquire');
    if (!client) {
      const lock = this.locks.get(key);
      if (lock && lock.expiresAt > Date.now()) return false;
      this.locks.set(key, { token, expiresAt: Date.now() + ttlMs });
      return true;
    }
    return Boolean(await this.call('lock acquire', client.rpc('try_acquire_runtime_lock', {
      p_key: key,
      p_token: token,
      p_ttl_ms: ttlMs,
    })));
  }

  async renewLock(key: string, token: string, ttlMs: number): Promise<boolean> {
    const client = this.requireClient('lock renewal');
    if (!client) {
      const lock = this.locks.get(key);
      if (!lock || lock.token !== token || lock.expiresAt <= Date.now()) return false;
      lock.expiresAt = Date.now() + ttlMs;
      return true;
    }
    return Boolean(await this.call('lock renewal', client.rpc('renew_runtime_lock', {
      p_key: key,
      p_token: token,
      p_ttl_ms: ttlMs,
    })));
  }

  async releaseLock(key: string, token: string): Promise<boolean> {
    const client = this.requireClient('lock release');
    if (!client) {
      const lock = this.locks.get(key);
      if (!lock || lock.token !== token) return false;
      this.locks.delete(key);
      return true;
    }
    return Boolean(await this.call('lock release', client.rpc('release_runtime_lock', {
      p_key: key,
      p_token: token,
    })));
  }

  async pruneExpired(): Promise<number> {
    const client = this.requireClient('expired state cleanup');
    if (!client) {
      const now = Date.now();
      let count = 0;
      for (const [key, item] of this.values) if (item.expiresAt !== null && item.expiresAt <= now) { this.values.delete(key); count++; }
      for (const [key, lock] of this.locks) if (lock.expiresAt <= now) { this.locks.delete(key); count++; }
      return count;
    }
    const result = await this.call('expired state cleanup', client.rpc('prune_expired_runtime_state', { p_limit: 1000 }));
    return Number(result) || 0;
  }
}

export const stateStore = new SupabaseStateStore();
