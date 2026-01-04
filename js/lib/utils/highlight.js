/**
 * ANSI color highlighting utilities
 */

/**
 * Highlight search term in text with ANSI color codes
 * @param {string} text - The text to highlight
 * @param {string} searchTerm - The search term to highlight
 * @returns {string} - Text with highlighted search term
 */
function highlightMatch(text, searchTerm) {
    if (!searchTerm) return text;
    
    // ANSI color codes
    const highlight = '\x1b[1m\x1b[33m'; // Bold + Yellow
    const reset = '\x1b[0m';
    
    // Case-insensitive replace, escape special regex characters
    const regex = new RegExp(`(${searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    return text.replace(regex, `${highlight}$1${reset}`);
}

module.exports = {
    highlightMatch
};
