import { decode, encode } from '@toon-format/toon';

function cleanToon(text) {
    const input = String(text ?? '');
    const fenced = /```[^\n]*\n([\s\S]*?)```/.exec(input);
    const lines = (fenced?.[1] ?? input).replace(/^```[^\n]*\n?/, '').replace(/```\s*$/, '').split(/\r?\n/);

    while (lines.length > 0 && !lines[0].trim()) lines.shift();
    // LLM prose normally ends like a sentence. The first line that does not,
    // or that contains TOON's common structural punctuation, starts the document.
    while (lines.length > 0) {
        const line = lines[0].trim();
        const plausibleStart = /^[A-Za-z_@#[{]/.test(line)
            && (!/[.!?]$/.test(line) || ['[', '{', ':'].some(character => line.includes(character)));
        if (plausibleStart) break;
        lines.shift();
    }

    while (lines.length > 0 && !lines.at(-1).trim()) lines.pop();
    while (lines.length > 1) {
        const line = lines.at(-1).trim();
        if (!/[.!?]$/.test(line) || ['[', ']', '{', '}', ':', ','].some(character => line.includes(character))) break;
        lines.pop();
        while (lines.length > 0 && !lines.at(-1).trim()) lines.pop();
    }
    return lines.join('\n');
}

/** Decode model-produced TOON after deterministic fence/prose cleanup. */
export function toonDecode(text) {
    return decode(cleanToon(text));
}

/** Encode a JSON-compatible value using the TOON library defaults. */
export function toonEncode(value) {
    return encode(value);
}
