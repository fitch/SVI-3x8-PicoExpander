const fs = require('fs');

const origPath = 'pico/bootrom/svi-3x8_v111.rom';
const modPath = 'pico/bootrom/328casb.rom';
const outputH = 'pico/c/biospatch.h';

const ORIG = fs.readFileSync(origPath);
const MOD = fs.readFileSync(modPath);

if (ORIG.length !== 32768 || MOD.length !== 32768) {
    throw new Error('Both ROM files must be exactly 32768 bytes');
}

let patches = [];
let i = 0;

while (i < 32768) {
    if (ORIG[i] !== MOD[i]) {
        let start = i;
        let diffBytes = [];
        while (i < 32768 && ORIG[i] !== MOD[i]) {
            diffBytes.push(MOD[i]);
            i++;
        }
        patches.push({ offset: start, length: diffBytes.length, bytes: diffBytes });
    } else {
        i++;
    }
}

function toCArray(arr) {
    return arr.map(v => `0x${v.toString(16).padStart(2, '0')}`).join(', ');
}

let header = `static const uint8_t BIOSPATCH[] = {
`;

patches.forEach(patch => {
    const offset_low = patch.offset & 0xFF;
    const offset_high = (patch.offset >> 8) & 0xFF;
    header += `    0x${offset_low.toString(16).padStart(2, '0')}, 0x${offset_high.toString(16).padStart(2, '0')}, ${patch.length}, ${toCArray(patch.bytes)},\n`;
});
header += `    0, 0\n};\n`;

fs.writeFileSync(outputH, header);

console.log(`Patch written to ${outputH} with ${patches.length} region(s) changed.`);