import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
);

const readSource = (relativePath) =>
    fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');

function extractFunctionSource(source, functionName) {
    const match = new RegExp(
        `(?:export\\s+)?function\\s+${functionName}\\s*\\(`,
    ).exec(source);
    if (!match) {
        throw new Error(`Function ${functionName} not found`);
    }

    const start = match.index;
    const bodyStart = source.indexOf('{', start);
    let depth = 0;

    for (let index = bodyStart; index < source.length; index++) {
        if (source[index] === '{') {
            depth++;
        } else if (source[index] === '}') {
            depth--;
            if (depth === 0) {
                return source.slice(start, index + 1).replace(/^export\s+/, '');
            }
        }
    }

    throw new Error(`Function ${functionName} body not found`);
}

function loadFunction(source, functionName, dependencies = {}) {
    const dependencyNames = Object.keys(dependencies);
    const dependencyValues = Object.values(dependencies);
    const functionSource = extractFunctionSource(source, functionName);

    return Function(
        ...dependencyNames,
        `${functionSource}; return ${functionName};`,
    )(...dependencyValues);
}

describe('Combined multi-response tool-call message assembly', () => {
    test('non-streaming reasoning plus tool calls with empty content routes to processing container', () => {
        const source = readSource('public/script.js');
        const routingBlock = source.slice(
            source.indexOf('const responseHasToolCalls ='),
            source.indexOf('parseAndSaveLogprobs(data, continue_mag);'),
        );

        expect(routingBlock).toContain('const isToolOnlyResponse =');
        expect(routingBlock).toContain('[\'\', \'...\'].includes(getMessage)');
        expect(routingBlock).toContain(
            'const hasEmptyToolResponse = isToolOnlyResponse && !reasoning;',
        );
        expect(routingBlock).toContain('if (isToolOnlyResponse) {');
        expect(routingBlock).toContain(
            'createdToolProcessingMessageId = await createToolProcessingMessage({',
        );
        expect(routingBlock).toContain('reasoning,');
    });

    test('tool-only continuations do not overwrite visible text or clear processing state', () => {
        const source = readSource('public/script.js');
        const continuationBlock = source.slice(
            source.indexOf('Number.isInteger(processingMessageId) &&'),
            source.indexOf('} else if (originalType !== \'continue\') {'),
        );

        expect(continuationBlock).toContain('if (!isToolOnlyResponse) {');
        expect(continuationBlock).toContain(
            'message.mes = appendAssistantMessageText(message.mes, getMessage);',
        );
        expect(continuationBlock).toContain(
            'delete message.extra.isProcessingMessage;',
        );
        expect(continuationBlock).not.toContain('if (!hasEmptyToolResponse) {');
    });

    test('non-streaming follow-up reasoning appends as a new segment instead of replacing prior reasoning', () => {
        const scriptSource = readSource('public/script.js');
        const reasoningSource = readSource('public/scripts/reasoning.js');
        const helperSource = extractFunctionSource(
            scriptSource,
            'appendToolFlowReasoningToMessage',
        );

        expect(reasoningSource).toContain(
            'static appendReasoningSegment(extra, reasoning)',
        );
        expect(helperSource).toMatch(
            /ReasoningHandler\.appendReasoningSegment\([\s\S]*?message\.extra,\s*[\s\S]*?message\.extra\.reasoning,[\s\S]*?\);/,
        );
        expect(helperSource).toMatch(
            /ReasoningHandler\.appendReasoningSegment\([\s\S]*?message\.extra,\s*[\s\S]*?reasoning,[\s\S]*?\);/,
        );
        expect(helperSource).toContain(
            'message.extra.reasoning = ReasoningHandler.getJoinedReasoning(message.extra);',
        );
        expect(scriptSource).toContain(
            'appendToolFlowReasoningToMessage(message, reasoning);',
        );
    });

    test('reasoning segment helper keeps chronological reasoning order in a tool-flow simulation', () => {
        const appendAssistantMessageText = loadFunction(
            readSource('public/script.js'),
            'appendAssistantMessageText',
        );
        const message = {
            mes: '',
            extra: {
                reasoning: 'response 1 reasoning',
                processing_segments: [
                    { type: 'reasoning', content: 'response 1 reasoning' },
                    { type: 'trace', content: '<div>tool 1</div>' },
                ],
            },
        };

        message.extra.processing_segments.push({
            type: 'reasoning',
            content: 'response 2 reasoning',
        });
        message.mes = appendAssistantMessageText(message.mes, 'final answer');

        expect(message.extra.processing_segments).toEqual([
            { type: 'reasoning', content: 'response 1 reasoning' },
            { type: 'trace', content: '<div>tool 1</div>' },
            { type: 'reasoning', content: 'response 2 reasoning' },
        ]);
        expect(message.mes).toBe('final answer');
    });

    test('streaming tool-flow continuations start a new reasoning boundary on the same message', () => {
        const scriptSource = readSource('public/script.js');
        const reasoningSource = readSource('public/scripts/reasoning.js');

        expect(scriptSource).toContain('this.type === TOOL_CONTINUATION_TYPE');
        expect(scriptSource).toContain(
            'this.reasoningHandler.beginToolFlowResponse(this.messageId);',
        );
        expect(reasoningSource).toContain('beginToolFlowResponse(messageId)');
        expect(reasoningSource).toContain(
            'this.appendNextReasoningSegment = true;',
        );
        expect(reasoningSource).toContain('if (this.appendNextReasoningSegment) {');
    });

    test('streaming tool traces can append current response reasoning as a new segment', () => {
        const scriptSource = readSource('public/script.js');
        const reasoningSource = readSource('public/scripts/reasoning.js');

        expect(reasoningSource).toMatch(
            /appendProcessingTrace\([\s\S]*?messageId,[\s\S]*?trace,[\s\S]*?\{ appendReasoningAsNewSegment = false \} = \{\},[\s\S]*?\)/,
        );
        expect(reasoningSource).toContain('if (appendReasoningAsNewSegment) {');
        expect(scriptSource).toMatch(
            /\{[\s\S]*?appendReasoningAsNewSegment:\s*[\s\S]*?Number\.isInteger\(processingMessageId\),[\s\S]*?\}/,
        );
    });

    test('delete guard remains strict so reasoning or traced containers survive stealth-only tool flows', () => {
        const source = readSource('public/script.js');
        const nonStreamingToolBlock = source.slice(
            source.indexOf('if (canPerformToolCalls && responseHasToolCalls) {'),
            source.indexOf(
                'depth = depth + 1;',
                source.indexOf('if (canPerformToolCalls && responseHasToolCalls) {'),
            ),
        );
        const streamingToolBlock = source.slice(
            source.indexOf(
                'if (canPerformToolCalls && isStreamFinished && isStreamWithToolCalls) {',
            ),
            source.indexOf(
                'depth = depth + 1;',
                source.indexOf(
                    'if (canPerformToolCalls && isStreamFinished && isStreamWithToolCalls) {',
                ),
            ),
        );

        expect(nonStreamingToolBlock).toContain(
            'const shouldDeleteMessage = hasEmptyToolResponse;',
        );
        expect(nonStreamingToolBlock).toContain(
            'shouldDeleteMessage &&\n\t\t\t\t\t!toolTrace &&\n\t\t\t\t\t!Number.isInteger(processingMessageId)',
        );
        expect(nonStreamingToolBlock).not.toContain(
            'const shouldDeleteMessage = isToolOnlyResponse;',
        );
        expect(streamingToolBlock).toContain(
            '[\'\', \'...\'].includes(getMessage) &&\n\t\t\t\t\t\t!streamingProcessor.reasoningHandler.reasoning',
        );
    });

    test('OpenRouter continuation payload echoes reasoning_details on assistant tool-call messages', () => {
        const openaiSource = readSource('public/scripts/openai.js');
        const scriptSource = readSource('public/script.js');

        expect(openaiSource).toContain(
            'function cloneReasoningDetails(reasoningDetails)',
        );
        expect(openaiSource).toContain('const includeToolReasoning = true;');
        expect(openaiSource).toContain('const canIncludeActiveToolReasoning =');
        expect(openaiSource).toContain('isSameModel || hasToolInvocations');
        expect(openaiSource).toContain('Keep invocation.reasoning');
        expect(openaiSource).toContain('reasoning_details: reasoningDetails');
        expect(openaiSource).toContain(
            'reasoningIsEligible ? chatPrompt.reasoning_details : null',
        );
        expect(openaiSource).toContain('this.reasoning_details = includeReasoning');
        expect(openaiSource).toContain('reasoning_details: item.reasoning_details');
        expect(scriptSource).toContain('saveToolReasoningArtifactsToMessage(');
        expect(scriptSource).toContain(
            'newMessage.extra.reasoning_details = reasoningDetails',
        );
        expect(scriptSource).toContain('streamingProcessor.reasoningDetails,');
    });

    test('visible content from multiple responses remains joined without duplicate prefixing', () => {
        const appendAssistantMessageText = loadFunction(
            readSource('public/script.js'),
            'appendAssistantMessageText',
        );

        expect(
            appendAssistantMessageText('first response text', 'second response text'),
        ).toBe('first response text\n\nsecond response text');
        expect(
            appendAssistantMessageText(
                'first response text',
                'first response text\n\nsecond response text',
            ),
        ).toBe('first response text\n\nsecond response text');
    });
});
