#!/usr/bin/env node

/**
 * Save State (.sta) File Checker
 * 
 * Usage: node check_sta.js <filename.sta>
 * 
 * Validates the save state file format and displays information about:
 * - Header validity
 * - Version
 * - Bank configuration
 * - File size
 */

const fs = require('fs');
const path = require('path');

// Import StaFormat for validation
const StaFormat = require('./lib/formats/StaFormat');

function main() {
    const args = process.argv.slice(2);
    
    if (args.length === 0) {
        console.log('Save State (.sta) File Checker');
        console.log('==============================');
        console.log('');
        console.log('Usage: node check_sta.js <filename.sta>');
        console.log('');
        console.log('Validates a save state file and displays its information.');
        process.exit(1);
    }
    
    const filename = args[0];
    
    // Check if file exists
    if (!fs.existsSync(filename)) {
        console.error(`Error: File not found: ${filename}`);
        process.exit(1);
    }
    
    // Read file
    let buffer;
    let fileSize;
    try {
        buffer = fs.readFileSync(filename);
        fileSize = buffer.length;
    } catch (err) {
        console.error(`Error reading file: ${err.message}`);
        process.exit(1);
    }
    
    console.log('Save State File Information');
    console.log('===========================');
    console.log(`File: ${path.basename(filename)}`);
    console.log(`Path: ${path.resolve(filename)}`);
    console.log(`File size: ${fileSize} bytes (${(fileSize / 1024).toFixed(2)} KB)`);
    console.log('');
    
    // Validate using StaFormat
    const result = StaFormat.validate(buffer, fileSize);
    
    if (!result.valid) {
        console.log('Validation: FAILED');
        console.log(`Error: ${result.error}`);
        process.exit(1);
    }
    
    console.log('Validation: PASSED');
    console.log('');
    console.log('Header Information');
    console.log('------------------');
    
    // Extract header details manually for display
    const magic = buffer.subarray(0, 21).toString('ascii');
    const version = buffer.readUInt8(21);
    const reserved = buffer.readUInt8(22);
    const bankConfig = buffer.readUInt8(23);
    
    console.log(`Magic string: "${magic}"`);
    console.log(`Version: 0x${version.toString(16).padStart(2, '0')}`);
    console.log(`Reserved byte: 0x${reserved.toString(16).padStart(2, '0')}`);
    console.log(`Bank config: 0x${bankConfig.toString(16).padStart(2, '0')}`);
    console.log('');
    
    console.log('Bank Configuration');
    console.log('------------------');
    
    const bankNames = ['BK01 (BIOS)', 'BK02 (RAM0)', 'BK11 (ROM_CART low)', 'BK12 (ROM_CART high)', 
                       'BK21 (RAM2 low)', 'BK22 (RAM2 high)', 'BK31 (RAM3 low)', 'BK32 (RAM3 high)'];
    
    let includedBanks = [];
    for (let i = 0; i < 8; i++) {
        const included = (bankConfig & (1 << i)) !== 0;
        const status = included ? '✓ included' : '✗ not included';
        console.log(`  Bit ${i} - ${bankNames[i]}: ${status}`);
        if (included) includedBanks.push(bankNames[i].split(' ')[0]);
    }
    
    console.log('');
    console.log('Summary');
    console.log('-------');
    console.log(`Included banks: ${includedBanks.length > 0 ? includedBanks.join(', ') : 'None'}`);
    console.log(`Bank data size: ${includedBanks.length * 32} KB (${includedBanks.length} banks × 32 KB)`);
    console.log(`RAM4 size: ${StaFormat.RAM4_DUMP_SIZE} bytes`);
    console.log(`Expected data size: ${StaFormat.calculateExpectedDataSize(bankConfig)} bytes`);
    console.log(`Total file size: ${fileSize} bytes`);
    console.log('');
    console.log(`Description: ${result.info}`);
}

main();
