const path = require('path');

/**
 * Parse metadata from filename
 * Supports patterns like:
 * - Name (Year)(Author).ext
 * - Name (Year)(Author)[Description].ext
 * - Name (-)(Author).ext (dash means no year)
 */
class FileParser {
    /**
     * Parse metadata from filename
     * @param {string} filename - Name of the file
     * @returns {Object} - {name: string, year: string, author: string, description: string}
     */
    static parseFilename(filename) {
        const nameWithoutExt = path.basename(filename, path.extname(filename));

        const result = {
            name: '',
            year: '',
            author: '',
            description: ''
        };

        // Pattern: Name (Year)(Author)(Description)[Description]...
        // Example: Flipper Slipper (1983)(Spectravideo).bin
        // Example: Smurf Rescue in Gargamel's Castle (1983)(Coleco)[h Buggy Software][CLOAD + RUN].cas
        // Example: Joystick Nr 01 (1985)(SAGA & Joystick)(Sw).cas
        // Example: Game (19xx)(Author).cas - year unknown in 1900s
        // Example: Game (-)(Author).cas - no year information (treated as empty)
        // Example: SVI328_MSX.ROM

        let workingString = nameWithoutExt;
        const descriptions = [];

        // Extract all square brackets [Description]
        const squareBracketMatches = workingString.matchAll(/\[([^\]]+)\]/g);
        for (const match of squareBracketMatches) {
            const desc = match[1].trim();
            if (desc !== '-') {
                descriptions.push(desc);
            }
        }
        // Remove square brackets from working string
        workingString = workingString.replace(/\[[^\]]+\]/g, '').trim();

        // Extract all parentheses (including year, author, and descriptions)
        const parenMatches = [...workingString.matchAll(/\(([^)]+)\)/g)];
        const parenContents = parenMatches.map(m => m[1].trim());

        // Remove all parentheses to get the name
        const name = workingString.replace(/\([^)]+\)/g, '').replace(/_/g, ' ').trim();
        result.name = name;

        // Parse parentheses content
        // First parenthesis that looks like a year (4 digits or 19xx) is the year
        // Second parenthesis is the author
        // Rest are descriptions
        let yearFound = false;
        let authorFound = false;

        for (const content of parenContents) {
            if (content === '-') {
                // Skip "-" entries but mark that we've seen year/author position
                if (!yearFound) {
                    yearFound = true;
                } else if (!authorFound) {
                    authorFound = true;
                }
                continue;
            }

            // Check if it's a year (4 digits or 19xx)
            if (!yearFound && /^(\d{4}|19xx)$/.test(content)) {
                result.year = content;
                yearFound = true;
            } else if (!authorFound && yearFound) {
                // After year is found, next is author
                result.author = content;
                authorFound = true;
            } else {
                // Everything else is description
                descriptions.push(content);
            }
        }

        result.description = descriptions.join(', ');

        return result;
    }
}

module.exports = FileParser;
