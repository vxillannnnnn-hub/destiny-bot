import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config/index.js';
import crypto from 'crypto';
import { 
  UserProfile, 
  RoomSession, 
  ChatMessage, 
  ReportItem, 
  UserBlock, 
  NotificationSettings, 
  AdminAuditLog,
  GuildSettings,
  GenderVerificationStatus
} from '../core/types.js';
import { isBanActive } from '../core/moderation/ban-policy.js';
import { v4 as uuidv4 } from 'uuid';
import { stateStore } from '../storage/state-store.js';
import { lockManager } from '../storage/locks.js';

export class DatabaseService {
  private client: SupabaseClient | null = null;
  private isMockMode: boolean = false;

  // High-performance in-memory ultra-low-latency caches
  private userCache: Map<string, { user: UserProfile; expires: number }> = new Map();
  private blockListCache: Map<string, { ids: Set<string>; expires: number }> = new Map();
  private discordUserCache: Map<string, { user: UserProfile; expires: number }> = new Map();
  private guildSettingsCache: Map<string, { settings: GuildSettings | null; expires: number }> = new Map();
  private mockGuildSettings: Map<string, GuildSettings> = new Map();

  // In-memory fallbacks for testing and offline resilience
  public mockUsers: Map<string, UserProfile> = new Map();
  public mockRooms: Map<string, RoomSession> = new Map();
  public mockMessages: ChatMessage[] = [];
  public mockReports: Map<string, ReportItem> = new Map();
  public mockBlocks: UserBlock[] = [];
  public mockAuditLogs: AdminAuditLog[] = [];
  public mockNotifications: Map<string, NotificationSettings> = new Map();

