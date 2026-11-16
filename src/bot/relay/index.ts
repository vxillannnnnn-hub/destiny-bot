import { formatCustomEmojiText, resolveBotReactionEmoji } from '../custom-emojis.js';
import { Client, Message, AttachmentBuilder, EmbedBuilder } from 'discord.js';
import { sendCleanDmPanel } from '../dm-cleanup.js';
import { db } from '../../database/supabase.js';
import { stateStore } from '../../storage/state-store.js';
import { sanitizer } from '../../core/sanitizer.js';
import { embedService, COLORS } from '../embeds/index.js';
import { lockManager } from '../../storage/locks.js';
import { RoomSession, UserProfile } from '../../core/types.js';

export class MessageRelayService {
  /**
   * Process incoming Discord message from DM or designated room channel
   */
  async handleIncomingMessage(client: Client, message: Message, knownUser?: UserProfile, knownRoom?: RoomSession): Promise<boolean> {
    if (message.author.bot) return false;
    if (message.guild !== null) return false;

    const authorDiscordId = message.author.id;
    // The DM handler already loaded and validated this user's active room. Reuse
    // that snapshot instead of repeating the same Supabase reads for every message.
    const authorUser = knownUser || await db.getUserByDiscordId(authorDiscordId, true);
    if (!authorUser) return false;

    const activeRoomId = authorUser.activeRoomId ||
      (await stateStore.get(`user:active_room:${authorUser.id}`)) || undefined;
    if (!activeRoomId) return false;

    const room = knownRoom?.id === activeRoomId ? knownRoom : await db.getRoomById(activeRoomId);
    if (!room || room.status !== 'active') return false;
    if (authorUser.activeRoomId !== room.id) {
      console.warn('[Relay] Refusing message because the sender no longer points to this active room.');
      return false;
    }
    if (room.user1Id !== authorUser.id && room.user2Id !== authorUser.id) {
      console.warn('[Relay] Refusing message from a user who is not a room participant.');
      return false;
    }

    return await lockManager.withLock(`lock:room:${room.id}`, async () => {
      const [latestUser, latestRoom] = await Promise.all([
        db.getUserById(authorUser.id, true),
        // Relay only needs participant IDs/status; avoid getRoomById's two
        // additional participant-profile lookups on every incoming message.
        db.getRoomById(room.id, false),
      ]);
      if (
        !latestUser ||
        !latestRoom ||
        latestRoom.status !== 'active' ||
        latestUser.activeRoomId !== latestRoom.id ||
        (latestRoom.user1Id !== latestUser.id && latestRoom.user2Id !== latestUser.id)
      ) return false;

      const partnerId = latestRoom.user1Id === latestUser.id
        ? latestRoom.user2Id
        : latestRoom.user1Id;
      const partner = await db.getUserById(partnerId, true);
      if (!partner || latestUser.isBanned || partner.isBanned) {
        console.warn(`[Relay] Refusing message in room ${latestRoom.id}: a participant is missing or moderation-restricted.`);
        return false;
      }

      return this.deliverToRoom(client, message, latestUser, latestRoom, partner.discordUserId);
    });
  }

