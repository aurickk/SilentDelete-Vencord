import { addMessagePopoverButton as addButton, removeMessagePopoverButton as removeButton } from "@api/MessagePopover";
import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { ApplicationCommandInputType, ApplicationCommandOptionType, sendBotMessage } from "@api/Commands";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { ChannelStore, Constants, Menu, RestAPI, UserStore } from "@webpack/common";

const settings = definePluginSettings({
    replacementText: {
        type: OptionType.STRING,
        description: "Text to replace the message with before deletion",
        default: "** **"
    },
    deleteDelay: {
        type: OptionType.NUMBER,
        description: "Delay in milliseconds before deleting the replacement message (recommended: 100-500)",
        default: 200
    },
    suppressNotifications: {
        type: OptionType.BOOLEAN,
        description: "Suppress notifications when replacing the message (prevents pinging mentioned users)",
        default: true
    },
    deleteOriginal: {
        type: OptionType.BOOLEAN,
        description: "Delete the original message from server. If disabled, the original message will reappear on client restart.",
        default: true
    },
    purgeInterval: {
        type: OptionType.NUMBER,
        description: "Delay in milliseconds between each message deletion during /silentpurge (recommended: 500-1000 to avoid rate limits)",
        default: 500
    },
    accentColor: {
        type: OptionType.STRING,
        description: "Hex color code for the Silent Delete icon and menu text (e.g. #ed4245)",
        default: "#ed4245"
    }
});

const SilentDeleteIcon = () => {
    const color = settings.store.accentColor || "#ed4245";
    return <svg width="18" height="18" viewBox="0 0 24 24" fill={color}>
        <path d="M15 3.999V2H9V3.999H3V5.999H21V3.999H15Z" />
        <path d="M5 6.99902V18.999C5 20.101 5.897 20.999 7 20.999H17C18.103 20.999 19 20.101 19 18.999V6.99902H5ZM11 17H9V11H11V17ZM15 17H13V11H15V17Z" />
    </svg>;
};

function messageSendWrapper(content: string, nonce: string, channelId: string, suppressNotifications = false) {
    return RestAPI.post({
        url: Constants.Endpoints.MESSAGES(channelId),
        body: {
            content: content,
            flags: suppressNotifications ? 4096 : 0,
            mobile_network_type: "unknown",
            nonce: nonce,
            tts: false,
        }
    });
}

function messageDeleteWrapper(channelId: string, messageId: string) {
    return RestAPI.del({
        url: Constants.Endpoints.MESSAGE(channelId, messageId)
    });
}

async function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function silentDeleteMessage(channelId: string, messageId: string): Promise<boolean> {
    try {
        const replacementText = settings.store.replacementText || "** **";
        const deleteDelay = settings.store.deleteDelay || 200;
        const suppressNotifications = settings.store.suppressNotifications ?? true;
        const deleteOriginal = settings.store.deleteOriginal ?? true;

        const response = await messageSendWrapper(replacementText, messageId, channelId, suppressNotifications);
        const newMessageId = response.body.id;
        
        await sleep(deleteDelay);
        
        await messageDeleteWrapper(channelId, newMessageId);
        
        if (deleteOriginal) {
            await sleep(100);
            await messageDeleteWrapper(channelId, messageId);
        }
        
        return true;
    } catch (error) {
        console.error("[SilentDelete] Error during silent delete:", error);
        return false;
    }
}

const messageContextMenuPatch: NavContextMenuPatchCallback = (children, { message }) => {
    if (!message) return;
    
    const isMessageOwner = message.author.id === UserStore.getCurrentUser().id;
    if (!isMessageOwner) return;
    
    const isDeleted = message.deleted === true;
    
    // Add SilentDelete History option for deleted messages
    if (isDeleted) {
        const handleSilentDeleteHistory = async () => {
            try {
                const channelId = message.channel_id;
                const deletedMessageId = message.id;
                const replacementText = settings.store.replacementText || "** **";
                const deleteDelay = settings.store.deleteDelay || 200;
                const suppressNotifications = settings.store.suppressNotifications ?? true;

                const response = await messageSendWrapper(replacementText, deletedMessageId, channelId, suppressNotifications);
                const newMessageId = response.body.id;
                
                await sleep(deleteDelay);
                
                await messageDeleteWrapper(channelId, newMessageId);
                
                console.log("[SilentDelete] Successfully cleared message from logger history");
            } catch (error) {
                console.error("[SilentDelete] Error during silent delete history:", error);
            }
        };

        // Find the group where delete-related items are and add our option
        const group = findGroupChildrenByChildId("remove-message-history", children) ?? children;
        
        const accentColor = settings.store.accentColor || "#ed4245";
        group.push(
            <Menu.MenuItem
                id="silent-delete-history"
                label={<span style={{ color: accentColor }}>Silent Delete History</span>}
                action={handleSilentDeleteHistory}
                icon={SilentDeleteIcon}
            />
        );
    }
};

