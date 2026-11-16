import { MatchTicket } from '../types.js';
import { db } from '../../database/supabase.js';

export interface MatchCandidateResult {
  score: number;
  isEligible: boolean;
  sharedInterests: string[];
  reasons: string[];
}

interface NormalizedTicket {
  languages: ReadonlySet<string>;
  interests: ReadonlySet<string>;
  minAge: number;
  maxAge: number;
  queuedAt: number;
}

// Tickets are immutable queue snapshots for a cycle. Cache their normalized
// fields by object identity so a large candidate scan does not rebuild Sets
// for the same users thousands of times.
const normalizedTickets = new WeakMap<MatchTicket, NormalizedTicket>();

function normalizeTicket(ticket: MatchTicket): NormalizedTicket {
  const cached = normalizedTickets.get(ticket);
  if (cached) return cached;

  // "Hinglish" means the user can communicate in both Hindi and English.
  // Expand this common mixed-language label into its constituent languages
  // so it can match profiles that list either language separately.
  const languageAliases: Record<string, string[]> = {
    hinglish: ['hindi', 'english'],
    'hindi-english': ['hindi', 'english'],
    'english-hindi': ['english', 'hindi'],
  };
  const languages = new Set(
    (Array.isArray(ticket.languages) ? ticket.languages : [])
      .filter((value): value is string => typeof value === 'string')
      .flatMap((value) => {
        const normalized = value.trim().toLowerCase();
        return languageAliases[normalized] ?? (normalized ? [normalized] : []);
      })
  );
  const interests = new Set(
    (Array.isArray(ticket.interests) ? ticket.interests : [])
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
  );
  const normalized: NormalizedTicket = {
    languages,
    interests,
    minAge: ticket.minAgePref === undefined ? 18 : ticket.minAgePref,
    maxAge: ticket.maxAgePref === undefined ? 99 : ticket.maxAgePref,
    queuedAt: Number.isFinite(ticket.queuedAt) ? ticket.queuedAt : 0,
  };
  normalizedTickets.set(ticket, normalized);
  return normalized;
}

function invalid(reason = 'INVALID_PROFILE'): MatchCandidateResult {
  return { score: 0, isEligible: false, sharedInterests: [], reasons: [reason] };
}

export class MatchmakingEngine {
  private evaluateWithBlockLists(
    ticketA: MatchTicket,
    ticketB: MatchTicket,
    preloadedBlockLists: ReadonlyMap<string, ReadonlySet<string>>
  ): MatchCandidateResult {
    if (!ticketA || !ticketB ||
      typeof ticketA.userId !== 'string' || !ticketA.userId ||
      typeof ticketB.userId !== 'string' || !ticketB.userId ||
      typeof ticketA.discordUserId !== 'string' || !ticketA.discordUserId ||
      typeof ticketB.discordUserId !== 'string' || !ticketB.discordUserId ||
      !Number.isInteger(ticketA.age) || ticketA.age < 18 || ticketA.age > 99 ||
      !Number.isInteger(ticketB.age) || ticketB.age < 18 || ticketB.age > 99) {
      return invalid();
    }

    if (ticketA.userId === ticketB.userId || ticketA.discordUserId === ticketB.discordUserId) {
      return invalid('SELF_MATCH');
    }

    const modeA = ticketA.mode || 'text';
    const modeB = ticketB.mode || 'text';
    if (modeA !== modeB) {
      return invalid('MODE_MISMATCH');
    }

    const a = normalizeTicket(ticketA);
    const b = normalizeTicket(ticketB);
    const validRange = (min: number, max: number) =>
      Number.isInteger(min) && Number.isInteger(max) && min >= 18 && max <= 99 && min <= max;
    if (!validRange(a.minAge, a.maxAge) || !validRange(b.minAge, b.maxAge)) return invalid();

    if (ticketB.age < a.minAge || ticketB.age > a.maxAge ||
        ticketA.age < b.minAge || ticketA.age > b.maxAge) {
      return invalid('AGE_INCOMPATIBLE');
    }

    if (a.languages.size > 0 && b.languages.size > 0) {
      let sharesLanguage = false;
      const [smaller, larger] = a.languages.size <= b.languages.size
        ? [a.languages, b.languages]
        : [b.languages, a.languages];
      for (const language of smaller) {
        if (larger.has(language)) {
          sharesLanguage = true;
          break;
        }
      }
      if (!sharesLanguage) return invalid('NO_COMMON_LANGUAGE');
    }

    if (!preloadedBlockLists.has(ticketA.userId) || !preloadedBlockLists.has(ticketB.userId)) {
      return invalid('BLOCK_LIST_UNAVAILABLE');
    }
    const blockedA = preloadedBlockLists.get(ticketA.userId);
    const blockedB = preloadedBlockLists.get(ticketB.userId);
    if (blockedA?.has(ticketB.userId) || blockedB?.has(ticketA.userId)) {
      return invalid('USER_BLOCKED');
    }

    const sharedInterests: string[] = [];
    const [smallerInterests, largerInterests] = a.interests.size <= b.interests.size
      ? [a.interests, b.interests]
      : [b.interests, a.interests];
    for (const interest of smallerInterests) {
      if (largerInterests.has(interest)) sharedInterests.push(interest);
    }

    const unionSize = a.interests.size + b.interests.size - sharedInterests.length;
    const interestScore = unionSize > 0
      ? 50 + Math.round((sharedInterests.length / unionSize) * 50)
      : 50;

    const now = Date.now();
    const waitA = Math.max(0, (now - a.queuedAt) / 1000);
    const waitB = Math.max(0, (now - b.queuedAt) / 1000);
    const waitBonus = Math.min(Math.floor(Math.max(waitA, waitB) / 10) * 2, 10);

    return {
      score: Math.min(interestScore + waitBonus, 100),
      isEligible: true,
      sharedInterests,
      reasons: ['MUTUAL_COMPATIBILITY_CONFIRMED'],
    };
  }

