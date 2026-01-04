const readline = require('readline');
const SearchEngine = require('./SearchEngine');

/**
 * Interactive search UI with readline
 */
class SearchUI {
    /**
     * Start interactive search mode
     * @param {Map} filesMap - The files map to search through
     * @param {Function} onExit - Callback when search mode exits
     */
    static interactiveSearch(filesMap, onExit) {
        console.log('\n=== Search Mode ===');
        console.log('Type your search term (or press Enter to exit search):');
        
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            prompt: 'search> ',
            terminal: true
        });
        
        rl.prompt();
        
        rl.on('line', (line) => {
            const searchTerm = line.trim();
            
            if (!searchTerm) {
                // Empty line - exit search mode
                // Pause stdin before closing to prevent it from being destroyed
                rl.input.pause();
                rl.close();
                return;
            }
            
            const results = SearchEngine.searchFiles(filesMap, searchTerm);
            
            if (results.length === 0) {
                console.log(`No matches found for "${searchTerm}"\n`);
            } else {
                console.log(`\nFound ${results.length} result(s) for "${searchTerm}":\n`);
                
                for (let i = 0; i < results.length; i++) {
                    const result = results[i];
                    console.log(`${i + 1}. [${result.path}]`);
                    console.log(`   ${result.highlight}\n`);
                }
            }
            
            rl.prompt();
        });
        
        rl.on('close', () => {
            console.log('\nExiting search mode...');
            if (onExit) {
                onExit();
            }
        });
        
        rl.on('SIGINT', () => {
            // Handle Ctrl+C - pause stdin before closing
            rl.input.pause();
            rl.close();
        });
    }
}

module.exports = SearchUI;
