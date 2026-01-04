/**
 * A simple progress bar utility for terminal output
 */
class ProgressBar {
    /**
     * Create a new progress bar
     * @param {number} total - Total bytes/units expected
     * @param {string} label - Label to show before the progress bar (default: 'Receiving')
     * @param {number} width - Width of the progress bar in characters (default: 30)
     */
    constructor(total, label = 'Receiving', width = 30) {
        this.total = total;
        this.label = label;
        this.width = width;
        this.current = 0;
        this.startTime = Date.now();
    }

    /**
     * Update the progress bar with the current value
     * @param {number} current - Current bytes/units received
     */
    update(current) {
        this.current = current;
        const percent = Math.min(100, Math.floor((current / this.total) * 100));
        const filled = Math.floor((current / this.total) * this.width);
        const empty = this.width - filled;
        
        const bar = '█'.repeat(filled) + '░'.repeat(empty);
        const bytesText = `${this.formatBytes(current)} / ${this.formatBytes(this.total)}`;
        
        // Use \r to return to start of line, overwriting previous output
        process.stdout.write(`\r${this.label}: [${bar}] ${percent}% ${bytesText}`);
    }

    /**
     * Format bytes to human-readable string
     * @param {number} bytes - Number of bytes
     * @returns {string} Formatted string
     */
    formatBytes(bytes) {
        if (bytes < 1024) {
            return `${bytes}B`;
        } else if (bytes < 1024 * 1024) {
            return `${(bytes / 1024).toFixed(1)}KB`;
        } else {
            return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
        }
    }

    /**
     * Complete the progress bar and move to next line
     */
    complete() {
        this.update(this.total);
        const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
        process.stdout.write(` (${elapsed}s)\n`);
    }

    /**
     * Clear the current line
     */
    clear() {
        process.stdout.write('\r' + ' '.repeat(80) + '\r');
    }
}

module.exports = ProgressBar;
