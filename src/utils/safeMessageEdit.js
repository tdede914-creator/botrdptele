class SafeMessageEditor {
    constructor() {
        this.lastSentMessages = new Map(); // chatId_messageId -> {text, markup}
    }

    shouldUpdate(chatId, messageId, newText, newMarkup) {
        const key = `${chatId}_${messageId}`;
        const lastSent = this.lastSentMessages.get(key);
        
        if (!lastSent) {
            return true; // First time, always update
        }

        // Compare text
        if (lastSent.text !== newText) {
            return true;
        }

        // Compare markup using JSON comparison
        try {
            const lastMarkupStr = JSON.stringify(lastSent.markup, null, 0);
            const newMarkupStr = JSON.stringify(newMarkup, null, 0);
            if (lastMarkupStr !== newMarkupStr) {
                return true;
            }
        } catch (error) {
            // If JSON comparison fails, assume different
            return true;
        }

        return false; // No changes detected
    }

    async editMessage(bot, chatId, messageId, newText, options = {}) {
        const newMarkup = options.reply_markup || null;
        
        if (!this.shouldUpdate(chatId, messageId, newText, newMarkup)) {
            // No changes, skip edit to avoid Telegram error
            return { success: true, skipped: true };
        }

        const payload = {
            chat_id: chatId,
            message_id: messageId,
            // Default parse_mode to Markdown if caller didn't set it
            parse_mode: options.parse_mode || 'Markdown',
            ...options
        };

        try {
            // Some messages (e.g., QR photo deposit) don't have "text"; they have "caption".
            // Telegram will throw: "there is no text in the message to edit".
            // So we try caption-edit first, then fallback to text-edit.
            try {
                await bot.editMessageCaption(newText, payload);
            } catch (captionErr) {
                await bot.editMessageText(newText, payload);
            }

            // Store the successfully sent content
            const key = `${chatId}_${messageId}`;
            this.lastSentMessages.set(key, {
                text: newText,
                markup: newMarkup
            });

            return { success: true, skipped: false };
        } catch (error) {
            console.error('Error editing message:', error.message);

            // Some Telegram messages are photos/media without editable text.
            // If both caption and text edit fail, send a new message so the flow continues.
            try {
                const sendOptions = { ...options };
                delete sendOptions.chat_id;
                delete sendOptions.message_id;
                await bot.sendMessage(chatId, newText, sendOptions);

                const key = `${chatId}_${messageId}`;
                this.lastSentMessages.set(key, {
                    text: newText,
                    markup: newMarkup
                });

                return { success: true, skipped: false, fallbackSent: true };
            } catch (sendError) {
                console.error('Error sending fallback message:', sendError.message);
                return { success: false, error: error.message, fallbackError: sendError.message };
            }
        }
    }

    clearMessageCache(chatId, messageId) {
        const key = `${chatId}_${messageId}`;
        this.lastSentMessages.delete(key);
    }

    clearAllCache() {
        this.lastSentMessages.clear();
    }
}

// Create singleton instance
const safeMessageEditor = new SafeMessageEditor();

module.exports = safeMessageEditor;
