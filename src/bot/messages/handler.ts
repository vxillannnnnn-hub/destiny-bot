import { formatCustomEmojiText, resolveBotEmoji } from '../custom-emojis.js';
import { 
  Client, 
  Message, 
  ActionRowBuilder, 
  ButtonBuilder, 
  ButtonStyle, 
  MessageFlags,
  AttachmentBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder
} from 'discord.js';
import { db } from '../../database/supabase.js';
import { stateStore } from '../../storage/state-store.js';
import { revealService } from '../../core/moderation/reveal.js';
import { matchmakingManager } from '../../core/matchmaking/manager.js';
import { handleReputationCheck, isReputationRestriction } from '../../core/moderation/reputation.js';
import { embedService, COLORS } from '../embeds/index.js';
import { UserProfile } from '../../core/types.js';
import { buildProfileCard, createProfileActionRow, isProfileComplete } from '../profile-view.js';
import { refreshBotPresence } from '../presence-manager.js';
import { createRevealResultContainer, resolveRevealPair } from '../reveal-view.js';
import { sendCleanDmPanel } from '../dm-cleanup.js';
import { socialManager } from '../../core/social/manager.js';

/**
 * Safe message reply helper with Components V2:
 * Tries message.reply with IsComponentsV2 flag; if referencing fails,
 * gracefully falls back to sending directly in the channel/DM.
 */
async function safeV2Reply(message: Message, container: any, files?: any[]): Promise<Message | null> {
  const payload: any = {
    components: [container],
    flags: [MessageFlags.IsComponentsV2],
  };
  if (files && files.length > 0) {
    payload.files = files;
  }

  if (!message.guild) {
    try {
      return await sendCleanDmPanel(message.author, payload as any);
    } catch (err: any) {
      console.error('[Bot] Failed to send clean DM panel:', err?.message || err);
      return null;
    }
  }

  try {
    return await message.reply(payload as any);
  } catch (err: any) {
    try {
      return await (message.channel as any).send(payload);
    } catch (chErr: any) {
      console.error('[Bot] Failed to send V2 message to channel/DM:', chErr?.message || chErr);
      return null;
    }
  }
}

export class MessageCommandHandler {
  /**
   * Main entry point for processing text messages in guilds and DMs
   */
  async handleMessage(client: Client, message: Message): Promise<boolean> {
    if (message.author.bot) return false;

    const rawContent = message.content.trim();

    // =========================================================================
    // 1. DIRECT MESSAGES HANDLING (100% Native DM Operations in Components V2)
    // =========================================================================
    if (!message.guild) {
      return await this.handleDMMessage(client, message, rawContent);
    }

    // =========================================================================
    // 2. GUILD SERVER HANDLING (Zero Channel Lockouts, Full Privacy Redirect)
    // =========================================================================
    return await this.handleGuildMessage(client, message, rawContent);
  }

