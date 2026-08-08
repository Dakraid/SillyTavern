import { describe, expect, test } from '@jest/globals';

import { toonDecode, toonEncode } from '../../src/util/bulk-combine/toon-codec.js';

describe('server TOON codec', () => {
    test('round-trips a JSON-compatible fixture with library defaults', () => {
        const fixture = {
            character: {
                '@name': 'Alice',
                summary: { '#text': 'A curious explorer.' },
                tags: ['clever', 'kind'],
            },
        };

        expect(toonDecode(toonEncode(fixture))).toEqual(fixture);
    });

    test('decodes fenced output with leading and trailing prose', () => {
        const text = [
            '```toon',
            'Here is the requested data.',
            'character:',
            '  name: Alice',
            'Hope this helps.',
            '```',
        ].join('\n');

        expect(toonDecode(text)).toEqual({ character: { name: 'Alice' } });
    });

    test('propagates the TOON library decode message for malformed input', () => {
        expect(() => toonDecode('Preface.\na[2]: one\nThanks.'))
            .toThrow('Expected 2 inline-form values, but got 1');
    });
});
