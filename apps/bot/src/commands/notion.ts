import { ChannelType, CommandContext, CommandOptionType, ComponentType, SlashCreator } from 'slash-create';

import { processCooldown } from '../redis';
import GeneralCommand from '../slashCommand';
import { checkBan, checkRecordingPermission } from '../util';

const NOTION_DB_PATTERN = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

function normalizeNotionId(raw: string): string {
  return raw.replace(/-/g, '').replace(/^.*([0-9a-f]{32})$/i, '$1');
}

function isValidDatabaseId(id: string): boolean {
  return NOTION_DB_PATTERN.test(id.trim());
}

export default class NotionCommand extends GeneralCommand {
  constructor(creator: SlashCreator) {
    super(creator, {
      name: 'notion',
      description: 'Manage Notion database settings per voice channel.',
      deferEphemeral: true,
      dmPermission: false,
      options: [
        {
          type: CommandOptionType.SUB_COMMAND,
          name: 'view',
          description: 'View Notion database settings.',
          options: [
            {
              type: CommandOptionType.CHANNEL,
              name: 'channel',
              description: 'The channel to view.',
              channel_types: [ChannelType.GUILD_VOICE, ChannelType.GUILD_STAGE_VOICE]
            }
          ]
        },
        {
          type: CommandOptionType.SUB_COMMAND,
          name: 'set',
          description: 'Set a Notion database for a voice channel.',
          options: [
            {
              type: CommandOptionType.CHANNEL,
              name: 'channel',
              description: 'The voice channel to configure.',
              channel_types: [ChannelType.GUILD_VOICE, ChannelType.GUILD_STAGE_VOICE],
              required: true
            },
            {
              type: CommandOptionType.STRING,
              name: 'database-id',
              description: 'The Notion database ID (UUID from the database URL).',
              required: true
            }
          ]
        },
        {
          type: CommandOptionType.SUB_COMMAND,
          name: 'remove',
          description: 'Remove the Notion database setting for a voice channel.',
          options: [
            {
              type: CommandOptionType.CHANNEL,
              name: 'channel',
              description: 'The channel to remove the Notion setting from.',
              channel_types: [ChannelType.GUILD_VOICE, ChannelType.GUILD_STAGE_VOICE],
              required: true
            }
          ]
        }
      ]
    });

    this.filePath = __filename;
  }

  async run(ctx: CommandContext) {
    if (!ctx.guildID) return 'This command can only be used in a guild.';

    if (await checkBan(ctx.user.id))
      return {
        content: 'You are not allowed to use the bot at this time.',
        ephemeral: true
      };

    const userCooldown = await processCooldown(`command:${ctx.user.id}:${this.client?.bot?.user?.id}`, 5, 3);
    if (userCooldown !== true) {
      this.client.commands.logger.warn(
        `${ctx.user.username}#${ctx.user.discriminator} (${ctx.user.id}) tried to use the notion command, but was ratelimited.`
      );
      return {
        content: 'You are running commands too often! Try again in a few seconds.',
        ephemeral: true
      };
    }

    const guildData = await this.prisma.guild.findFirst({ where: { id: ctx.guildID } });
    const hasPermission = checkRecordingPermission(ctx.member!, guildData);
    if (!hasPermission)
      return {
        content: 'You need the `Manage Server` permission or have an access role to manage Notion settings.',
        ephemeral: true
      };

    switch (ctx.subcommands[0]) {
      case 'view': {
        const channelId = ctx.options.view?.channel as string | undefined;

        if (channelId) {
          const setting = await this.prisma.notionChannel.findUnique({ where: { channelId } });
          if (!setting)
            return {
              content: `<#${channelId}> has no Notion database configured.`,
              ephemeral: true
            };

          return {
            embeds: [
              {
                title: 'Notion Setting',
                description: `**Channel:** <#${channelId}>\n**Database ID:** \`${setting.databaseId}\``
              }
            ],
            ephemeral: true
          };
        }

        const settings = await this.prisma.notionChannel.findMany({ where: { guildId: ctx.guildID } });
        if (settings.length === 0)
          return {
            content: 'No Notion databases are configured for any channels.',
            ephemeral: true
          };

        return {
          embeds: [
            {
              title: 'Notion Database Settings',
              description: settings.map((s) => `<#${s.channelId}> → \`${s.databaseId}\``).join('\n')
            }
          ],
          ephemeral: true
        };
      }

      case 'set': {
        const channelId = ctx.options.set.channel as string;
        const rawId = (ctx.options.set['database-id'] as string).trim();

        if (!isValidDatabaseId(rawId))
          return {
            content: 'Invalid Notion database ID. Please provide the UUID found in the database URL.',
            ephemeral: true
          };

        const databaseId = normalizeNotionId(rawId);

        await this.prisma.notionChannel.upsert({
          where: { channelId },
          update: { databaseId, guildId: ctx.guildID },
          create: { channelId, guildId: ctx.guildID, databaseId }
        });

        return {
          content: `Notion database \`${databaseId}\` has been set for <#${channelId}>. Recordings in this channel will be uploaded automatically.`,
          ephemeral: true
        };
      }

      case 'remove': {
        const channelId = ctx.options.remove.channel as string;

        const existing = await this.prisma.notionChannel.findUnique({ where: { channelId } });
        if (!existing)
          return {
            content: `<#${channelId}> has no Notion database configured.`,
            ephemeral: true
          };

        await this.prisma.notionChannel.delete({ where: { channelId } });

        return {
          content: `Notion database setting removed for <#${channelId}>.`,
          ephemeral: true
        };
      }
    }

    return {
      content: 'Unknown sub-command.',
      ephemeral: true
    };
  }
}