  /**
   * Complete In-DM Message & Command Processing (Components V2)
   */
  private async handleDMMessage(client: Client, message: Message, rawContent: string): Promise<boolean> {
    const authorId = message.author.id;
    // Always fetch fresh state in DMs so activeRoomId and queue status are never stale
    const user = await db.getUserByDiscordId(authorId, true);

    // Reputation (< 10) & Ban Enforcement (discord.gg/eclairs check)
    if (user && (user.reputationScore < 10 || user.isBanned)) {
      const repStatus = await handleReputationCheck(client, authorId);
      if (repStatus.isRestricted) {
        const isModerationBan = user.isBanned && !isReputationRestriction(user);
        const container = isModerationBan
          ? new ContainerBuilder()
              .setAccentColor(COLORS.DARK)
              .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                  formatCustomEmojiText('# ⛔ Account Restricted\\n\\nYour account is currently restricted by Destiny moderation. Please contact the moderators if you believe this is a mistake.')
                )
              )
          : embedService.createLowReputationRestrictedContainer();
        await safeV2Reply(message, container);
        return true;
      }
      if (repStatus.restored) {
        // User is in discord.gg/eclairs -> unbanned & reputation restored to 100%!
        const container = embedService.createReputationRestoredContainer();
        await safeV2Reply(message, container);
        return true;
      }
    }

    let activeRoomId = user?.activeRoomId;
    if (!activeRoomId && user) {
      activeRoomId = (await stateStore.get(`user:active_room:${user.id}`)) || undefined;
    }

    // -------------------------------------------------------------
    // STATE A: USER IN ACTIVE ROOM SESSION
    // -------------------------------------------------------------
    if (activeRoomId && user) {
      const activeRoom = await db.getRoomById(activeRoomId);
      if (activeRoom && activeRoom.status === 'active') {
        // Subcase A1: Leave / End room command
        if (/^\s*(?:destiny\s+leave|leave|exit|stop|end)\s*$/i.test(rawContent)) {
          await db.endRoom(activeRoom.id, 'user_left');

          // The conversation just ended — reflect it in the rotating presence.
          refreshBotPresence();

          const guildId = await stateStore.get(`room:${activeRoom.id}:guild_id`);
          if (guildId) {
            const { dispatchPairedLogEvent } = await import('../paired-logs.js');
            dispatchPairedLogEvent(client, guildId, 'Unmatch', {
              discordUserId1: activeRoom.user1DiscordId,
              discordUserId2: activeRoom.user2DiscordId,
              pseudonym1: activeRoom.user1Pseudonym,
              pseudonym2: activeRoom.user2Pseudonym,
            }).catch(() => {});
          }

          // Notify partner in DM and provide post-session wrap-up card
          const isUser1 = activeRoom.user1Id === user.id;
          const partnerDiscordId = isUser1 ? activeRoom.user2DiscordId : activeRoom.user1DiscordId;
          const partnerUserId = isUser1 ? activeRoom.user2Id : activeRoom.user1Id;
          const partnerDestinyId = isUser1 ? (activeRoom.user2Pseudonym || 'destiny#????') : (activeRoom.user1Pseudonym || 'destiny#????');
          const myDestinyId = isUser1 ? (activeRoom.user1Pseudonym || user.destinyId) : (activeRoom.user2Pseudonym || user.destinyId);

          if (partnerDiscordId) {
            client.users.fetch(partnerDiscordId).then((partner) => {
              const partnerWrapUp = socialManager.createSessionWrapUpContainer(myDestinyId, user.id, activeRoom.id);
              sendCleanDmPanel(partner, { components: [partnerWrapUp], flags: [MessageFlags.IsComponentsV2] }).catch(() => {});
            }).catch(() => {});
          }

          const myWrapUp = socialManager.createSessionWrapUpContainer(partnerDestinyId, partnerUserId, activeRoom.id);
          await safeV2Reply(message, myWrapUp);
          return true;
        }

        // Subcase A2: Report partner command while in room
        if (/^\s*(?:destiny\s+report|report)\s*$/i.test(rawContent)) {
          const isUser1 = activeRoom.user1Id === user.id;
          const partnerPseudonym = isUser1 ? activeRoom.user2Pseudonym : activeRoom.user1Pseudonym;
          const container = embedService.createReportMenuContainer(activeRoom.id, partnerPseudonym);
          await safeV2Reply(message, container);
          return true;
        }

        // Subcase A3: Request mutual reveal command
        if (/^\s*(?:destiny\s+reveal|reveal)\s*$/i.test(rawContent)) {
          const consentResult = await revealService.submitConsent(
            activeRoom.id,
            user.id,
            ['discordTag', 'destinyId', 'age', 'gender', 'interests'],
            'narrow'
          );

          const isUser1 = activeRoom.user1Id === user.id;
          const partnerDiscordId = isUser1 ? activeRoom.user2DiscordId : activeRoom.user1DiscordId;

          if (consentResult.completed) {
            // Partner had already consented — resolve the reveal immediately.
            const { mine, partner } = resolveRevealPair(activeRoom, user.id, consentResult);
            await safeV2Reply(message, createRevealResultContainer(partner, consentResult.agreedFields));

            const guildId = await stateStore.get(`room:${activeRoom.id}:guild_id`);
            if (guildId) {
              const { dispatchPairedLogEvent } = await import('../paired-logs.js');
              dispatchPairedLogEvent(client, guildId, 'Reveal', {
                discordUserId1: activeRoom.user1DiscordId,
                discordUserId2: activeRoom.user2DiscordId,
                pseudonym1: activeRoom.user1Pseudonym,
                pseudonym2: activeRoom.user2Pseudonym,
              }).catch(() => {});
            }

            if (partnerDiscordId) {
              const partnerUser = await client.users.fetch(partnerDiscordId).catch(() => null);
              if (partnerUser) {
                await sendCleanDmPanel(partnerUser, {
                  components: [createRevealResultContainer(mine, consentResult.agreedFields)],
                  flags: [MessageFlags.IsComponentsV2],
                }).catch(() => {});
              }
            }
            return true;
          }

          const waitingContainer = embedService.createRevealWaitingContainer();
          await safeV2Reply(message, waitingContainer);

          const myPseudonym = isUser1 ? activeRoom.user1Pseudonym : activeRoom.user2Pseudonym;
          const myAvatar = isUser1 ? activeRoom.user1Avatar : activeRoom.user2Avatar;

          if (partnerDiscordId) {
            const partnerUser = await client.users.fetch(partnerDiscordId).catch(() => null);
            if (partnerUser) {
              const promptContainer = embedService.createRevealPromptPartnerContainer(myAvatar, myPseudonym);
              await sendCleanDmPanel(partnerUser, {
                components: [promptContainer],
                flags: [MessageFlags.IsComponentsV2],
              }).catch(() => {});
            }
          }
          return true;
        }

        // Subcase A3: Profile card while chatting
        if (/^\s*(?:destiny\s+profile|profile|my\s+profile|card|my\s+card|destiny\s+card)\s*$/i.test(rawContent)) {
          return await this.handleProfile(message, user);
        }


        // Subcase A3: Verification while chatting
        if (/^\s*(?:destiny\s+verify|verify)\s*$/i.test(rawContent)) {
          if (!isProfileComplete(user)) {
            const container = embedService.createProfileRequiredContainer();
            await safeV2Reply(message, container);
          } else if (user.genderVerified) {
            const container = embedService.createAlreadyVerifiedContainer(user);
            await safeV2Reply(message, container);
          } else if (user.genderVerificationStatus === 'pending') {
            const container = embedService.createVerificationPendingContainer();
            await safeV2Reply(message, container);
          } else {
            const container = embedService.createVerificationPromptContainer(user);
            await safeV2Reply(message, container);
          }
          return true;
        }

        // Subcase A3: Menu / Help command while in room
        if (/^\s*(?:destiny(?:\s+(?:menu|help|info|status))?|start|match)\s*$/i.test(rawContent)) {
          const container = embedService.createActiveRoomPromptContainer(activeRoom.roomCode);
          await safeV2Reply(message, container);
          return true;
        }

        // Subcase A4: Normal chat text -> immediately relay message to partner!
        const { messageRelayService } = await import('../relay/index.js');
        return await messageRelayService.handleIncomingMessage(client, message, user, activeRoom);
      }
    }

    // -------------------------------------------------------------
    // STATE B: USER IN MATCHMAKING QUEUE
    // -------------------------------------------------------------
    const isQueued = user ? await matchmakingManager.isQueued(user.id) : false;
    if (user && isQueued) {
      // Subcase B1: Cancel search command
      if (/^\s*(?:destiny\s+cancel|cancel|stop)\s*$/i.test(rawContent)) {
        await matchmakingManager.leaveQueue(user.id);
        const authorDisplayName = message.author.displayName || message.author.username;
        const container = embedService.createMainMenuContainer(authorDisplayName, user, true);
        await safeV2Reply(message, container);
        return true;
      }

      // Subcase B2: Any other message while queued -> show searching status with Cancel button
      const container = embedService.createSearchingContainer(user);
      await safeV2Reply(message, container);
      return true;
    }

    // -------------------------------------------------------------
    // STATE C: IDLE USER (Not in room, Not in queue)
    // -------------------------------------------------------------
    // Audio / Voice Note Detection: If user sends an audio note or voice message in DM while not in room
    const audioAttachment = message.attachments.find((att) => {
      const ct = att.contentType?.toLowerCase() || '';
      const name = att.name?.toLowerCase() || '';
      return (
        ct.startsWith('audio/') ||
        name.endsWith('.ogg') ||
        name.endsWith('.mp3') ||
        name.endsWith('.wav') ||
        name.endsWith('.m4a') ||
        name.endsWith('.aac') ||
        name.endsWith('.opus') ||
        Boolean(message.flags && message.flags.has(MessageFlags.IsVoiceMessage))
      );
    });

    if (audioAttachment && user) {
      if (user.genderVerified) {
        const container = embedService.createAlreadyVerifiedContainer(user);
        await safeV2Reply(message, container);
        return true;
      }

      // Automatically capture voice note as gender verification submission.
      // Do not tell users/staff that a request was submitted when it was rejected
      // as incomplete, already pending, or already verified.
      const { verificationService } = await import('../../core/moderation/verification.js');
      const submission = await verificationService.submitVerification(user.id, audioAttachment.url);
      if (!submission.success) {
        await message.reply({ content: `${formatCustomEmojiText("⚠️")} ${submission.message}` }).catch(() => {});
        return true;
      }

      const updatedUser = await db.getUserById(user.id, true);
      const { embed, components } = embedService.createVoiceNoteReceivedEmbed(audioAttachment.url, updatedUser || user);
      
      const filename = audioAttachment.name || (audioAttachment.contentType?.includes('wav') ? 'voice_note.wav' : audioAttachment.contentType?.includes('mp3') ? 'voice_note.mp3' : 'voice_note.ogg');
      const attachment = new AttachmentBuilder(audioAttachment.url, { name: filename });
      await message.reply({
        embeds: [embed],
        components,
        files: [attachment]
      });

      // Post alert to staff moderation channel
      try {
        const { postStaffVerificationAlert } = await import('../interactions/handler.js');
        await postStaffVerificationAlert(client, updatedUser || user, audioAttachment.url);
      } catch (err: any) {
        console.warn('[Verification] Failed to notify staff channel:', err?.message);
      }

      return true;
    }

    // Subcase C0: Profile card command ("profile", "destiny profile", "card", "my profile", "id")
    if (/^\s*(?:destiny\s+profile|profile|my\s+profile|card|my\s+card|destiny\s+card|id)\s*$/i.test(rawContent)) {
      return await this.handleProfile(message, user);
    }

    // Subcase C1: Start matchmaking command ("start", "destiny start")
    if (/^\s*(?:destiny\s+start|start)\s*$/i.test(rawContent)) {
      return await this.handleStart(message, user);
    }


    // Subcase C4: Report command after chatting ("report", "destiny report")
    if (/^\s*(?:destiny\s+report|report)\s*$/i.test(rawContent)) {
      if (user) {
        let lastRoomId = await stateStore.get(`user:last_room:${user.id}`);
        let lastRoom = lastRoomId ? await db.getRoomById(lastRoomId) : null;
        if (!lastRoom) {
          lastRoom = await db.getLastRoomForUser(user.id);
        }
        if (lastRoom) {
          const isUser1 = lastRoom.user1Id === user.id;
          const partnerPseudonym = isUser1 ? lastRoom.user2Pseudonym : lastRoom.user1Pseudonym;
          const container = embedService.createReportMenuContainer(lastRoom.id, partnerPseudonym);
          await safeV2Reply(message, container);
          return true;
        }
      }

      const noReportContainer = new ContainerBuilder()
        .setAccentColor(COLORS.DARK)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            formatCustomEmojiText('# ℹ️ No Chat Session to Report\n\nYou do not have an active or recent chat session to report. Reports can only be made after chatting with an anonymous partner.')
          )
        )
        .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
        .addActionRowComponents(
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId('destiny_btn_start')
              .setLabel('Start Match')
              .setEmoji(resolveBotEmoji('✨'))
              .setStyle(ButtonStyle.Success)
          )
        );
      await safeV2Reply(message, noReportContainer);
      return true;
    }

    // Subcase C5: Identity & Gender verification command ("verify", "destiny verify")
    if (/^\s*(?:destiny\s+verify|verify)\s*$/i.test(rawContent)) {
      if (!user || user.age < 18 || !user.gender || user.gender === 'prefer_not_to_say') {
        const container = embedService.createProfileRequiredContainer();
        await safeV2Reply(message, container);
        return true;
      }

      if (user.genderVerified) {
        const container = embedService.createAlreadyVerifiedContainer(user);
        await safeV2Reply(message, container);
        return true;
      }

      if (user.genderVerificationStatus === 'pending') {
        const container = embedService.createVerificationPendingContainer();
        await safeV2Reply(message, container);
        return true;
      }

      const container = embedService.createVerificationPromptContainer(user);
      await safeV2Reply(message, container);
      return true;
    }

    // Subcase C6: Any message in DM ("destiny", "menu", "help", "hi", "hello", etc.)
    return await this.handleMainMenu(message, user);
  }

  /**
   * In-Guild Server Handling (Admin Channel Setup, Dedicated Channel Routing & Privacy Redirect)
   */
  private async handleGuildMessage(client: Client, message: Message, rawContent: string): Promise<boolean> {
    if (!message.guild) return false;

    const trimmed = rawContent.trim();
    const botMention = `<@${client.user?.id}>`;
    const botNickMention = `<@!${client.user?.id}>`;
    const isBotMentioned = trimmed.startsWith(botMention) || trimmed.startsWith(botNickMention);
    const isSetupCmd = /^\s*(?:(?:destiny\s+)?setup|!setup)\s*$/i.test(trimmed) || (isBotMentioned && /\bsetup\b/i.test(trimmed));

    // 1. Setup Command ("setup", "destiny setup", "!setup", "@Destiny setup")
    if (isSetupCmd) {
      const { isGuildAdmin } = await import('../interactions/handler.js');
      if (!isGuildAdmin(message)) {
        const warningContainer = new ContainerBuilder()
          .setAccentColor(COLORS.DANGER)
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(formatCustomEmojiText('⚠️ Only server administrators with **Manage Server** or **Administrator** permissions can configure Destiny.'))
          );
        const reply = await message.reply({
          components: [warningContainer],
          flags: [MessageFlags.IsComponentsV2]
        }).catch(() => null);
        if (reply) {
          setTimeout(() => reply.delete().catch(() => {}), 6000).unref();
        }
        return true;
      }

      const settings = await db.getGuildSettings(message.guild.id, true);
      const setupContainer = embedService.createServerSetupContainer(message.guild, settings, message.channel.id);
      await message.reply({
        components: [setupContainer],
        flags: [MessageFlags.IsComponentsV2]
      }).catch(() => {});
      return true;
    }

    // 2. Check for Destiny invocation ('destiny', '!destiny', 'start', 'match', or bot mention)
    const isDestinyInvoked = /^\s*(?:destiny\b|!destiny\b|start\b|match\b)/i.test(trimmed) || isBotMentioned;
    if (!isDestinyInvoked) {
      return false;
    }

    // 3. Admin settings check ('destiny settings' or 'destiny admin')
    const { isGuildAdmin } = await import('../interactions/handler.js');
    if (isGuildAdmin(message) && /^\s*(?:destiny\s+settings?|destiny\s+admin)\s*$/i.test(trimmed)) {
      const settings = await db.getGuildSettings(message.guild.id);
      const setupContainer = embedService.createServerSetupContainer(message.guild, settings, message.channel.id);
      await message.reply({
        components: [setupContainer],
        flags: [MessageFlags.IsComponentsV2]
      }).catch(() => {});
      return true;
    }

    // 4. STRICT DM-ONLY ENFORCEMENT:
    // Destiny never runs inside server channels to guarantee complete user privacy and anonymity.
    // When someone types 'destiny' in any server channel, immediately deliver their Destiny
    // console directly to their private DMs and show a self-deleting notice in the channel.
    try {
      const user = await db.getUserByDiscordId(message.author.id, true);
      const profileComplete = isProfileComplete(user);

      const authorDisplayName = message.author.displayName || message.author.username;
      const menuContainer = embedService.createMainMenuContainer(authorDisplayName, user, profileComplete);

      await sendCleanDmPanel(message.author, {
        components: [menuContainer],
        flags: [MessageFlags.IsComponentsV2]
      });

      // Ephemeral-style self-deleting notification in the server channel
      const noticeContainer = new ContainerBuilder()
        .setAccentColor(COLORS.DESTINY_PURPLE)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            formatCustomEmojiText(`🔒 **Destiny operates 100% privately in Direct Messages.**\n\n`) +
            `Hey <@${message.author.id}>, I've sent your Destiny console to your **Direct Messages**! ${formatCustomEmojiText("👉")} **Check your DMs** to get started privately.`
          )
        );

      const reply = await message.reply({
        components: [noticeContainer],
        flags: [MessageFlags.IsComponentsV2]
      }).catch(() => null);

      if (reply) {
        setTimeout(() => reply.delete().catch(() => {}), 6000).unref();
      }
    } catch (dmErr: any) {
      // User has Direct Messages disabled in their server privacy settings
      const failContainer = new ContainerBuilder()
        .setAccentColor(COLORS.DANGER)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `${formatCustomEmojiText("⚠️")} **<@${message.author.id}>, Destiny works exclusively in DMs for complete anonymity!**\n\n` +
            `I was unable to send you a direct message. Please enable **"Allow direct messages from server members"** in your Discord Privacy Settings and try typing \`destiny\` again.`
          )
        );

      const reply = await message.reply({
        components: [failContainer],
        flags: [MessageFlags.IsComponentsV2]
      }).catch(() => null);

      if (reply) {
        setTimeout(() => reply.delete().catch(() => {}), 8000).unref();
      }
    }

    return true;
  }

  /**
   * Main Interactive Button Menu for `destiny` (Components V2)
   */
  async handleMainMenu(message: Message, existingUser?: UserProfile | null): Promise<boolean> {
    const user = existingUser !== undefined ? existingUser : await db.getUserByDiscordId(message.author.id);
    const profileComplete = isProfileComplete(user);

    const authorDisplayName = (message.channel as any).recipient?.displayName || 
                              message.author.displayName || 
                              message.author.username;

    const container = embedService.createMainMenuContainer(authorDisplayName, user, profileComplete);
    await safeV2Reply(message, container);
    return true;
  }

  /**
   * Handle Matchmaking Start in DM ("start", "destiny start") (Components V2)
   */
  async handleStart(message: Message, existingUser?: UserProfile | null): Promise<boolean> {
    const user = existingUser !== undefined ? existingUser : await db.getUserByDiscordId(message.author.id);
    const profileComplete = isProfileComplete(user);

    // Strict profile enforcement: Must create profile first!
    if (!user || !profileComplete) {
      const container = embedService.createProfileRequiredContainer();
      await safeV2Reply(message, container);
      return true;
    }

    // Safety checks: Suspended account
    if (user.isBanned) {
      const container = embedService.createAccountRestrictedContainer(user.banReason);
      await safeV2Reply(message, container);
      return true;
    }

    // Active room check
    let activeRoomId = user.activeRoomId;
    if (!activeRoomId) {
      activeRoomId = (await stateStore.get(`user:active_room:${user.id}`)) || undefined;
    }
    if (activeRoomId) {
      const room = await db.getRoomById(activeRoomId);
      if (room && room.status === 'active') {
        const container = embedService.createActiveRoomPromptContainer(room.roomCode);
        await safeV2Reply(message, container);
        return true;
      } else {
        const cleared = await db.clearActiveRoom(user.id, activeRoomId);
        if (!cleared) return true;
        user.activeRoomId = null;
      }
    }

    // Already in queue check
    const isQueued = await matchmakingManager.isQueued(user.id);
    if (isQueued) {
      const container = embedService.createAlreadyQueuedContainer();
      await safeV2Reply(message, container);
      return true;
    }

    const queueRes = await matchmakingManager.joinQueue(user, message.guildId || undefined);
    if (!queueRes.success) {
      await message.reply({ content: `${formatCustomEmojiText("⚠️")} ${queueRes.message}` }).catch(() => {});
      return true;
    }

    matchmakingManager.processMatchCycle().catch(() => {});
    await safeV2Reply(message, embedService.createSearchingContainer(user));
    return true;
  }

  /**
   * Handle Profile Command ("profile", "destiny profile", "card", "my profile")
   * Renders the live profile card attachment with real-time stats.
   */
  async handleProfile(message: Message, existingUser?: UserProfile | null): Promise<boolean> {
    const user = existingUser !== undefined ? existingUser : await db.getUserByDiscordId(message.author.id);

    if (!user || !isProfileComplete(user)) {
      const container = embedService.createProfileRequiredContainer();
      await safeV2Reply(message, container);
      return true;
    }

    const { attachment } = await buildProfileCard(user, message.author, message.member);

    await message.reply({
      content: formatCustomEmojiText('🪐 **Your Destiny Profile** — update anything anytime with `/application`.'),
      files: [attachment],
      components: [createProfileActionRow()],
    });
    return true;
  }
}

export const messageCommandHandler = new MessageCommandHandler();