  /**
   * Evaluates mutual eligibility. The optional preloaded snapshot avoids a
   * database round-trip per candidate; without it, the block check fails closed.
   */
  async evaluateMatch(
    ticketA: MatchTicket,
    ticketB: MatchTicket,
    preloadedBlockLists?: ReadonlyMap<string, ReadonlySet<string>>
  ): Promise<MatchCandidateResult> {
    if (preloadedBlockLists) {
      return this.evaluateWithBlockLists(ticketA, ticketB, preloadedBlockLists);
    }

    if (!ticketA || !ticketB) return invalid();
    // Cheap validation before making a database request.
    if (ticketA.userId === ticketB.userId || ticketA.discordUserId === ticketB.discordUserId) {
      return invalid('SELF_MATCH');
    }

    const modeA = ticketA.mode || 'text';
    const modeB = ticketB.mode || 'text';
    if (modeA !== modeB) {
      return invalid('MODE_MISMATCH');
    }
    const blockLists = await this.preloadBlockLists([ticketA, ticketB]);
    return this.evaluateWithBlockLists(ticketA, ticketB, blockLists);
  }

  /**
   * Preload bidirectional block lists in bounded batches. A failed database
   * read rejects the cycle instead of accidentally allowing a blocked pair.
   */
  async preloadBlockLists(tickets: MatchTicket[]): Promise<Map<string, ReadonlySet<string>>> {
    const userIds = Array.from(new Set(tickets.map((ticket) => ticket.userId).filter(Boolean)));
    return db.getBlockedUserIdsForUsers(userIds);
  }

  /** Load each participating guild's cross-server policy once per cycle. */
  async preloadGuildSettings(tickets: MatchTicket[]): Promise<Map<string, Awaited<ReturnType<typeof db.getGuildSettings>>>> {
    const guildIds = Array.from(new Set(tickets
      .map((ticket) => ticket.guildId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)));
    const entries = await Promise.all(guildIds.map(async (guildId) =>
      [guildId, await db.getGuildSettings(guildId)] as const
    ));
    return new Map(entries);
  }

  /**
   * Choose uniformly at random from all mutually eligible candidates.
   * Reservoir sampling keeps selection fair without sorting or biasing toward
   * queue order, while retaining only one candidate in memory.
   */
  async findRandomMatch(
    ticket: MatchTicket,
    candidates: MatchTicket[],
    preloadedBlockLists?: ReadonlyMap<string, ReadonlySet<string>>,
    preloadedGuildSettings?: ReadonlyMap<string, Awaited<ReturnType<typeof db.getGuildSettings>>>,
    candidatesAreRandomized = false
  ): Promise<{ partner: MatchTicket; matchResult: MatchCandidateResult; index: number } | null> {
    const blockLists = preloadedBlockLists ?? await this.preloadBlockLists([ticket, ...candidates]);
    let guildSettings: ReadonlyMap<string, Awaited<ReturnType<typeof db.getGuildSettings>>> = preloadedGuildSettings ?? new Map();

    if (!preloadedGuildSettings) {
      // Compatibility path for direct callers outside a matchmaking cycle.
      const otherGuildIds = ticket.guildId
        ? Array.from(new Set(candidates
            .map((candidate) => candidate.guildId)
            .filter((id): id is string => typeof id === 'string' && id.length > 0 && id !== ticket.guildId)))
        : [];
      const guildIds = otherGuildIds.length > 0 ? [ticket.guildId!, ...otherGuildIds] : [];
      const settings = await Promise.all(guildIds.map(async (guildId) =>
        [guildId, await db.getGuildSettings(guildId)] as const
      ));
      guildSettings = new Map(settings);
    }

    let selected: { partner: MatchTicket; matchResult: MatchCandidateResult; index: number } | null = null;
    let eligibleCount = 0;

    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      if (candidate.userId === ticket.userId || candidate.discordUserId === ticket.discordUserId) continue;
      if (ticket.guildId !== candidate.guildId) {
        // A guild-scoped ticket must never be paired with an unattributed
        // ticket: without both guild IDs we cannot prove both servers permit
        // cross-server discovery. Two unattributed tickets remain compatible.
        if (!ticket.guildId || !candidate.guildId) continue;
        const sourceAllowsGlobal = guildSettings.get(ticket.guildId)?.crossServerEnabled !== false;
        const candidateAllowsGlobal = guildSettings.get(candidate.guildId)?.crossServerEnabled !== false;
        if (!sourceAllowsGlobal || !candidateAllowsGlobal) continue;
      }
      const result = this.evaluateWithBlockLists(ticket, candidate, blockLists);
      if (!result.isEligible) continue;

      if (candidatesAreRandomized) {
        // The manager shuffles the remaining queue once per cycle. The first
        // eligible candidate in that random order is uniformly selected and
        // avoids evaluating every compatible pair just to reservoir-sample.
        return { partner: candidate, matchResult: result, index };
      }

      eligibleCount += 1;
      if (Math.random() < 1 / eligibleCount) {
        selected = { partner: candidate, matchResult: result, index };
      }
    }
    return selected;
  }
}

export const matchmakingEngine = new MatchmakingEngine();