  private async deliverToRoom(
    client: Client,
    message: Message,
    authorUser: UserProfile,
    room: RoomSession,
    validatedRecipientDiscordId?: string
  ): Promise<boolean> {
    const rateLimit = await stateStore.checkRateLimit(`relay:${authorUser.id}`, 5, 3);
    if (!rateLimit.allowed) {
      await message.reply(formatCustomEmojiText('⚠️ Slow down! You are sending messages too quickly.'));
      return true;
    }

    const isUser1 = room.user1Id === authorUser.id;
    const senderPseudonym = isUser1 ? room.user1Pseudonym : room.user2Pseudonym;
    const senderAvatar = isUser1 ? room.user1Avatar : room.user2Avatar;
    let recipientDiscordId = validatedRecipientDiscordId || (isUser1 ? room.user2DiscordId : room.user1DiscordId);

    if (!recipientDiscordId) {
      const recipientUser = await db.getUserById(isUser1 ? room.user2Id : room.user1Id);
      if (recipientUser) recipientDiscordId = recipientUser.discordUserId;
    }

    if (!recipientDiscordId) {
      await message.reply(formatCustomEmojiText('⚠️ Could not locate recipient for this chat room.')).catch(() => {});
      return false;
    }

    // Keep Discord emoji markup intact so Unicode, animated and custom emojis render natively.
    const sanitized = sanitizer.sanitize(message.content);
    const rawAttachments = Array.from(message.attachments.values()).map((a) => ({
      url: a.url,
      name: a.name,
      size: a.size,
      contentType: a.contentType || undefined,
    }));
    const cleanAttachments = sanitizer.sanitizeAttachments(rawAttachments);

    // Stickers are a separate Discord message collection, not file attachments.
    // Relay supported static/animated sticker formats through Discord's own CDN.
    const stickerAttachments = Array.from(message.stickers.values()).flatMap((sticker) => {
      const extension = sticker.format === 4 ? 'gif'
        : sticker.format === 2 ? 'apng'
        : sticker.format === 1 ? 'png'
        : null; // Lottie stickers are JSON animations, not renderable image uploads.
      if (!extension) return [];
      return [{
        url: sticker.url,
        name: `sticker-${sticker.id}.${extension}`,
        size: 0,
        contentType: extension === 'gif' ? 'image/gif' : 'image/png',
      }];
    });
    const relayAttachments = [...cleanAttachments, ...stickerAttachments];

    if (!sanitized.sanitizedText && relayAttachments.length === 0) {
      await message.reply(
        message.stickers.size > 0
          ? formatCustomEmojiText('⚠️ This sticker format cannot be relayed yet. Please send a GIF, image, or supported sticker.')
          : formatCustomEmojiText('⚠️ Message cannot be empty or only contain disallowed content.')
      );
      return true;
    }

    try {
      const recipientUser = client.users.cache.get(recipientDiscordId)
        || await client.users.fetch(recipientDiscordId);

      const files = relayAttachments.map((attachment) =>
        new AttachmentBuilder(attachment.url, { name: attachment.name || 'attachment' })
      );

      // Deliver every anonymous chat message as a branded Discord embed.
      // Keep the pseudonym (never the real Discord identity) as the visible author.
      // Embed descriptions support the sanitized text and native Discord emoji markup;
      // attachments remain real files so images, GIFs, audio and documents still work.
      const relayEmbed = new EmbedBuilder()
        .setColor(COLORS.DESTINY_PURPLE)
        .setAuthor({ name: `${formatCustomEmojiText(senderAvatar)} ${senderPseudonym}` })
        .setDescription((sanitized.sanitizedText || '*Sent media*').slice(0, 4096))
        .setFooter({ text: 'Destiny • Anonymous chat' })
        .setTimestamp(message.createdAt);

      await recipientUser.send({
        embeds: [relayEmbed],
        files,
        allowedMentions: { parse: [] },
      });

      // These writes are independent: run message persistence and room activity
      // in parallel so their network latency does not accumulate per message.
      // The sender's last_active_at update remains part of saveMessage.
      const reactionTask = message.react(resolveBotReactionEmoji('✨')).catch(() => {});
      const [persistResult, activityResult] = await Promise.allSettled([
        db.saveMessage({
          roomId: room.id,
          senderUserId: authorUser.id,
          senderPseudonym,
          sanitizedContent: sanitized.sanitizedText,
          attachmentsMeta: relayAttachments,
          isPinned: false,
          flaggedForModeration: !sanitized.isClean,
          moderationReason: sanitized.violations.join(', ') || undefined,
        }),
        db.touchRoomActivity(room.id),
      ]);

      if (persistResult.status === 'rejected') {
        console.error('[Relay] Message was delivered but could not be persisted:', persistResult.reason);
        await message.reply(formatCustomEmojiText('⚠️ Your message was delivered, but chat history could not be saved. Please try again later.')).catch(() => {});
        await reactionTask;
        return true;
      }

      if (activityResult.status === 'rejected') {
        console.error('[Relay] Could not update room activity timestamp:', activityResult.reason);
      } else if (!activityResult.value) {
        console.warn(`[Relay] Room ${room.id} was no longer active after message persistence.`);
      }
      await reactionTask;
      return true;
    } catch (err: any) {
      console.warn(`[Relay] DM delivery failed to user ${recipientDiscordId}:`, err?.message);
      await message.reply(
        formatCustomEmojiText('⚠️ Delivery failed: Your chat partner’s direct messages are closed or restricted. They may need to enable DMs to continue chatting.')
      ).catch(() => {});
      return false;
    }
  }
}

export const messageRelayService = new MessageRelayService();