  constructor() {
    if (
      config.NODE_ENV !== 'test' &&
      config.SUPABASE_URL && 
      config.SUPABASE_SERVICE_ROLE_KEY && 
      !config.SUPABASE_URL.includes('mock-supabase')
    ) {
      try {
        this.client = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
          auth: { persistSession: false },
        });
        this.isMockMode = false;
      } catch (err) {
        console.warn('âš ï¸ Could not connect to remote Supabase, falling back to local memory store.', err);
        this.isMockMode = true;
      }
    } else {
      this.isMockMode = true;
    }

    if (config.NODE_ENV === 'production' && this.isMockMode) {
      throw new Error('Supabase is required in production; refusing to start with the in-memory mock database.');
    }
  }

  private invalidateUserCaches(userId: string): void {
    this.userCache.delete(userId);
    for (const [discordId, cached] of this.discordUserCache.entries()) {
      if (cached.user.id === userId) this.discordUserCache.delete(discordId);
    }
  }

  public isUsingMock(): boolean {
    return this.isMockMode;
  }

  /** Verify that configured Supabase credentials can reach the expected schema. */
  async assertConnection(): Promise<void> {
    if (this.isMockMode || !this.client) {
      if (config.NODE_ENV === 'production') {
        throw new Error('Supabase is unavailable; production cannot use the in-memory mock database.');
      }
      return;
    }
    const { error } = await this.client.from('users').select('id').limit(1);
    if (error) throw new Error(`Supabase connectivity/schema check failed: ${error.message}`);
  }

  private async enrichProfileExtensions(user: UserProfile): Promise<UserProfile> {
    // Profile extensions are first-class users-table columns; runtime state is not an
    // authority for profile fields because it can outlive an intentional clear.
    return user;
  }

  // ---------------- USER OPERATIONS ----------------
  async getUserByDiscordId(discordUserId: string, forceFresh = false): Promise<UserProfile | null> {
    if (!forceFresh) {
      const cached = this.discordUserCache.get(discordUserId);
      if (cached && cached.expires > Date.now()) {
        const user = this.normalizeUserBan(cached.user);
        this.discordUserCache.set(discordUserId, { user, expires: cached.expires });
        this.userCache.set(user.id, { user, expires: cached.expires });
        return await this.enrichProfileExtensions(user);
      }
    }

    if (this.isMockMode || !this.client) {
      for (const user of this.mockUsers.values()) {
        if (user.discordUserId === discordUserId) return await this.enrichProfileExtensions(this.normalizeUserBan(user));
      }
      return null;
    }

    const { data, error } = await this.client
      .from('users')
      .select('*')
      .eq('discord_user_id', discordUserId)
      .maybeSingle();

    if (error) throw new Error(`Failed to load user: ${error.message}`);
    if (!data) return null;
    const user = this.mapUser(data);
    this.discordUserCache.set(discordUserId, { user, expires: Date.now() + 60_000 });
    this.userCache.set(user.id, { user, expires: Date.now() + 60_000 });
    return await this.enrichProfileExtensions(user);
  }

  async getUserById(id: string, forceFresh = false): Promise<UserProfile | null> {
    if (!forceFresh) {
      const cached = this.userCache.get(id);
      if (cached && cached.expires > Date.now()) {
        const user = this.normalizeUserBan(cached.user);
        this.userCache.set(id, { user, expires: cached.expires });
        this.discordUserCache.set(user.discordUserId, { user, expires: cached.expires });
        return await this.enrichProfileExtensions(user);
      }
    }

    if (this.isMockMode || !this.client) {
      const user = this.mockUsers.get(id);
      return user ? await this.enrichProfileExtensions(this.normalizeUserBan(user)) : null;
    }

    const { data, error } = await this.client
      .from('users')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error) throw new Error(`Failed to load Discord user: ${error.message}`);
    if (!data) return null;
    const user = this.mapUser(data);
    this.userCache.set(user.id, { user, expires: Date.now() + 60_000 });
    this.discordUserCache.set(user.discordUserId, { user, expires: Date.now() + 60_000 });
    return await this.enrichProfileExtensions(user);
  }

  /**
   * Load current profiles in bounded batches without consulting the 60-second
   * cache. Matchmaking uses this to invalidate queue snapshots after bans,
   * profile edits, or room transitions made by another process.
   */
  async getUsersByIds(ids: string[], forceFresh = true): Promise<UserProfile[]> {
    const uniqueIds = Array.from(new Set(
      ids.filter((id): id is string => typeof id === 'string' && id.length > 0)
    ));
    if (uniqueIds.length === 0) return [];

    if (this.isMockMode || !this.client) {
      return uniqueIds
        .map((id) => this.mockUsers.get(id))
        .filter((user): user is UserProfile => Boolean(user))
        .map((user) => this.normalizeUserBan(user));
    }

    const users: UserProfile[] = [];
    const batchSize = 100;
    for (let offset = 0; offset < uniqueIds.length; offset += batchSize) {
      const batch = uniqueIds.slice(offset, offset + batchSize);
      const { data, error } = await this.client
        .from('users')
        .select('*')
        .in('id', batch);
      if (error) throw new Error(`Failed to load matchmaking profiles: ${error.message}`);

      for (const row of data || []) {
        const user = this.mapUser(row);
        users.push(user);
        this.userCache.set(user.id, { user, expires: Date.now() + 60_000 });
        this.discordUserCache.set(user.discordUserId, { user, expires: Date.now() + 60_000 });
      }
    }
    return users;
  }

  async getUserByDestinyId(destinyId: string): Promise<UserProfile | null> {
    const raw = (destinyId || '').trim();
    if (!raw) return null;
    const cleanId = raw.replace(/^destiny#/i, '').replace(/[^a-zA-Z0-9]/g, '');
    if (!cleanId) return null;
    const withPrefix = `destiny#${cleanId}`;

    if (this.isMockMode || !this.client) {
      const lowerRaw = raw.toLowerCase();
      const lowerClean = cleanId.toLowerCase();
      const lowerWithPrefix = withPrefix.toLowerCase();
      for (const user of this.mockUsers.values()) {
        const uid = (user.destinyId || '').toLowerCase();
        if (
          uid === lowerRaw ||
          uid === lowerClean ||
          uid === lowerWithPrefix
        ) {
          return await this.enrichProfileExtensions(this.normalizeUserBan(user));
        }
      }
      return null;
    }

    const { data, error } = await this.client
      .from('users')
      .select('*')
      .or(`destiny_id.ilike.${cleanId},destiny_id.ilike.${withPrefix}`)
      .maybeSingle();

    if (error) throw new Error(`Failed to load user by Destiny ID: ${error.message}`);
    if (!data) return null;
    return await this.enrichProfileExtensions(this.mapUser(data));
  }

  /**
   * Generates a 6-digit alphanumeric Destiny ID guaranteed not to overlap with any existing user in Supabase
   */
  async generateUniqueDestinyId(): Promise<string> {
    const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    while (true) {
      const bytes = crypto.randomBytes(6);
      let code = '';
      for (let i = 0; i < 6; i++) {
        code += CHARS[bytes[i] % CHARS.length];
      }
      if (!/[A-Z]/.test(code) || !/[0-9]/.test(code)) continue;

      if (!this.client || this.isMockMode) {
        const inMock = Array.from(this.mockUsers.values()).some((u) => u.destinyId === code);
        if (!inMock) return code;
        continue;
      }

      const { data, error } = await this.client
        .from('users')
        .select('id')
        .eq('destiny_id', code)
        .maybeSingle();
      if (error) throw new Error(`Failed to check Destiny ID uniqueness: ${error.message}`);

      if (!data) {
        return code;
      }
    }
  }

  async createOrUpdateUser(user: Partial<UserProfile> & { discordUserId: string }): Promise<UserProfile> {
    const now = new Date().toISOString();
    const existing = await this.getUserByDiscordId(user.discordUserId, true);

    if (existing) {
      if (this.isMockMode || !this.client) {
        // Re-read the current map value immediately before merging. Two
        // simultaneous partial updates must not overwrite each other's fields.
        const latest = this.normalizeUserBan(this.mockUsers.get(existing.id) || existing);
        const updated: UserProfile = this.normalizeUserBan({
          ...latest,
          ...user,
          id: latest.id,
          createdAt: latest.createdAt,
          updatedAt: now,
        });
        this.mockUsers.set(existing.id, updated);
        return updated;
      }

      // Only persist fields explicitly supplied by this caller. Writing a
      // whole cached profile for a one-field change can clobber a concurrent
      // moderation/profile update from another request or bot process.
      const updatePayload: Record<string, any> = { updated_at: now };
      const writableFields: Array<[keyof UserProfile, string]> = [
        ['destinyId', 'destiny_id'],
        ['age', 'age'],
        ['gender', 'gender'],
        ['genderVerified', 'gender_verified'],
        ['genderVerificationStatus', 'gender_verification_status'],
        ['genderVerificationEvidence', 'gender_verification_evidence'],
        ['interests', 'interests'],
        ['languages', 'languages'],
        ['preferredGender', 'preferred_gender'],
        ['minAgePref', 'min_age_pref'],
        ['maxAgePref', 'max_age_pref'],
        ['activeRoomId', 'active_room_id'],
        ['isBanned', 'is_banned'],
        ['banReason', 'ban_reason'],
        ['banExpiresAt', 'ban_expires_at'],
        ['reputationScore', 'reputation_score'],
        ['bio', 'bio'],
        ['matchIntent', 'match_intent'],
      ];
      for (const [field, column] of writableFields) {
        if (Object.prototype.hasOwnProperty.call(user, field) && user[field] !== undefined) {
          updatePayload[column] = user[field];
        }
      }

      const { data, error } = await this.client
        .from('users')
        .update(updatePayload)
        .eq('id', existing.id)
        .select()
        .single();

      if (error || !data) throw new Error(`Failed to update user: ${error?.message || 'no row returned'}`);
      const mapped = this.mapUser(data);
      this.userCache.set(mapped.id, { user: mapped, expires: Date.now() + 60_000 });
      this.discordUserCache.set(mapped.discordUserId, { user: mapped, expires: Date.now() + 60_000 });
      return await this.enrichProfileExtensions(mapped);
    }

    // New user
    const newUser: UserProfile = {
      id: uuidv4(),
      discordUserId: user.discordUserId,
      destinyId: user.destinyId || (await this.generateUniqueDestinyId()),
      age: user.age || 18,
      gender: user.gender || 'prefer_not_to_say',
      genderVerified: false,
      genderVerificationStatus: 'unverified',
      interests: user.interests || [],
      languages: user.languages || ['en'],
      preferredGender: user.preferredGender || ['any'],
      minAgePref: user.minAgePref || 18,
      maxAgePref: user.maxAgePref || 99,
      activeRoomId: null,
      isBanned: false,
      reputationScore: 100,
      bio: user.bio,
      matchIntent: user.matchIntent,
      createdAt: now,
      updatedAt: now,
    };

    if (this.isMockMode || !this.client) {
      this.mockUsers.set(newUser.id, newUser);
      return newUser;
    }

    const { data, error } = await this.client
      .from('users')
      .insert({
        id: newUser.id,
        discord_user_id: newUser.discordUserId,
        destiny_id: newUser.destinyId,
        age: newUser.age,
        gender: newUser.gender,
        gender_verified: newUser.genderVerified,
        gender_verification_status: newUser.genderVerificationStatus,
        gender_verification_evidence: newUser.genderVerificationEvidence,
        interests: newUser.interests,
        languages: newUser.languages,
        preferred_gender: newUser.preferredGender,
        min_age_pref: newUser.minAgePref,
        max_age_pref: newUser.maxAgePref,
        reputation_score: newUser.reputationScore,
        last_active_at: now,
        bio: newUser.bio,
        match_intent: newUser.matchIntent,
      })
      .select()
      .single();

    if (error || !data) {
      // Two commands can create the same Discord profile at once. Let the
      // unique constraint pick one winner, then apply the loser's requested
      // partial fields to the row that won instead of surfacing a 500.
      if (error?.code === '23505') {
        const concurrentUser = await this.getUserByDiscordId(user.discordUserId, true).catch(() => null);
        if (concurrentUser) return this.createOrUpdateUser(user);
      }
      throw new Error(`Failed to insert user: ${error?.message || 'no row returned'}`);
    }
    const mapped = this.mapUser(data);
    this.userCache.set(mapped.id, { user: mapped, expires: Date.now() + 60_000 });
    this.discordUserCache.set(mapped.discordUserId, { user: mapped, expires: Date.now() + 60_000 });
    return mapped;
  }

  async clearActiveRoom(userId: string, expectedRoomId?: string): Promise<boolean> {
    if (!expectedRoomId) return false;
    if (this.isMockMode || !this.client) {
      const user = this.mockUsers.get(userId);
      if (!user || user.activeRoomId !== expectedRoomId) return false;
      user.activeRoomId = null;
      try {
        await stateStore.delIfValue(`user:active_room:${userId}`, expectedRoomId);
      } catch (cacheError) {
        console.warn('[Database] Cleared mock active room reference but Supabase runtime cleanup failed:', cacheError);
      }
      return true;
    }

    const { data, error } = await this.client
      .from('users')
      .update({ active_room_id: null, updated_at: new Date().toISOString() })
      .eq('id', userId)
      .eq('active_room_id', expectedRoomId)
      .select('id');
    if (error) throw new Error(`Failed to clear stale active room reference: ${error.message}`);
    const cleared = Boolean(data && data.length > 0);
    this.userCache.delete(userId);
    const user = await this.getUserById(userId, true);
    if (user) {
      this.userCache.set(userId, { user, expires: Date.now() + 60_000 });
      this.discordUserCache.set(user.discordUserId, { user, expires: Date.now() + 60_000 });
    }
    try {
      await stateStore.delIfValue(`user:active_room:${userId}`, expectedRoomId);
    } catch (cacheError) {
        console.warn('[Database] Cleared stale room reference but Supabase runtime cleanup failed:', cacheError);
    }
    return cleared;
  }

  async getAllUsers(limit: number = 100, offset: number = 0): Promise<UserProfile[]> {
    if (this.isMockMode || !this.client) {
      return Array.from(this.mockUsers.values()).slice(offset, offset + limit).map((user) => this.normalizeUserBan(user));
    }
    const safeLimit = Number.isFinite(limit) ? Math.min(1000, Math.max(1, Math.trunc(limit))) : 100;
    const safeOffset = Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : 0;
    const { data, error } = await this.client
      .from('users')
      .select('*')
      .order('created_at', { ascending: false })
      .range(safeOffset, safeOffset + safeLimit - 1);
    if (error) throw new Error(`Failed to load users: ${error.message}`);
    return (data || []).map(this.mapUser);
  }
  async getNotificationSettingsForUsers(userIds: string[]): Promise<Map<string, NotificationSettings>> {
    const result = new Map<string, NotificationSettings>();
    if (userIds.length === 0) return result;

    if (this.isMockMode || !this.client) {
      for (const userId of userIds) {
        const settings = this.mockNotifications.get(userId);
        if (settings) result.set(userId, { ...settings });
      }
      return result;
    }

    const { data, error } = await this.client
      .from('notification_settings')
      .select('*')
      .in('user_id', userIds);
    if (error) throw new Error(`Failed to load notification settings: ${error.message}`);

    for (const row of data || []) {
      result.set(row.user_id, {
        userId: row.user_id,
        dailyReminderEnabled: row.daily_reminder_enabled,
        dailyReminderTime: row.daily_reminder_time,
        timeZone: row.time_zone,
        quietHoursStart: row.quiet_hours_start || undefined,
        quietHoursEnd: row.quiet_hours_end || undefined,
        optOut: row.opt_out,
      });
    }
    return result;
  }


  // ---------------- ROOM OPERATIONS ----------------
  async createRoom(room: Omit<RoomSession, 'id' | 'createdAt' | 'updatedAt'>): Promise<RoomSession> {
    if (room.user1Id === room.user2Id) throw new Error('Cannot create a room with the same user twice.');

    const id = uuidv4();
    const now = new Date().toISOString();
    const newRoom: RoomSession = { ...room, id, createdAt: now, updatedAt: now };

    if (this.isMockMode || !this.client) {
      const u1 = this.mockUsers.get(room.user1Id);
      const u2 = this.mockUsers.get(room.user2Id);
      if (!u1 || !u2) throw new Error('Cannot create a room for an unknown user.');
      if (u1.activeRoomId || u2.activeRoomId) throw new Error('A participant already belongs to an active room.');
      this.mockRooms.set(id, newRoom);
      u1.activeRoomId = id;
      u2.activeRoomId = id;
      return newRoom;
    }

    // The RPC locks both user rows in a stable order and inserts the room plus
    // both active_room_id references in one database transaction.
    const { data, error } = await this.client.rpc('create_room_with_users', {
      p_id: id,
      p_room_code: newRoom.roomCode,
      p_user1_id: newRoom.user1Id,
      p_user2_id: newRoom.user2Id,
      p_user1_pseudonym: newRoom.user1Pseudonym,
      p_user2_pseudonym: newRoom.user2Pseudonym,
      p_status: newRoom.status,
      p_started_at: newRoom.startedAt,
      p_reveal_status_user1: newRoom.revealStatusUser1,
      p_reveal_status_user2: newRoom.revealStatusUser2,
    });
    const row = Array.isArray(data) ? data[0] : data;
    if (error || !row) throw new Error(`Failed to create room atomically: ${error?.message || 'no room returned'}`);

    this.userCache.delete(room.user1Id);
    this.userCache.delete(room.user2Id);
    if (room.user1DiscordId) this.discordUserCache.delete(room.user1DiscordId);
    if (room.user2DiscordId) this.discordUserCache.delete(room.user2DiscordId);

    const mapped = this.mapRoom(row);
    mapped.user1DiscordId = room.user1DiscordId || '';
    mapped.user2DiscordId = room.user2DiscordId || '';
    mapped.user1Avatar = room.user1Avatar || 'ðŸŽ­';
    mapped.user2Avatar = room.user2Avatar || 'ðŸŽ­';
    return mapped;
  }

  async getRoomById(id: string): Promise<RoomSession | null> {
    if (this.isMockMode || !this.client) {
      const room = this.mockRooms.get(id);
      return room ? { ...room } : null;
    }
    const { data, error } = await this.client.from('rooms').select('*').eq('id', id).maybeSingle();
    if (error) throw new Error(`Failed to load room: ${error.message}`);
    if (!data) return null;
    const mapped = this.mapRoom(data);
    if (!mapped.user1DiscordId || !mapped.user2DiscordId) {
      const [u1, u2] = await Promise.all([
        this.getUserById(mapped.user1Id),
        this.getUserById(mapped.user2Id),
      ]);
      if (u1) mapped.user1DiscordId = u1.discordUserId;
      if (u2) mapped.user2DiscordId = u2.discordUserId;
    }
    return mapped;
  }

  async getLastRoomForUser(userId: string): Promise<RoomSession | null> {
    if (this.isMockMode || !this.client) {
      const userRooms = Array.from(this.mockRooms.values())
        .filter((r) => r.user1Id === userId || r.user2Id === userId)
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      return userRooms[0] ? { ...userRooms[0] } : null;
    }

    const { data, error } = await this.client
      .from('rooms')
      .select('*')
      .or(`user1_id.eq.${userId},user2_id.eq.${userId}`)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw new Error(`Failed to load room: ${error.message}`);
    if (!data) return null;
    const mapped = this.mapRoom(data);
    if (!mapped.user1DiscordId || !mapped.user2DiscordId) {
      const [u1, u2] = await Promise.all([
        this.getUserById(mapped.user1Id),
        this.getUserById(mapped.user2Id),
      ]);
      if (u1) mapped.user1DiscordId = u1.discordUserId;
      if (u2) mapped.user2DiscordId = u2.discordUserId;
    }
    return mapped;
  }

  async getUserRooms(userId: string): Promise<RoomSession[]> {
    if (this.isMockMode || !this.client) {
      return Array.from(this.mockRooms.values()).filter(
        (r) => r.user1Id === userId || r.user2Id === userId
      );
    }
    const { data, error } = await this.client
      .from('rooms')
      .select('*')
      .or(`user1_id.eq.${userId},user2_id.eq.${userId}`);
    if (error) throw new Error(`Failed to load user rooms: ${error.message}`);
    return (data || []).map((d: any) => this.mapRoom(d));
  }

  /**
   * Update reveal-consent fields without writing stale room XP/status over
   * concurrent message progression or room lifecycle changes.
   */
  async updateRoomRevealStatus(
    roomId: string,
    user1Status: RoomSession['revealStatusUser1'],
    user2Status: RoomSession['revealStatusUser2']
  ): Promise<boolean> {
    const now = new Date().toISOString();
    if (this.isMockMode || !this.client) {
      const room = this.mockRooms.get(roomId);
      if (!room || room.status !== 'active') return false;
      room.revealStatusUser1 = user1Status;
      room.revealStatusUser2 = user2Status;
      room.updatedAt = now;
      return true;
    }

    const { data, error } = await this.client
      .from('rooms')
      .update({
        reveal_status_user1: user1Status,
        reveal_status_user2: user2Status,
        updated_at: now,
      })
      .eq('id', roomId)
      .eq('status', 'active')
      .select('id')
      .maybeSingle();

    if (error) throw new Error(`Failed to update room reveal consent: ${error.message}`);
    return Boolean(data);
  }

  async updateRoom(room: RoomSession): Promise<RoomSession> {
    room.updatedAt = new Date().toISOString();
    if (this.isMockMode || !this.client) {
      this.mockRooms.set(room.id, { ...room });
      return room;
    }
    const { data, error } = await this.client
      .from('rooms')
      .update({
        status: room.status,
        reveal_status_user1: room.revealStatusUser1,
        reveal_status_user2: room.revealStatusUser2,
        pinned_message_id: room.pinnedMessageId,
        ended_at: room.endedAt,
        end_reason: room.endReason,
        updated_at: room.updatedAt,
      })
      .eq('id', room.id)
      .select('id')
      .maybeSingle();

    if (error) throw new Error(`Failed to update room: ${error.message}`);
    if (!data) throw new Error('Failed to update room: room no longer exists.');
    return room;
  }

  async getActiveRooms(): Promise<RoomSession[]> {
    if (this.isMockMode || !this.client) {
      return Array.from(this.mockRooms.values()).filter((r) => r.status === 'active');
    }
    const { data, error } = await this.client.from('rooms').select('*').eq('status', 'active');
    if (error) throw new Error(`Failed to load active rooms: ${error.message}`);
    return (data || []).map(this.mapRoom);
  }

  async getActiveRoomCount(): Promise<number> {
    if (this.isMockMode || !this.client) {
      return Array.from(this.mockRooms.values()).filter((room) => room.status === 'active').length;
    }
    const { count, error } = await this.client
      .from('rooms')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'active');
    if (error) throw new Error(`Failed to count active rooms: ${error.message}`);
    return count || 0;
  }

  /**
   * End a room only if its latest committed activity is older than the cutoff.
   * The PostgreSQL RPC locks and rechecks the room row, preventing a cleanup
   * snapshot from closing a room after a new message/touch has landed.
   */
  async endRoomIfInactive(roomId: string, cutoff: Date): Promise<boolean> {
    if (!(cutoff instanceof Date) || !Number.isFinite(cutoff.getTime())) {
      throw new Error('A valid inactivity cutoff date is required.');
    }

    // The same room lock is held while a relay delivers and persists a message.
    // That prevents cleanup from ending a room mid-delivery before its activity
    // timestamp can be advanced.
    return await lockManager.withLock(`lock:room:${roomId}`, async () => {
      if (this.isMockMode || !this.client) {
        const room = this.mockRooms.get(roomId);
        if (!room || room.status !== 'active') return false;
        const lastActivity = Date.parse(room.updatedAt || room.startedAt);
        if (!Number.isFinite(lastActivity) || lastActivity > cutoff.getTime()) return false;
        return this.endRoomUnlocked(roomId, 'inactivity');
      }

      const room = await this.getRoomById(roomId);
      const { data, error } = await this.client.rpc('end_room_if_inactive', {
        p_room_id: roomId,
        p_cutoff: cutoff.toISOString(),
      });
      if (error) throw new Error(`Failed to conditionally end inactive room: ${error.message}`);
      const ended = data === true;
      if (!ended) return false;

      if (room) {
        this.userCache.delete(room.user1Id);
        this.userCache.delete(room.user2Id);
        if (room.user1DiscordId) this.discordUserCache.delete(room.user1DiscordId);
        if (room.user2DiscordId) this.discordUserCache.delete(room.user2DiscordId);
        try {
          await Promise.all([
            stateStore.delIfValue(`user:active_room:${room.user1Id}`, roomId),
            stateStore.delIfValue(`user:active_room:${room.user2Id}`, roomId),
            stateStore.del(`room:${roomId}`),
            stateStore.set(`user:last_room:${room.user1Id}`, roomId, 3600),
            stateStore.set(`user:last_room:${room.user2Id}`, roomId, 3600),
          ]);
        } catch (cacheError) {
          console.warn('[Database] Inactive room ended but runtime state cleanup failed:', cacheError);
        }
      }
      return true;
    });
  }

  async endRoom(roomId: string, reason: RoomSession['endReason'] = 'user_left'): Promise<boolean> {
    return await lockManager.withLock(`lock:room:${roomId}`, async () =>
      this.endRoomUnlocked(roomId, reason)
    );
  }

  private async endRoomUnlocked(roomId: string, reason: RoomSession['endReason'] = 'user_left'): Promise<boolean> {
    const now = new Date().toISOString();
    if (this.isMockMode || !this.client) {
      const room = this.mockRooms.get(roomId);
      if (!room || room.status === 'ended') return false;
      room.status = 'ended';
      room.endedAt = now;
      room.endReason = reason;
      room.updatedAt = now;

      const u1 = this.mockUsers.get(room.user1Id);
      if (u1 && u1.activeRoomId === roomId) u1.activeRoomId = null;
      const u2 = this.mockUsers.get(room.user2Id);
      if (u2 && u2.activeRoomId === roomId) u2.activeRoomId = null;

      try {
        await Promise.all([
          stateStore.delIfValue(`user:active_room:${room.user1Id}`, roomId),
          stateStore.delIfValue(`user:active_room:${room.user2Id}`, roomId),
          stateStore.del(`room:${roomId}`),
          stateStore.set(`user:last_room:${room.user1Id}`, roomId, 3600),
          stateStore.set(`user:last_room:${room.user2Id}`, roomId, 3600),
        ]);
      } catch (cacheError) {
        console.warn('[Database] Mock room ended but runtime state cleanup failed:', cacheError);
      }
      return true;
    }

    const room = await this.getRoomById(roomId);
    const { data, error } = await this.client.rpc('end_room', {
      p_room_id: roomId,
      p_end_reason: reason,
    });
    let ended = !error && Boolean(data);

    if (error) {
      const { data: updatedRows, error: updateError } = await this.client
        .from('rooms')
        .update({ status: 'ended', ended_at: now, end_reason: reason, updated_at: now })
        .eq('id', roomId)
        .eq('status', 'active')
        .select('id');
      if (updateError) throw new Error(`Failed to end room: ${updateError.message}`);
      ended = Boolean(updatedRows && updatedRows.length > 0);
      if (ended && room) {
        const { error: userError } = await this.client
          .from('users')
          .update({ active_room_id: null })
          .eq('active_room_id', roomId);
        if (userError) throw new Error(`Failed to clear active room references: ${userError.message}`);
      }
    }

    if (!ended) return false;

    if (room) {
      this.userCache.delete(room.user1Id);
      this.userCache.delete(room.user2Id);
      if (room.user1DiscordId) this.discordUserCache.delete(room.user1DiscordId);
      if (room.user2DiscordId) this.discordUserCache.delete(room.user2DiscordId);
      try {
        await Promise.all([
          stateStore.delIfValue(`user:active_room:${room.user1Id}`, roomId),
          stateStore.delIfValue(`user:active_room:${room.user2Id}`, roomId),
          stateStore.del(`room:${roomId}`),
          stateStore.set(`user:last_room:${room.user1Id}`, roomId, 3600),
          stateStore.set(`user:last_room:${room.user2Id}`, roomId, 3600),
        ]);
      } catch (cacheError) {
        console.warn('[Database] Room ended but runtime state cleanup failed:', cacheError);
      }
    }
    return true;
  }

  /**
   * Record conversation activity independently from XP progression. A failed
   * reward/XP RPC must not make an actively used room look abandoned to cleanup.
   */
  async touchRoomActivity(roomId: string): Promise<boolean> {
    const now = new Date().toISOString();
    if (this.isMockMode || !this.client) {
      const room = this.mockRooms.get(roomId);
      if (!room || room.status !== 'active') return false;
      room.updatedAt = now;
      return true;
    }

    const { data, error } = await this.client
      .from('rooms')
      .update({ updated_at: now })
      .eq('id', roomId)
      .eq('status', 'active')
      .select('id')
      .maybeSingle();

    if (error) throw new Error(`Failed to update room activity: ${error.message}`);
    return Boolean(data);
  }

  // ---------------- MESSAGES & AUDIT ----------------
  async saveMessage(msg: Omit<ChatMessage, 'id' | 'createdAt'>): Promise<ChatMessage> {
    const id = uuidv4();
    const now = new Date().toISOString();
    const chatMsg: ChatMessage = {
      ...msg,
      id,
      createdAt: now,
    };

    if (this.isMockMode || !this.client) {
      this.mockMessages.push(chatMsg);
      return chatMsg;
    }

    const { data, error } = await this.client
      .from('messages')
      .insert({
        id: chatMsg.id,
        room_id: chatMsg.roomId,
        sender_user_id: chatMsg.senderUserId,
        sender_pseudonym: chatMsg.senderPseudonym,
        sanitized_content: chatMsg.sanitizedContent,
        attachments_meta: chatMsg.attachmentsMeta,
        is_pinned: chatMsg.isPinned,
        flagged_for_moderation: chatMsg.flaggedForModeration,
        moderation_reason: chatMsg.moderationReason,
      })
      .select()
      .single();

    if (error || !data) throw new Error(`Failed to persist chat message: ${error?.message || 'no row returned'}`);
    const { error: activityError } = await this.client
      .from('users')
      .update({ last_active_at: now })
      .eq('id', chatMsg.senderUserId);
    if (activityError) console.warn('[Database] Could not update last-active timestamp:', activityError.message);
    return chatMsg;
  }

  async getRoomMessages(roomId: string, limit: number = 50): Promise<ChatMessage[]> {
    const safeLimit = Number.isFinite(limit) ? Math.min(200, Math.max(1, Math.trunc(limit))) : 50;
    if (this.isMockMode || !this.client) {
      return this.mockMessages
        .filter((m) => m.roomId === roomId)
        .slice(-safeLimit);
    }
    const { data, error } = await this.client
      .from('messages')
      .select('*')
      .eq('room_id', roomId)
      .order('created_at', { ascending: false })
      .limit(safeLimit);
    if (error) throw new Error(`Failed to load room messages: ${error.message}`);

    return (data || []).map((m: any) => ({
      id: m.id,
      roomId: m.room_id,
      senderUserId: m.sender_user_id,
      senderPseudonym: m.sender_pseudonym,
      sanitizedContent: m.sanitized_content,
      attachmentsMeta: m.attachments_meta || [],
      isPinned: m.is_pinned,
      flaggedForModeration: m.flagged_for_moderation,
      moderationReason: m.moderation_reason,
      createdAt: m.created_at,
    })).reverse();
  }

  // ---------------- BLOCKS & SAFETY ----------------
  /**
   * Load bidirectional block relationships for an entire matchmaking snapshot.
   * This replaces one HTTP request per user with one request per bounded ID batch.
   */
  async getBlockedUserIdsForUsers(userIds: string[]): Promise<Map<string, ReadonlySet<string>>> {
    const uniqueIds = Array.from(new Set(userIds.filter((id): id is string => typeof id === 'string' && id.length > 0)));
    const result = new Map<string, ReadonlySet<string>>();
    const missingIds: string[] = [];
    const now = Date.now();

    for (const userId of uniqueIds) {
      const cached = this.blockListCache.get(userId);
      if (cached && cached.expires > now) result.set(userId, new Set(cached.ids));
      else missingIds.push(userId);
    }
    if (missingIds.length === 0) return result;

    const requested = new Set(missingIds);
    const mutable = new Map<string, Set<string>>(missingIds.map((id) => [id, new Set<string>()] as const));

    if (this.isMockMode || !this.client) {
      for (const block of this.mockBlocks) {
        if (requested.has(block.blockerId)) mutable.get(block.blockerId)!.add(block.blockedId);
        if (requested.has(block.blockedId)) mutable.get(block.blockedId)!.add(block.blockerId);
      }
    } else {
      // Keep PostgREST URLs bounded while avoiding the old N-per-user query pattern.
      const batchSize = 100;
      const batches: string[][] = [];
      for (let offset = 0; offset < missingIds.length; offset += batchSize) {
        batches.push(missingIds.slice(offset, offset + batchSize));
      }
      // Bound concurrency to keep large queues quick without flooding PostgREST.
      const concurrency = 10;
      for (let offset = 0; offset < batches.length; offset += concurrency) {
        await Promise.all(batches.slice(offset, offset + concurrency).map(async (batch) => {
          const filter = batch.join(',');
          const { data, error } = await this.client!
            .from('user_blocks')
            .select('blocker_id, blocked_id')
            .or(`blocker_id.in.(${filter}),blocked_id.in.(${filter})`);
          if (error) throw new Error(`Failed to load matchmaking block lists: ${error.message}`);

          for (const row of data || []) {
            const blockerId = String(row.blocker_id);
            const blockedId = String(row.blocked_id);
            if (mutable.has(blockerId)) mutable.get(blockerId)!.add(blockedId);
            if (mutable.has(blockedId)) mutable.get(blockedId)!.add(blockerId);
          }
        }));
      }
    }

    if (this.blockListCache.size > 5000) {
      for (const [key, entry] of this.blockListCache) {
        if (entry.expires <= now) this.blockListCache.delete(key);
      }
    }
    const expires = now + 5_000;
    for (const [userId, ids] of mutable) {
      this.blockListCache.set(userId, { ids, expires });
      result.set(userId, new Set(ids));
    }
    return result;
  }

  async getBlockedUserIds(userId: string): Promise<Set<string>> {
    const result = await this.getBlockedUserIdsForUsers([userId]);
    return new Set(result.get(userId) || []);
  }

  async isBlocked(userAId: string, userBId: string): Promise<boolean> {
    if (!userAId || !userBId || userAId === userBId) return userAId === userBId;
    const blockedIds = await this.getBlockedUserIds(userAId);
    return blockedIds.has(userBId);
  }

  async addBlock(blockerId: string, blockedId: string, reason?: string): Promise<boolean> {
    if (this.isMockMode || !this.client) {
      if (!this.mockBlocks.some((b) => b.blockerId === blockerId && b.blockedId === blockedId)) {
        this.mockBlocks.push({
          id: uuidv4(),
          blockerId,
          blockedId,
          reason,
          createdAt: new Date().toISOString(),
        });
      }
      this.blockListCache.delete(blockerId);
      this.blockListCache.delete(blockedId);
      return true;
    }
    const { error } = await this.client.from('user_blocks').insert({
      blocker_id: blockerId,
      blocked_id: blockedId,
      reason,
    });
    if (error?.code === '23505') {
      this.blockListCache.delete(blockerId);
      this.blockListCache.delete(blockedId);
      return true;
    }
    if (!error) {
      this.blockListCache.delete(blockerId);
      this.blockListCache.delete(blockedId);
    }
    return !error;
  }

  // ---------------- REPORTS ----------------
  async createReport(report: Omit<ReportItem, 'id' | 'status' | 'actionTaken' | 'createdAt' | 'updatedAt'>): Promise<ReportItem> {
    const id = uuidv4();
    const now = new Date().toISOString();
    const newReport: ReportItem = {
      ...report,
      id,
      status: 'pending',
      actionTaken: 'none',
      createdAt: now,
      updatedAt: now,
    };

    if (this.isMockMode || !this.client) {
      this.mockReports.set(id, newReport);
      return newReport;
    }

    const { data, error } = await this.client.from('reports').insert({
      id: newReport.id,
      reporter_id: newReport.reporterId,
      reported_id: newReport.reportedId,
      room_id: newReport.roomId,
      category: newReport.category,
      description: newReport.description,
      chat_excerpt: newReport.chatExcerpt,
      status: newReport.status,
    }).select().single();

    if (error || !data) throw new Error(`Failed to create report: ${error?.message || 'no row returned'}`);
    return newReport;
  }

  async getReportById(id: string): Promise<ReportItem | null> {
    if (this.isMockMode || !this.client) {
      return this.mockReports.get(id) || null;
    }
    const { data, error } = await this.client.from('reports').select('*').eq('id', id).maybeSingle();
    if (error) throw new Error(`Failed to load report: ${error.message}`);
    if (!data) return null;
    return {
      id: data.id,
      reporterId: data.reporter_id,
      reportedId: data.reported_id,
      roomId: data.room_id,
      category: data.category,
      description: data.description,
      chatExcerpt: data.chat_excerpt,
      status: data.status,
      actionTaken: data.action_taken,
      moderatorNotes: data.moderator_notes,
      resolvedBy: data.resolved_by,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    };
  }

  async resolveReport(id: string, action: string, notes?: string, adminId?: string): Promise<boolean> {
    if (!['none', 'warned', 'temp_ban', 'perma_ban'].includes(action)) return false;

    if (this.isMockMode || !this.client) {
      const report = this.mockReports.get(id);
      if (!report || report.status !== 'pending') return false;

      if (action === 'perma_ban' || action === 'temp_ban') {
        const reportedUser = this.mockUsers.get(report.reportedId);
        if (!reportedUser) return false;
        const alreadyPermanent = reportedUser.isBanned && !reportedUser.banExpiresAt;
        if (action === 'perma_ban') {
          reportedUser.isBanned = true;
          reportedUser.banReason = `Banned via safety report: ${report.category}`;
          reportedUser.banExpiresAt = null;
        } else if (!alreadyPermanent) {
          const existingExpiry = reportedUser.isBanned && reportedUser.banExpiresAt
            ? Date.parse(reportedUser.banExpiresAt)
            : NaN;
          const nextExpiry = Number.isFinite(existingExpiry) && existingExpiry > Date.now()
            ? existingExpiry + 24 * 60 * 60 * 1000
            : Date.now() + 24 * 60 * 60 * 1000;
          reportedUser.isBanned = true;
          reportedUser.banReason = `Temporarily banned via safety report: ${report.category}`;
          reportedUser.banExpiresAt = new Date(nextExpiry).toISOString();
        }
        reportedUser.updatedAt = new Date().toISOString();
      }

      report.status = 'resolved';
      report.actionTaken = action as any;
      report.moderatorNotes = notes;
      report.resolvedBy = adminId;
      report.updatedAt = new Date().toISOString();
      return true;
    }

    // The report row lock, permanent ban and resolution update are one
    // transaction. Two moderators cannot race a different resolution action.
    const { data, error } = await this.client.rpc('resolve_report_atomic', {
      p_report_id: id,
      p_action: action,
      p_notes: notes ?? null,
      p_admin_id: adminId || 'discord_moderator',
    });
    if (error) throw new Error(`Failed to resolve report: ${error.message}`);
    return Boolean(data);
  }

  // ---------------- AUDIT LOGS ----------------
  async logAdminAction(adminId: string, action: string, targetType: string, targetId: string, changes: Record<string, any> = {}, ipAddress?: string): Promise<void> {
    const log: AdminAuditLog = {
      id: uuidv4(),
      adminId,
      action,
      targetType,
      targetId,
      changes,
      ipAddress,
      createdAt: new Date().toISOString(),
    };

    if (this.isMockMode || !this.client) {
      this.mockAuditLogs.push(log);
      return;
    }

    const { error } = await this.client.from('admin_audit_logs').insert({
      id: log.id,
      admin_id: log.adminId,
      action: log.action,
      target_type: log.targetType,
      target_id: log.targetId,
      changes: log.changes,
      ip_address: log.ipAddress,
    });
    if (error) throw new Error(`Failed to persist admin audit log: ${error.message}`);
  }


  async getUserCount(): Promise<number> {
    if (this.isMockMode || !this.client) {
      return this.mockUsers.size;
    }
    const { count, error } = await this.client
      .from('users')
      .select('*', { count: 'exact', head: true });
    if (error) throw new Error(`Failed to count users: ${error.message}`);
    return count || 0;
  }

  // ---------------- INTERNAL MAPPERS ----------------
  // ---------------- GUILD SETTINGS ----------------
  async getGuildSettings(guildId: string, forceFresh = false): Promise<GuildSettings | null> {
    if (!forceFresh) {
      const cached = this.guildSettingsCache.get(guildId);
      if (cached && cached.expires > Date.now()) {
        return cached.settings;
      }
    }

    if (this.isMockMode) {
      const settings = this.mockGuildSettings.get(guildId) || null;
      this.guildSettingsCache.set(guildId, { settings, expires: Date.now() + 5_000 });
      return settings;
    }
    if (!this.client) throw new Error('Supabase is unavailable; guild settings cannot be loaded.');
    const { data, error } = await this.client
      .from('guild_settings')
      .select('*')
      .eq('guild_id', guildId)
      .maybeSingle();
    if (error) throw new Error(`Failed to load guild settings: ${error.message}`);

    if (!data) {
      this.guildSettingsCache.set(guildId, { settings: null, expires: Date.now() + 120_000 });
      return null;
    }

    const settings: GuildSettings = {
      guildId: data.guild_id,
      guildName: data.guild_name,
      commandPrefix: data.command_prefix,
      matchChannelId: data.match_channel_id,
      announcementsChannelId: data.announcements_channel_id,
      modLogChannelId: data.mod_log_channel_id,
      crossServerEnabled: data.cross_server_enabled,
      minAgeLimit: data.min_age_limit,
      allowedRoles: data.allowed_roles,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    };

    this.guildSettingsCache.set(guildId, { settings, expires: Date.now() + 5_000 });
    return settings;
  }

  async setGuildCrossServerEnabled(guildId: string, enabled: boolean, guildName?: string): Promise<boolean> {
    if (!/^[0-9]{17,20}$/.test(guildId)) return false;
    if (this.isMockMode) {
      const settings = this.mockGuildSettings.get(guildId) || { guildId, crossServerEnabled: true };
      settings.crossServerEnabled = enabled;
      if (guildName) settings.guildName = guildName;
      settings.updatedAt = new Date().toISOString();
      this.mockGuildSettings.set(guildId, settings);
      this.guildSettingsCache.set(guildId, { settings, expires: Date.now() + 5_000 });
      return true;
    }
    if (!this.client) return false;
    const { error } = await this.client.from('guild_settings').upsert({
      guild_id: guildId,
      ...(guildName ? { guild_name: guildName } : {}),
      cross_server_enabled: enabled,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'guild_id' });
    if (error) {
      this.guildSettingsCache.delete(guildId);
      console.error('[Database] Failed to persist guild matchmaking scope:', error.message);
      return false;
    }
    const cached = this.guildSettingsCache.get(guildId)?.settings;
    if (cached) {
      cached.crossServerEnabled = enabled;
      if (guildName) cached.guildName = guildName;
      this.guildSettingsCache.set(guildId, { settings: cached, expires: Date.now() + 5_000 });
    } else {
      this.guildSettingsCache.delete(guildId);
    }
    return true;
  }

  async setGuildMatchChannel(guildId: string, channelId: string | null, guildName?: string): Promise<boolean> {
    if (!/^[0-9]{17,20}$/.test(guildId) || (channelId !== null && !/^[0-9]{17,20}$/.test(channelId))) return false;
    if (this.isMockMode) {
      const settings = this.mockGuildSettings.get(guildId) || { guildId, crossServerEnabled: true };
      settings.matchChannelId = channelId;
      if (guildName) settings.guildName = guildName;
      settings.updatedAt = new Date().toISOString();
      this.mockGuildSettings.set(guildId, settings);
      this.guildSettingsCache.set(guildId, { settings, expires: Date.now() + 5_000 });
      return true;
    }
    if (!this.client) return false;
    const { error } = await this.client.from('guild_settings').upsert({
      guild_id: guildId,
      ...(guildName ? { guild_name: guildName } : {}),
      match_channel_id: channelId,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'guild_id' });
    if (error) {
      this.guildSettingsCache.delete(guildId);
      console.error('[Database] Failed to persist guild portal channel:', error.message);
      return false;
    }
    const cached = this.guildSettingsCache.get(guildId)?.settings;
    if (cached) {
      cached.matchChannelId = channelId;
      if (guildName) cached.guildName = guildName;
      this.guildSettingsCache.set(guildId, { settings: cached, expires: Date.now() + 5_000 });
    } else {
      this.guildSettingsCache.delete(guildId);
    }
    return true;
  }

  async setGuildModLogChannel(guildId: string, channelId: string | null, guildName?: string): Promise<boolean> {
    if (!/^[0-9]{17,20}$/.test(guildId) || (channelId !== null && !/^[0-9]{17,20}$/.test(channelId))) return false;
    if (this.isMockMode) {
      const settings = this.mockGuildSettings.get(guildId) || { guildId, crossServerEnabled: true };
      settings.modLogChannelId = channelId;
      if (guildName) settings.guildName = guildName;
      settings.updatedAt = new Date().toISOString();
      this.mockGuildSettings.set(guildId, settings);
      this.guildSettingsCache.set(guildId, { settings, expires: Date.now() + 5_000 });
      return true;
    }
    if (!this.client) return false;
    const { error } = await this.client.from('guild_settings').upsert({
      guild_id: guildId,
      ...(guildName ? { guild_name: guildName } : {}),
      mod_log_channel_id: channelId,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'guild_id' });
    if (error) {
      this.guildSettingsCache.delete(guildId);
      console.error('[Database] Failed to persist guild moderation channel:', error.message);
      return false;
    }
    const cached = this.guildSettingsCache.get(guildId)?.settings;
    if (cached) {
      cached.modLogChannelId = channelId;
      if (guildName) cached.guildName = guildName;
      this.guildSettingsCache.set(guildId, { settings: cached, expires: Date.now() + 5_000 });
    } else {
      this.guildSettingsCache.delete(guildId);
    }
    return true;
  }

  private normalizeUserBan(user: UserProfile): UserProfile {
    if (isBanActive(user.isBanned, user.banExpiresAt)) return { ...user };
    return { ...user, isBanned: false, banReason: undefined, banExpiresAt: null };
  }

  private mapUser(row: any): UserProfile {
    return {
      id: row.id,
      discordUserId: row.discord_user_id,
      destinyId: row.destiny_id,
      age: Number(row.age),
      gender: row.gender,
      genderVerified: Boolean(row.gender_verified),
      genderVerificationStatus: row.gender_verification_status,
      genderVerificationEvidence: row.gender_verification_evidence,
      interests: row.interests || [],
      languages: row.languages || ['en'],
      preferredGender: row.preferred_gender || ['any'],
      minAgePref: Number(row.min_age_pref || 18),
      maxAgePref: Number(row.max_age_pref || 99),
      activeRoomId: row.active_room_id,
      isBanned: isBanActive(Boolean(row.is_banned), row.ban_expires_at || null),
      banReason: isBanActive(Boolean(row.is_banned), row.ban_expires_at || null) ? row.ban_reason : undefined,
      banExpiresAt: isBanActive(Boolean(row.is_banned), row.ban_expires_at || null) ? (row.ban_expires_at || null) : null,
      reputationScore: Number(row.reputation_score || 100),
      bio: row.bio ?? undefined,
      matchIntent: row.match_intent ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapRoom(row: any): RoomSession {
    return {
      id: row.id,
      roomCode: row.room_code,
      user1Id: row.user1_id,
      user2Id: row.user2_id,
      user1DiscordId: '',
      user2DiscordId: '',
      user1Pseudonym: row.user1_pseudonym,
      user2Pseudonym: row.user2_pseudonym,
      user1Avatar: 'ðŸ¦Š',
      user2Avatar: 'ðŸ¦‰',
      status: row.status,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      endReason: row.end_reason,
      pinnedMessageId: row.pinned_message_id,
      revealStatusUser1: row.reveal_status_user1 || { consented: false, revealedFields: [] },
      revealStatusUser2: row.reveal_status_user2 || { consented: false, revealedFields: [] },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

export const db = new DatabaseService();