export default definePlugin({
    name: "SilentDelete",
    description: "\"Silently\" deletes a message. Bypass message loggers by replacing the message with a placeholder.",
    authors: [
        { name: "Aurick", id: 1348025017233047634n },
        { name: "appleflyer", id: 1209096766075703368n }
    ],
    dependencies: ["MessagePopoverAPI", "CommandsAPI"],
    
    contextMenus: {
        "message": messageContextMenuPatch
    },
    
    commands: [
        {
            name: "silentpurge",
            description: "Silently delete your recent messages in this channel",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                {
                    name: "count",
                    description: "Number of your messages to silently delete (1-100)",
                    type: ApplicationCommandOptionType.INTEGER,
                    required: true,
                    minValue: 1,
                    maxValue: 100
                }
            ],
            execute: async (opts, ctx) => {
                const count = opts.find(o => o.name === "count")?.value as number;
                const channelId = ctx.channel.id;
                const currentUserId = UserStore.getCurrentUser().id;
                
                if (!count || count < 1) {
                    return;
                }

                try {
                    // Fetch messages directly from Discord API
                    const userMessages: any[] = [];
                    let lastMessageId: string | undefined;
                    
                    // Keep fetching until we have enough of our own messages
                    while (userMessages.length < count) {
                        const response = await RestAPI.get({
                            url: Constants.Endpoints.MESSAGES(channelId),
                            query: {
                                limit: 100,
                                ...(lastMessageId && { before: lastMessageId })
                            }
                        });
                        
                        const messages = response.body;
                        
                        if (!messages || messages.length === 0) {
                            break; // No more messages to fetch
                        }
                        
                        // Filter to only our own messages
                        for (const msg of messages) {
                            if (msg.author?.id === currentUserId) {
                                userMessages.push(msg);
                                if (userMessages.length >= count) {
                                    break;
                                }
                            }
                        }
                        
                        // Set the last message ID for pagination
                        lastMessageId = messages[messages.length - 1].id;
                        
                        // If we got less than 100 messages, we've reached the end
                        if (messages.length < 100) {
                            break;
                        }
                        
                        // Small delay to avoid rate limiting during fetch
                        await sleep(100);
                    }

                    if (userMessages.length === 0) {
                        return;
                    }

                    let successCount = 0;
                    const purgeInterval = settings.store.purgeInterval || 500;

                    for (let i = 0; i < userMessages.length; i++) {
                        const msg = userMessages[i];
                        const success = await silentDeleteMessage(channelId, msg.id);
                        if (success) {
                            successCount++;
                        }
                        // Add delay between deletions to avoid rate limiting (skip delay after last message)
                        if (i < userMessages.length - 1) {
                            await sleep(purgeInterval);
                        }
                    }

                    sendBotMessage(channelId, { content: `Successfully silently deleted ${successCount} message(s).` });
                } catch (error) {
                    console.error("[SilentDelete] Error during silent purge:", error);
                }
            }
        }
    ],
    
    settings,
    
    start() {
        // Original Silent Delete popover button (for non-deleted messages)
        addButton("SilentDelete", msg => {
            const isMessageOwner = msg.author.id === UserStore.getCurrentUser().id;
            const isDeleted = msg.deleted === true;
            
            if (!isMessageOwner || isDeleted) return null;

            const handleClick = async () => {
                try {
                    const channelId = msg.channel_id;
                    const originalMessageId = msg.id;
                    const replacementText = settings.store.replacementText || "** **";
                    const deleteDelay = settings.store.deleteDelay || 200;
                    const suppressNotifications = settings.store.suppressNotifications ?? true;
                    const deleteOriginal = settings.store.deleteOriginal ?? true;

                    const response = await messageSendWrapper(replacementText, originalMessageId, channelId, suppressNotifications);
                    const newMessageId = response.body.id;
                    
                    await sleep(deleteDelay);
                    
                    await messageDeleteWrapper(channelId, newMessageId);
                    
                    if (deleteOriginal) {
                        await sleep(100);
                        await messageDeleteWrapper(channelId, originalMessageId);
                    }
                } catch (error) {
                    console.error("[SilentDelete] Error during silent delete:", error);
                }
            };
            
            return {
                label: "Silent Delete",
                icon: SilentDeleteIcon,
                message: msg,
                channel: ChannelStore.getChannel(msg.channel_id),
                onClick: handleClick,
                dangerous: true
            };
        });
    },

    stop() {
        removeButton("SilentDelete");
    }
});
