/**
 * Prompt display and output management for user input
 * Handles clearing and restoring the prompt when printing messages
 */
class Prompt {
    static isActive = false;

    /**
     * Set whether the prompt is currently active
     * @param {boolean} active
     */
    static setActive(active) {
        Prompt.isActive = active;
    }

    /**
     * Show the command prompt
     */
    static show() {
        process.stdout.write('\n> ');
        Prompt.isActive = true;
    }

    /**
     * Clear the current line (removes the prompt)
     */
    static clear() {
        // Move cursor to beginning of line and clear it
        process.stdout.write('\r\x1b[K');
    }

    /**
     * Print a message, handling prompt clearing and restoration
     * @param {string} message - The message to print
     * @param {boolean} restorePrompt - Whether to restore the prompt after (default: true)
     */
    static print(message, restorePrompt = true) {
        if (Prompt.isActive) {
            Prompt.clear();
        }
        process.stdout.write(message + '\n');
        if (Prompt.isActive && restorePrompt) {
            process.stdout.write('> ');
        }
    }

    /**
     * Print a final message with a blank line before the prompt
     * @param {string} message - The message to print
     */
    static printFinal(message) {
        if (Prompt.isActive) {
            Prompt.clear();
        }
        process.stdout.write(message + '\n');
        if (Prompt.isActive) {
            Prompt.show();
        }
    }
}

module.exports = Prompt;
