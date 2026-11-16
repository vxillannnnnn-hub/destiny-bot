import { MatchTicket, RoomSession, UserProfile } from '../types.js';
import { matchmakingEngine } from './engine.js';
import { db } from '../../database/supabase.js';
import { stateStore } from '../../storage/state-store.js';
import { config } from '../../config/index.js';
import { formatCustomEmojiText } from '../../bot/custom-emojis.js';
import { lockManager } from '../../storage/locks.js';
import { anonymizer } from '../anonymizer.js';
import { MessageFlags, ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { embedService, COLORS } from '../../bot/embeds/index.js';
import { sendCleanDmPanel } from '../../bot/dm-cleanup.js';
import { getDiscordClient } from '../../bot/client-registry.js';
import { refreshBotPresence } from '../../bot/presence-manager.js';
import fs from 'fs';
import path from 'path';

const QUEUE_STORAGE_PATH = path.resolve(process.cwd(), 'data', 'matchmaking_queue.json');
const TICKET_TTL_MS = 900_000; // 15 minutes TTL

function isValidMatchTicket(value: unknown): value is MatchTicket {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const ticket = value as Partial<MatchTicket>;
  const now = Date.now();
  const stringArray = (items: unknown, maxItems: number, maxLength: number) =>
    Array.isArray(items) && items.length <= maxItems &&
    items.every((item) => typeof item === 'string' && item.length > 0 && item.length <= maxLength);

  return typeof ticket.userId === 'string' && ticket.userId.length > 0 && ticket.userId.length <= 128 &&
    typeof ticket.destinyId === 'string' && ticket.destinyId.length > 0 && ticket.destinyId.length <= 32 &&
    typeof ticket.discordUserId === 'string' && /^[0-9]{15,22}$/.test(ticket.discordUserId) &&
    Number.isInteger(ticket.age) && (ticket.age as number) >= 18 && (ticket.age as number) <= 99 &&
    typeof ticket.gender === 'string' && ['male', 'female', 'non_binary', 'nonbinary', 'other', 'prefer_not_to_say'].includes(ticket.gender.toLowerCase()) &&
    stringArray(ticket.preferredGender, 8, 32) &&
    Number.isInteger(ticket.minAgePref) && (ticket.minAgePref as number) >= 18 &&
    Number.isInteger(ticket.maxAgePref) && (ticket.maxAgePref as number) <= 99 &&
    (ticket.minAgePref as number) <= (ticket.maxAgePref as number) &&
    stringArray(ticket.languages, 20, 16) &&
    stringArray(ticket.interests, 100, 64) &&
    (ticket.guildId === undefined || (typeof ticket.guildId === 'string' && ticket.guildId.length <= 32)) &&
    Number.isFinite(ticket.queuedAt) && (ticket.queuedAt as number) > 0 &&
    (ticket.queuedAt as number) <= now + 60_000 &&
    now - (ticket.queuedAt as number) <= TICKET_TTL_MS;
}

export class MatchmakingManager {
  private inMemoryQueue: Map<string, MatchTicket> = new Map();
  private legacyQueueMigrationAttempted = false;

  constructor() {
    this.loadPersistentQueue();
  }

  private loadPersistentQueue(): void {
    try {
      if (fs.existsSync(QUEUE_STORAGE_PATH)) {
        const raw = fs.readFileSync(QUEUE_STORAGE_PATH, 'utf-8');
        const list: MatchTicket[] = JSON.parse(raw);
        const now = Date.now();
        for (const t of list) {
          if (now - t.queuedAt <= TICKET_TTL_MS) {
            this.inMemoryQueue.set(t.userId, t);
          }
        }
        if (this.inMemoryQueue.size > 0) {
          console.log(`[Matchmaking] Restored ${this.inMemoryQueue.size} active queue tickets from disk.`);
        }
      }
    } catch (err: any) {
      console.warn('[Matchmaking] Could not load persistent queue from disk:', err?.message);
    }
  }

  private savePersistentQueue(): void {
    try {
      const dir = path.dirname(QUEUE_STORAGE_PATH);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const list = Array.from(this.inMemoryQueue.values());
      fs.writeFileSync(QUEUE_STORAGE_PATH, JSON.stringify(list, null, 2), 'utf-8');
    } catch (err: any) {
      console.warn('[Matchmaking] Could not persist queue to disk:', err?.message);
    }
  }

  /**
   * Enqueue a user into the matchmaking queue
   */
  async joinQueue(user: UserProfile, guildId?: string, mode: 'text' | 'voice' = 'text'): Promise<{ success: boolean; message: string; ticket?: MatchTicket }> {
    // Fast preflight validation avoids unnecessary database work. The full checks
    // are repeated against a force-refreshed profile inside the ticket lock.
    if (user.isBanned) {
      return { success: false, message: 'Your account is currently restricted from matchmaking.' };
    }
    if (!user.discordUserId || !/^[0-9]{15,22}$/.test(user.discordUserId) || !user.destinyId || user.destinyId.length > 32 || !['male', 'female', 'non_binary', 'nonbinary', 'other', 'prefer_not_to_say'].includes(String(user.gender).toLowerCase()) || !Number.isInteger(user.age) || user.age < 18 || user.age > 99) {
      return { success: false, message: 'Complete your 18+ profile before joining matchmaking.' };
    }

    // 2. Sliding rate limit check (max 1 join per 2 seconds, relaxed for mood switching)
    const alreadyQueued = await this.isQueued(user.id);
    if (!alreadyQueued) {
      const rateLimit = await stateStore.checkRateLimit(`queue:${user.id}`, 1, 2);
      if (!rateLimit.allowed) {
        return { success: false, message: 'You are queuing too quickly. Please wait a moment.' };
      }
    }

    // Re-read all eligibility fields while holding the same per-user lock that
    // protects leave/rejoin and match reservation. Never enqueue from a stale
    // interaction snapshot after an admin ban or profile edit.
    const outcome = await lockManager.withLock(`lock:ticket:${user.id}`, async (): Promise<{ ticket?: MatchTicket; message?: string }> => {
      const latestProfile = await db.getUserById(user.id, true);
      if (!latestProfile) return { message: 'Your profile could not be found. Please set it up again.' };
      if (latestProfile.isBanned) {
        return { message: 'Your account is currently restricted from matchmaking.' };
      }
      if (!latestProfile.discordUserId || !/^[0-9]{15,22}$/.test(latestProfile.discordUserId) ||
          !latestProfile.destinyId || latestProfile.destinyId.length > 32 ||
          !['male', 'female', 'non_binary', 'nonbinary', 'other', 'prefer_not_to_say'].includes(String(latestProfile.gender).toLowerCase()) ||
          !Number.isInteger(latestProfile.age) || latestProfile.age < 18 || latestProfile.age > 99) {
        return { message: 'Complete your 18+ profile before joining matchmaking.' };
      }

      const minAgePref = latestProfile.minAgePref || 18;
      const maxAgePref = latestProfile.maxAgePref || 99;
      if (!Number.isInteger(minAgePref) || !Number.isInteger(maxAgePref) ||
          minAgePref < 18 || maxAgePref > 99 || minAgePref > maxAgePref) {
        return { message: 'Your age preferences are invalid. Please update your profile and try again.' };
      }

      if (latestProfile.activeRoomId) {
        const latestRoom = await db.getRoomById(latestProfile.activeRoomId);
        if (latestRoom?.status === 'active') {
          return { message: 'You are already in an active room. Use `/cancel match` to exit first.' };
        }
        const cleared = await db.clearActiveRoom(user.id, latestProfile.activeRoomId);
        if (!cleared) {
          return { message: 'Your room status changed. Please try joining the queue again.' };
        }
      }

      const languages = (Array.isArray(latestProfile.languages) ? latestProfile.languages : [])
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .map((value) => value.trim().slice(0, 16))
        .slice(0, 20);
      if (languages.length === 0) languages.push('en');

      const interests = (Array.isArray(latestProfile.interests) ? latestProfile.interests : [])
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .map((value) => value.trim().slice(0, 64))
        .slice(0, 100);

      const ticketKey = `ticket:${latestProfile.id}`;
      const guildContextKey = `user:origin_guild:${latestProfile.id}`;
      let queuedAt = Date.now();
      let ticketTtlSeconds = Math.ceil(TICKET_TTL_MS / 1000);
      let effectiveGuildId = guildId;

      // Refresh profile compatibility data without resetting FIFO position or
      // extending the original 15-minute queue lease on duplicate start clicks.
      const existingRaw = await stateStore.get(ticketKey);
      if (existingRaw) {
        try {
          const existingTicket = JSON.parse(existingRaw) as MatchTicket;
          if (
            isValidMatchTicket(existingTicket) &&
            existingTicket.userId === latestProfile.id &&
            existingTicket.discordUserId === latestProfile.discordUserId
          ) {
            queuedAt = existingTicket.queuedAt;
            ticketTtlSeconds = Math.ceil((queuedAt + TICKET_TTL_MS - Date.now()) / 1000);
            if (!effectiveGuildId && existingTicket.guildId) effectiveGuildId = existingTicket.guildId;
          }
        } catch {
          // Replace malformed ticket data with a fresh, validated snapshot.
        }
      }
      if (!effectiveGuildId) {
        effectiveGuildId = (await stateStore.get(guildContextKey)) || undefined;
      }
      if (effectiveGuildId) {
        // DM buttons have no guildId. Preserve the user's last explicit server
        // context so a re-match from DMs cannot silently escape that server's
        // cross-server matchmaking policy. Starting /match in another guild
        // explicitly replaces this context.
        await stateStore.set(guildContextKey, effectiveGuildId, 30 * 24 * 60 * 60);
      }
      if (ticketTtlSeconds <= 0) {
        queuedAt = Date.now();
        ticketTtlSeconds = Math.ceil(TICKET_TTL_MS / 1000);
      }

      const ticket: MatchTicket = {
        userId: latestProfile.id,
        destinyId: latestProfile.destinyId,
        discordUserId: latestProfile.discordUserId,
        age: latestProfile.age,
        gender: latestProfile.gender,
        preferredGender: ['any'],
        minAgePref,
        maxAgePref,
        languages,
        interests,
        guildId: effectiveGuildId,
        queuedAt,
        mode,
      };

      const serialized = JSON.stringify(ticket);
      try {
        await stateStore.set(ticketKey, serialized, ticketTtlSeconds);
        await stateStore.sAdd('matchmaking:queue', latestProfile.id);
      } catch (error) {
        // Do not leave an orphaned ticket/set member when the second write
        // fails. Conditional deletion cannot erase a newer replacement.
        await Promise.allSettled([
          stateStore.delIfValue(ticketKey, serialized),
          stateStore.sRem('matchmaking:queue', latestProfile.id),
        ]);
        throw error;
      }

      this.inMemoryQueue.set(latestProfile.id, ticket);
      this.savePersistentQueue();
      return { ticket };
    });

    if (!outcome.ticket) {
      return {
        success: false,
        message: outcome.message || 'You are already in an active room. Use `leave` to exit first.',
      };
    }
    return {
      success: true,
      message: 'Successfully joined the anonymous matchmaking queue.',
      ticket: outcome.ticket,
    };
  }

  /** Execute a queue/profile transition under the same lock used by match reservation. */
  async withTicketLock<T>(userId: string, operation: () => Promise<T>): Promise<T> {
    return lockManager.withLock(`lock:ticket:${userId}`, operation);
  }

  /**
   * Remove a stale queue-set entry only after rechecking under the user's lock.
   * This keeps the lock-free bulk scan from deleting a concurrent rejoin.
   */
  private async removeInvalidQueueSnapshot(userId: string, expectedRaw?: string): Promise<void> {
    await this.withTicketLock(userId, async () => {
      const key = `ticket:${userId}`;
      const current = await stateStore.get(key);
      if (expectedRaw === undefined) {
        if (current !== null) return;
        await stateStore.sRem('matchmaking:queue', userId);
        this.inMemoryQueue.delete(userId);
        return;
      }
      if (current !== expectedRaw) return;
      const removed = await stateStore.delIfValue(key, expectedRaw);
      if (removed) {
        await stateStore.sRem('matchmaking:queue', userId);
        this.inMemoryQueue.delete(userId);
      }
    });
  }

  /**
   * Acquire multiple ticket locks in a stable global order when an operation
   * truly needs a multi-user critical section (e.g. final room reservation).
   */
  async withTicketLocks<T>(userIds: string[], operation: () => Promise<T>): Promise<T> {
    const ordered = Array.from(new Set(userIds)).sort((a, b) => a.localeCompare(b));
    const acquire = (index: number): Promise<T> => {
      if (index >= ordered.length) return operation();
      return lockManager.withLock(`lock:ticket:${ordered[index]}`, () => acquire(index + 1));
    };
    return acquire(0);
  }

  /** Remove a ticket when the caller already holds this user's ticket lock. */
  async removeQueueTicketUnderLock(userId: string): Promise<void> {
    await stateStore.del(`ticket:${userId}`);
    await stateStore.sRem('matchmaking:queue', userId);
    this.inMemoryQueue.delete(userId);
    this.savePersistentQueue();
  }

  /**
   * Remove a user from the matchmaking queue
   */
  async leaveQueue(userId: string): Promise<boolean> {
    return await this.withTicketLock(userId, async () => {
      await this.removeQueueTicketUnderLock(userId);
      return true;
    });
  }

  /**
   * Returns whether a user is currently queued (auto-evicts expired tickets)
   */
  async isQueued(userId: string): Promise<boolean> {
    if (stateStore.isHealthy()) {
      return this.withTicketLock(userId, async () => {
        const key = `ticket:${userId}`;
        const raw = await stateStore.get(key);
        if (!raw) {
          this.inMemoryQueue.delete(userId);
          return false;
        }

        let ticket: MatchTicket | null = null;
        try {
          ticket = JSON.parse(raw) as MatchTicket;
        } catch {
          ticket = null;
        }

        if (
          !ticket ||
          !isValidMatchTicket(ticket) ||
          ticket.userId !== userId ||
          Date.now() - ticket.queuedAt > TICKET_TTL_MS
        ) {
          // We are holding the same lock as join/leave/reserve, so only the
          // exact current value can be evicted; no newer rejoin can be lost.
          const removed = await stateStore.delIfValue(key, raw);
          if (removed) await stateStore.sRem('matchmaking:queue', userId);
          this.inMemoryQueue.delete(userId);
          return false;
        }

        this.inMemoryQueue.set(userId, ticket);
        return true;
      });
    }

    if (config.NODE_ENV === 'production') {
      throw new Error('Supabase is required to check the shared matchmaking queue in production.');
    }

    const memoryTicket = this.inMemoryQueue.get(userId);
    if (!memoryTicket) return false;
    if (
      !isValidMatchTicket(memoryTicket) ||
      memoryTicket.userId !== userId ||
      Date.now() - memoryTicket.queuedAt > TICKET_TTL_MS
    ) {
      this.inMemoryQueue.delete(userId);
      this.savePersistentQueue();
      return false;
    }
    return true;
  }

  /**
   * Get all active queue tickets, evicting expired (>15m) tickets
   */
  async getQueueTickets(): Promise<MatchTicket[]> {
    const now = Date.now();
    if (config.NODE_ENV === 'production' && !stateStore.isHealthy()) {
      throw new Error('Supabase is required to read the shared matchmaking queue in production.');
    }

    if (stateStore.isHealthy()) {
      let ids = await stateStore.sMembers('matchmaking:queue');
      if (stateStore.isHealthy()) {
        // One-time migration for tickets restored from the legacy local JSON file.
        if (!this.legacyQueueMigrationAttempted) {
          this.legacyQueueMigrationAttempted = true;
          if (ids.length === 0 && this.inMemoryQueue.size > 0) {
            for (const [userId, ticket] of this.inMemoryQueue) {
              const remaining = Math.ceil((ticket.queuedAt + TICKET_TTL_MS - now) / 1000);
              if (remaining > 0 && isValidMatchTicket(ticket)) {
                await stateStore.set(`ticket:${userId}`, JSON.stringify(ticket), remaining);
                await stateStore.sAdd('matchmaking:queue', userId);
              }
            }
            ids = await stateStore.sMembers('matchmaking:queue');
          }
        }

        const activeTickets: MatchTicket[] = [];
        const activeIds = new Set<string>();
        const lockBatchSize = 100;

        // Read a lightweight candidate snapshot without per-user distributed
        // locks. Every selected pair is revalidated against fresh profiles and
        // exact ticket values under both ticket locks during final reservation.
        for (let offset = 0; offset < ids.length; offset += lockBatchSize) {
          const batch = ids.slice(offset, offset + lockBatchSize);
          const profiles = await db.getUsersByIds(batch, true);
          const ticketValues = await stateStore.getMany(batch.map((userId) => `ticket:${userId}`));
          const profilesById = new Map(profiles.map((profile) => [profile.id, profile]));

          for (const userId of batch) {
              const key = `ticket:${userId}`;
              const raw = ticketValues.get(key) ?? null;
              if (!raw) {
                await this.removeInvalidQueueSnapshot(userId);
                continue;
              }

              let ticket: MatchTicket;
              try {
                ticket = JSON.parse(raw) as MatchTicket;
              } catch {
                await this.removeInvalidQueueSnapshot(userId, raw);
                continue;
              }

              const remainingSeconds = Math.ceil((ticket.queuedAt + TICKET_TTL_MS - Date.now()) / 1000);
              const profile = profilesById.get(userId);
              const allowedGenders = ['male', 'female', 'non_binary', 'nonbinary', 'other', 'prefer_not_to_say'];
              const minAgePref = profile?.minAgePref ?? 18;
              const maxAgePref = profile?.maxAgePref ?? 99;
              const profileEligible = Boolean(
                profile &&
                profile.id === userId &&
                !profile.isBanned &&
                !profile.activeRoomId &&
                typeof profile.discordUserId === 'string' &&
                /^[0-9]{15,22}$/.test(profile.discordUserId) &&
                typeof profile.destinyId === 'string' &&
                profile.destinyId.length > 0 &&
                profile.destinyId.length <= 32 &&
                Number.isInteger(profile.age) &&
                profile.age >= 18 &&
                profile.age <= 99 &&
                allowedGenders.includes(String(profile.gender).toLowerCase()) &&
                Number.isInteger(minAgePref) &&
                Number.isInteger(maxAgePref) &&
                minAgePref >= 18 &&
                maxAgePref <= 99 &&
                minAgePref <= maxAgePref
              );

              if (
                remainingSeconds <= 0 ||
                !isValidMatchTicket(ticket) ||
                ticket.userId !== userId ||
                !profileEligible
              ) {
                await this.removeInvalidQueueSnapshot(userId, raw);
                continue;
              }

              const languages = (Array.isArray(profile!.languages) ? profile!.languages : [])
                .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
                .map((value) => value.trim().slice(0, 16))
                .slice(0, 20);
              if (languages.length === 0) languages.push('en');

              const interests = (Array.isArray(profile!.interests) ? profile!.interests : [])
                .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
                .map((value) => value.trim().slice(0, 64))
                .slice(0, 100);

              const refreshedTicket: MatchTicket = {
                ...ticket,
                destinyId: profile!.destinyId,
                discordUserId: profile!.discordUserId,
                age: profile!.age,
                gender: profile!.gender,
                preferredGender: Array.isArray(profile!.preferredGender) && profile!.preferredGender.length > 0
                  ? profile!.preferredGender
                  : ['any'],
                minAgePref,
                maxAgePref,
                languages,
                interests,
              };

              if (!isValidMatchTicket(refreshedTicket)) {
                await this.removeInvalidQueueSnapshot(userId, raw);
                continue;
              }

              // Do not write the refreshed snapshot back without the ticket lock:
              // a concurrent rejoin may have replaced this key after getMany().
              // The final reservation refreshes the profile again under both locks.
              this.inMemoryQueue.set(userId, refreshedTicket);
              activeIds.add(userId);
              activeTickets.push(refreshedTicket);
            }
        }

        for (const userId of this.inMemoryQueue.keys()) {
          if (!activeIds.has(userId)) this.inMemoryQueue.delete(userId);
        }

        activeTickets.sort((a, b) => a.queuedAt - b.queuedAt);
        return activeTickets;
      }
    }

    // In-memory mode is strictly for local development/tests. Production never
    // treats one process's memory as a shared queue.
    let changed = false;
    for (const [userId, ticket] of this.inMemoryQueue.entries()) {
      if (now - ticket.queuedAt > TICKET_TTL_MS) {
        this.inMemoryQueue.delete(userId);
        changed = true;
      }
    }
    if (changed) this.savePersistentQueue();

    return Array.from(this.inMemoryQueue.entries())
      .filter(([userId, ticket]) => {
        const valid = isValidMatchTicket(ticket) && ticket.userId === userId;
        if (!valid) this.inMemoryQueue.delete(userId);
        return valid;
      })
      .map(([, ticket]) => ticket)
      .sort((a, b) => a.queuedAt - b.queuedAt);
  }

  private async createMatchRoomRecord(ticketA: MatchTicket, ticketB: MatchTicket): Promise<RoomSession> {
    const roomCode = anonymizer.generateRoomCode();
    const personaA = anonymizer.generatePersona(ticketA.userId, roomCode);
    const personaB = anonymizer.generatePersona(ticketB.userId, roomCode);
    const room = await db.createRoom({
      roomCode,
      user1Id: ticketA.userId,
      user2Id: ticketB.userId,
      user1DiscordId: ticketA.discordUserId,
      user2DiscordId: ticketB.discordUserId,
      user1Pseudonym: personaA.pseudonym,
      user2Pseudonym: personaB.pseudonym,
      user1Avatar: personaA.avatarEmoji,
      user2Avatar: personaB.avatarEmoji,
      status: 'active',
      startedAt: new Date().toISOString(),
      revealStatusUser1: { consented: false, revealedFields: [] },
      revealStatusUser2: { consented: false, revealedFields: [] },
    });
    room.user1DiscordId = ticketA.discordUserId;
    room.user2DiscordId = ticketB.discordUserId;
    room.user1Avatar = personaA.avatarEmoji;
    room.user2Avatar = personaB.avatarEmoji;
    return room;
  }

  /**
   * Reserve a pair against concurrent leave/rejoin requests. Locks are always
   * acquired in sorted user-id order to avoid deadlocks. The state values are
   * compared with the cycle snapshot before either ticket is consumed.
   */
  private async reserveTicketsAndCreateRoom(
    ticketA: MatchTicket,
    ticketB: MatchTicket
  ): Promise<RoomSession | null> {
    const ordered = [ticketA, ticketB].sort((a, b) => a.userId.localeCompare(b.userId));
    // Keep a handle to any committed room so lease loss after the DB insert
    // cannot strand participants in an active room without cache/DM setup.
    const reservationState: { createdRoom: RoomSession | null } = { createdRoom: null };
    try {
      return await lockManager.withLock(`lock:ticket:${ordered[0].userId}`, async () =>
        lockManager.withLock(`lock:ticket:${ordered[1].userId}`, async () => {
          const [rawA, rawB] = await Promise.all([
            stateStore.get(`ticket:${ticketA.userId}`),
            stateStore.get(`ticket:${ticketB.userId}`),
          ]);
          const matchesSnapshot = (raw: string | null, expected: MatchTicket) => {
            if (!raw) return false;
            try {
              const current = JSON.parse(raw) as MatchTicket;
              return isValidMatchTicket(current) &&
                current.userId === expected.userId &&
                current.discordUserId === expected.discordUserId &&
                current.queuedAt === expected.queuedAt;
            } catch {
              return false;
            }
          };
          if (!matchesSnapshot(rawA, ticketA) || !matchesSnapshot(rawB, ticketB)) return null;

          // The queue scan happens before reservation. Re-read both profiles
          // while both ticket locks are held so profile edits, bans, and room
          // assignments between those two phases cannot authorize a stale match.
          const latestProfiles = await db.getUsersByIds([ticketA.userId, ticketB.userId], true);
          const profiles = new Map(latestProfiles.map((profile) => [profile.id, profile]));
          const profileA = profiles.get(ticketA.userId);
          const profileB = profiles.get(ticketB.userId);
          const buildFreshTicket = (ticket: MatchTicket, profile: UserProfile | undefined): MatchTicket | null => {
            if (
              !profile ||
              profile.isBanned ||
              Boolean(profile.activeRoomId) ||
              !/^[0-9]{15,22}$/.test(profile.discordUserId || '') ||
              !profile.destinyId ||
              profile.destinyId.length > 32 ||
              !Number.isInteger(profile.age) ||
              profile.age < 18 ||
              profile.age > 99
            ) return null;

            const minAgePref = profile.minAgePref ?? 18;
            const maxAgePref = profile.maxAgePref ?? 99;
            if (
              !Number.isInteger(minAgePref) ||
              !Number.isInteger(maxAgePref) ||
              minAgePref < 18 ||
              maxAgePref > 99 ||
              minAgePref > maxAgePref
            ) return null;

            const languages = (Array.isArray(profile.languages) ? profile.languages : [])
              .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
              .map((value) => value.trim().slice(0, 16))
              .slice(0, 20);
            const interests = (Array.isArray(profile.interests) ? profile.interests : [])
              .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
              .map((value) => value.trim().slice(0, 64))
              .slice(0, 100);
            const preferredGender = Array.isArray(profile.preferredGender) && profile.preferredGender.length > 0
              ? profile.preferredGender
              : ['any'];

            const refreshed: MatchTicket = {
              ...ticket,
              destinyId: profile.destinyId,
              discordUserId: profile.discordUserId,
              age: profile.age,
              gender: profile.gender,
              preferredGender,
              minAgePref,
              maxAgePref,
              languages: languages.length > 0 ? languages : ['en'],
              interests,
            };
            return isValidMatchTicket(refreshed) ? refreshed : null;
          };

          const freshTicketA = buildFreshTicket(ticketA, profileA);
          const freshTicketB = buildFreshTicket(ticketB, profileB);
          if (!freshTicketA || !freshTicketB) return null;

          // Always fetch current block lists at reservation time; cached cycle
          // snapshots can be stale if a user blocked their potential partner.
          const latestCompatibility = await matchmakingEngine.evaluateMatch(freshTicketA, freshTicketB);
          if (!latestCompatibility.isEligible) return null;

          const removedA = await stateStore.delIfValue(`ticket:${ticketA.userId}`, rawA!);
          if (!removedA) return null;
          const removedB = await stateStore.delIfValue(`ticket:${ticketB.userId}`, rawB!);
          if (!removedB) {
            await stateStore.set(`ticket:${ticketA.userId}`, rawA!, 900);
            await stateStore.sAdd('matchmaking:queue', ticketA.userId);
            return null;
          }

          try {
            await Promise.all([
              stateStore.sRem('matchmaking:queue', ticketA.userId),
              stateStore.sRem('matchmaking:queue', ticketB.userId),
            ]);
          } catch (error) {
            // Restore both tickets if queue-set cleanup fails partway through.
            await Promise.allSettled([
              stateStore.set(`ticket:${ticketA.userId}`, rawA!, 900),
              stateStore.set(`ticket:${ticketB.userId}`, rawB!, 900),
              stateStore.sAdd('matchmaking:queue', ticketA.userId),
              stateStore.sAdd('matchmaking:queue', ticketB.userId),
            ]);
            throw error;
          }

          this.inMemoryQueue.delete(ticketA.userId);
          this.inMemoryQueue.delete(ticketB.userId);
          this.savePersistentQueue();
          // Create the database room before releasing ticket locks. This closes
          // the gap where a concurrent /match could re-enqueue an active user.
          reservationState.createdRoom = await this.createMatchRoomRecord(freshTicketA, freshTicketB);
          return reservationState.createdRoom;
        })
      );
    } catch (error) {
      const roomToRollback = reservationState.createdRoom;
      if (roomToRollback) {
        await db.endRoom(roomToRollback.id, 'timeout').catch((rollbackError) => {
          console.error('[Matchmaking] Could not roll back room after reservation lease loss:', rollbackError);
        });
      }
      throw error;
    }
  }

  /**
   * Process matchmaking iteration atomically
   */
  async processMatchCycle(): Promise<{ matchesCreated: number }> {
    // The worker starts before Discord login completes. Never consume tickets
    // or create active rooms until the client can actually deliver both DMs.
    const client = getDiscordClient();
    if (!client || !client.isReady()) return { matchesCreated: 0 };

    return await lockManager.withLock('lock:matchmaking:cycle', async () => {
      const cycleStartedAt = performance.now();
      const queueStartedAt = performance.now();
      const tickets = await this.getQueueTickets();
      const queueLoadMs = Math.round(performance.now() - queueStartedAt);
      if (tickets.length < 2) return { matchesCreated: 0 };

      console.log(`[Matchmaking Cycle] Evaluating ${tickets.length} queue tickets.`);

      let matchesCreated = 0;
      const preloadStartedAt = performance.now();
      const [blockLists, guildSettings] = await Promise.all([
        matchmakingEngine.preloadBlockLists(tickets),
        matchmakingEngine.preloadGuildSettings(tickets),
      ]);
      const preloadMs = Math.round(performance.now() - preloadStartedAt);
      const matchingStartedAt = performance.now();
      // Randomize the queue once. Since the remaining candidates retain a
      // uniformly random order, the first compatible candidate is a fair
      // random choice without a full reservoir-sampling scan.
      const unmatched = [...tickets];
      for (let i = unmatched.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [unmatched[i], unmatched[j]] = [unmatched[j], unmatched[i]];
      }

      while (unmatched.length > 1) {
        const ticketA = unmatched.pop()!;
        const match = await matchmakingEngine.findRandomMatch(
          ticketA, unmatched, blockLists, guildSettings, true
        );
        if (match) {
          const ticketB = unmatched[match.index];
          if (!ticketB || ticketB.userId !== match.partner.userId) continue;
          // O(1) unordered removal; the queue was randomized before selection.
          unmatched[match.index] = unmatched[unmatched.length - 1];
          unmatched.pop();

          console.log('[Matchmaking Cycle] Compatible pair found; reserving queue tickets.');
          try {
            const reservedRoom = await this.reserveTicketsAndCreateRoom(ticketA, ticketB);
            if (!reservedRoom) {
              // One user left, rejoined, or had their ticket refreshed after the
              // queue snapshot. Keep the other candidate available for matching.
              unmatched.push(ticketB);
              continue;
            }
            // The DB room is committed under both ticket locks. Release them
            // before state persistence and Discord DM delivery.
            const createdRoom = await this.createMatchRoom(
              ticketA,
              ticketB,
              match.matchResult.sharedInterests,
              reservedRoom
            );
            if (createdRoom.status === 'active') matchesCreated++;
          } catch (error) {
            console.error('[Matchmaking] Room creation failed; restoring queue tickets:', error);
            for (const ticket of [ticketA, ticketB]) {
              const profile = await db.getUserById(ticket.userId, true).catch(() => null);
              if (profile) {
                await this.joinQueue(profile, ticket.guildId).catch((requeueError) => {
                  console.error('[Matchmaking] Could not restore queue ticket:', requeueError);
                });
              }
            }
          }
        }
      }

      const totalMs = Math.round(performance.now() - cycleStartedAt);
      const matchingAndDeliveryMs = Math.round(performance.now() - matchingStartedAt);
      console.log(`[Matchmaking Cycle] Complete: ${matchesCreated} matches from ${tickets.length} tickets | queue=${queueLoadMs}ms preload=${preloadMs}ms matching+delivery=${matchingAndDeliveryMs}ms total=${totalMs}ms`);
      return { matchesCreated };
    });
  }

  /**
   * Creates a confirmed match room between two users
   */
  async createMatchRoom(
    ticketA: MatchTicket,
    ticketB: MatchTicket,
    sharedInterests: string[] = [],
    precreatedRoom?: RoomSession
  ): Promise<RoomSession> {
    const room = precreatedRoom ?? await this.createMatchRoomRecord(ticketA, ticketB);

    // Cache active room session in Supabase. If any write fails, roll back
    // the newly-created database room so participants are not stranded.
    try {
      const cacheResults = await Promise.allSettled([
        stateStore.set(`room:${room.id}`, JSON.stringify(room), 86400),
        stateStore.set(`user:active_room:${ticketA.userId}`, room.id, 86400),
        stateStore.set(`user:active_room:${ticketB.userId}`, room.id, 86400),
      ]);
      const failedCacheWrite = cacheResults.find((result) => result.status === 'rejected');
      if (failedCacheWrite?.status === 'rejected') throw failedCacheWrite.reason;
    } catch (cacheError) {
      await db.endRoom(room.id, 'timeout').catch((rollbackError) => {
        console.error('[Matchmaking] Could not roll back room after cache failure:', rollbackError);
      });
      throw cacheError;
    }

    // Notify both users concurrently. A room is only considered delivered
    // when both DMs succeed; partial delivery is rolled back and the reachable
    // participant is returned to the queue.
    const client = getDiscordClient();
    if (!client || !client.isReady()) {
      if (config.NODE_ENV !== 'production') {
        // Unit/integration environments intentionally do not log in to Discord.
        console.warn('[Matchmaking] Discord is unavailable outside production; skipping DM delivery.');
        refreshBotPresence();
        return room;
      }
      await db.endRoom(room.id, 'timeout');
      room.status = 'ended';
      room.endedAt = new Date().toISOString();
      room.endReason = 'timeout';
      throw new Error('Discord client became unavailable before match notifications.');
    }

    const [userAResult, userBResult] = await Promise.allSettled([
      client.users.fetch(ticketA.discordUserId),
      client.users.fetch(ticketB.discordUserId),
    ]);
    const userA = userAResult.status === 'fulfilled' ? userAResult.value : null;
    const userB = userBResult.status === 'fulfilled' ? userBResult.value : null;

    const [deliveryA, deliveryB] = await Promise.allSettled([
      userA
        ? sendCleanDmPanel(userA, {
            components: [embedService.createMatchFoundContainer(room, true, sharedInterests)],
            flags: [MessageFlags.IsComponentsV2],
          })
        : Promise.reject(new Error('Could not fetch Discord user A')),
      userB
        ? sendCleanDmPanel(userB, {
            components: [embedService.createMatchFoundContainer(room, false, sharedInterests)],
            flags: [MessageFlags.IsComponentsV2],
          })
        : Promise.reject(new Error('Could not fetch Discord user B')),
    ]);
    const sentA = deliveryA.status === 'fulfilled';
    const sentB = deliveryB.status === 'fulfilled';

    if (!sentA || !sentB) {
      await db.endRoom(room.id, 'user_left');
      room.status = 'ended';
      room.endedAt = new Date().toISOString();
      room.endReason = 'user_left';

      const reachableUser = sentA ? userA : sentB ? userB : null;
      if (reachableUser) {
        const notice = new ContainerBuilder()
          .setAccentColor(COLORS.GOLD)
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              formatCustomEmojiText('# ⚠️ Partner Unreachable\n\nYour match partner could not be reached through Discord DMs. We have returned you to the top of the queue.')
            )
          );
        await sendCleanDmPanel(reachableUser, { components: [notice], flags: [MessageFlags.IsComponentsV2] }).catch(() => {});
      }

      const ticketsToRestore = sentA ? [ticketA] : sentB ? [ticketB] : [ticketA, ticketB];
      for (const ticket of ticketsToRestore) {
        const profile = await db.getUserById(ticket.userId, true).catch(() => null);
        if (profile) {
          await this.joinQueue(profile, ticket.guildId).catch((requeueError) => {
            console.error('[Matchmaking] Could not requeue reachable participant:', requeueError);
          });
        }
      }
    }

    // A new conversation is live — reflect it in the rotating presence.
    refreshBotPresence();

    const effectiveGuildId = ticketA.guildId || ticketB.guildId;
    if (effectiveGuildId) {
      await stateStore.set(`room:${room.id}:guild_id`, effectiveGuildId, 86400 * 7).catch(() => {});
    }

    if (sentA && sentB && ticketA.mode === 'voice') {
      try {
        const { voiceManager } = await import('../voice/manager.js');
        const userProfileA = await db.getUserById(ticketA.userId);
        const userProfileB = await db.getUserById(ticketB.userId);
        if (userProfileA && userProfileB) {
          const vcResult = await voiceManager.createVoiceMatchRoom(client, userProfileA, userProfileB, effectiveGuildId);
          if (vcResult) {
            const { ECLAIRS_INVITE_URL } = await import('../moderation/reputation.js');
            const vcNotice = (partnerDestinyId: string) =>
              new ContainerBuilder()
                .setAccentColor(COLORS.DESTINY_PURPLE)
                .addTextDisplayComponents(
                  new TextDisplayBuilder().setContent(
                    formatCustomEmojiText(
                      `# 🎙️ Your Blind Voice Match is Ready!\n\n` +
                      `You matched with **${partnerDestinyId}** for a blind speed voice call!\n\n` +
                      `• ⏱️ **Duration:** \`${vcResult.durationMins} Minutes\` (timer starts when both join)\n` +
                      `• 🏰 **Host Server:** ${vcResult.isEclairsFallback ? '🌟 Official Eclairs Hub (`discord.gg/eclairs`)' : `🏰 **${vcResult.guild.name}**`}\n` +
                      `• 🔊 **Voice Channel:** <#${vcResult.channel.id}>\n\n` +
                      (vcResult.isEclairsFallback
                        ? `> ⚠️ **First Time in Eclairs?** Click **[🏰 Join Eclairs Hub]** first so Discord lets you connect to the voice channel!\n\n`
                        : '') +
                      `Click **🎙️ Join Voice Channel** below to enter your private room!\n\n` +
                      `-# 🔒 2-person ephemeral room • Interactive dashboard with Icebreakers, +5m Extend & Reveal inside.`
                    )
                  )
                )
                .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
                .addActionRowComponents(
                  new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder()
                      .setLabel('🎙️ Join Voice Channel')
                      .setStyle(ButtonStyle.Link)
                      .setURL(`https://discord.com/channels/${vcResult.guild.id}/${vcResult.channel.id}`),
                    ...(vcResult.isEclairsFallback
                      ? [
                          new ButtonBuilder()
                            .setLabel('🏰 Join Eclairs Hub')
                            .setStyle(ButtonStyle.Link)
                            .setURL(ECLAIRS_INVITE_URL),
                        ]
                      : [])
                  )
                );

            if (userA) await sendCleanDmPanel(userA, { components: [vcNotice(ticketB.destinyId)], flags: [MessageFlags.IsComponentsV2] }).catch(() => {});
            if (userB) await sendCleanDmPanel(userB, { components: [vcNotice(ticketA.destinyId)], flags: [MessageFlags.IsComponentsV2] }).catch(() => {});
          } else {
            // Voice channel creation failed (guild at limit or missing permissions)
            const failNotice = new ContainerBuilder()
              .setAccentColor(COLORS.DANGER)
              .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                  formatCustomEmojiText(
                    `# ⚠️ Voice Room Creation Failed\n\n` +
                    `We matched you with a partner, but a temporary voice room could not be created at this moment (the server may have reached Discord's 500-channel limit or bot lacks Manage Channels permissions).\n\n` +
                    `Your ticket has been returned to the queue so you will be paired again shortly!`
                  )
                )
              );
            if (userA) await sendCleanDmPanel(userA, { components: [failNotice], flags: [MessageFlags.IsComponentsV2] }).catch(() => {});
            if (userB) await sendCleanDmPanel(userB, { components: [failNotice], flags: [MessageFlags.IsComponentsV2] }).catch(() => {});
            await this.joinQueue(userProfileA, ticketA.guildId, 'voice').catch(() => {});
            await this.joinQueue(userProfileB, ticketB.guildId, 'voice').catch(() => {});
          }
        }
      } catch (err: any) {
        console.error('[Matchmaking] Failed to create voice match room:', err?.message || err);
      }
    }

    if (sentA && sentB && effectiveGuildId) {
      const { dispatchPairedLogEvent } = await import('../../bot/paired-logs.js');
      dispatchPairedLogEvent(client, effectiveGuildId, 'Pair', {
        discordUserId1: ticketA.discordUserId,
        discordUserId2: ticketB.discordUserId,
        pseudonym1: room.user1Pseudonym,
        pseudonym2: room.user2Pseudonym,
      }).catch(() => {});
    }

    return room;
  }

}

export const matchmakingManager = new MatchmakingManager();
