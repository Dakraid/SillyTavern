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

describe('Tool-call continuation regressions', () => {
    test('stealth-only tool calls stop generation after saving invocation metadata', () => {
        const source = readSource('public/script.js');
        const shouldStopBlocks = source.match(
            /const shouldStopGeneration =[\s\S]*?;\n/g,
        );

        expect(shouldStopBlocks).toHaveLength(2);
        for (const block of shouldStopBlocks) {
            expect(block).toContain('toolInvocationState.hasOnlyStealthInvocations');
        }
        expect(source).toContain('saveToolInvocationsToMessage(');
    });

    test('streaming tool traces exclude stealth invocations and stop stealth-only flows', () => {
        const source = readSource('public/script.js');
        const streamingToolBranch = source.slice(
            source.indexOf('const isStreamFinished ='),
            source.indexOf('if (isStreamFinished) {'),
        );

        expect(streamingToolBranch).toContain(
            'toolInvocationState.hasOnlyStealthInvocations',
        );
        expect(streamingToolBranch).toContain(
            'ToolManager.formatToolCallTrace(\n                        toolInvocationState.visibleInvocations,\n                    )',
        );
        expect(streamingToolBranch).not.toContain(
            'ToolManager.formatToolCallTrace(\n                        invocationResult.invocations,\n                    )',
        );
    });

    test('tool flows suppress native auto-continue at streaming and non-streaming completion points', () => {
        const source = readSource('public/script.js');

        expect(source).toContain('let hadToolCallsInFlow = false;');
        expect(source).toContain('hadToolCallsInFlow = true;');
        expect(source).toContain(
            'if (!hadToolCallsInFlow) {\n                    triggerAutoContinue(messageChunk, isImpersonate);\n                }',
        );
        expect(source).toContain(
            'if (type !== \'quiet\' && !hadToolCallsInFlow) {\n            triggerAutoContinue(messageChunk, isImpersonate);\n        }',
        );
    });

    test('empty non-streaming tool responses create a processing container instead of saving an empty reply', () => {
        const source = readSource('public/script.js');

        expect(source).toContain('async function createToolProcessingMessage({');
        expect(source).toContain('newMessage.extra.isProcessingMessage = true;');
        expect(source).toContain('const hasEmptyToolResponse =');
        expect(source).toContain(
            'createdToolProcessingMessageId = await createToolProcessingMessage({',
        );
        expect(source).toContain(
            ': Number.isInteger(createdToolProcessingMessageId)',
        );
    });

    test('tool calls are disabled for swipe generations', () => {
        const source = readSource('public/scripts/tool-calling.js');

        expect(source).toMatch(
            /const noToolCallTypes = \['impersonate', 'quiet', 'continue', 'swipe'\];/,
        );
    });

    test('assistant continuation helper appends without overwriting or duplicating placeholders', () => {
        const appendAssistantMessageText = loadFunction(
            readSource('public/script.js'),
            'appendAssistantMessageText',
        );

        expect(appendAssistantMessageText('', 'hello')).toBe('hello');
        expect(appendAssistantMessageText('...', 'hello')).toBe('hello');
        expect(appendAssistantMessageText('hello', '')).toBe('hello');
        expect(appendAssistantMessageText('hello  ', '  world')).toBe(
            'hello\n\nworld',
        );
        expect(appendAssistantMessageText(null, '  world')).toBe('world');
        expect(appendAssistantMessageText('hello', '   ')).toBe('hello');
        expect(appendAssistantMessageText('hello', 'hello\n\nworld')).toBe(
            'hello\n\nworld',
        );
        expect(appendAssistantMessageText('hello\n\nworld', 'world')).toBe(
            'hello\n\nworld',
        );
    });

    test('streaming continuation prefix skips empty and placeholder messages', () => {
        const getAssistantMessageContinuationPrefix = loadFunction(
            readSource('public/script.js'),
            'getAssistantMessageContinuationPrefix',
        );

        expect(getAssistantMessageContinuationPrefix('')).toBe('');
        expect(getAssistantMessageContinuationPrefix('...')).toBe('');
        expect(getAssistantMessageContinuationPrefix(null)).toBe('');
        expect(getAssistantMessageContinuationPrefix('hello  ')).toBe('hello\n\n');
    });

    test('appendFinal keeps already-prefixed non-streaming continue text as-is', () => {
        const source = readSource('public/script.js');
        const appendFinalBranch = source.match(
            /} else if \(type === 'appendFinal'\) {[\s\S]*?} else {/,
        )?.[0];

        expect(appendFinalBranch).toContain('lastMessage.mes = getMessage;');
        expect(appendFinalBranch).not.toContain('appendAssistantMessageText');
    });

    test('non-streaming tool continuations remember target before tool callbacks append hidden messages', () => {
        const source = readSource('public/script.js');
        const targetIndex = source.indexOf('const toolProcessingMessageId =');
        const invokeIndex = source.indexOf('ToolManager.invokeFunctionTools(data');

        expect(targetIndex).toBeGreaterThan(-1);
        expect(invokeIndex).toBeGreaterThan(-1);
        expect(targetIndex).toBeLessThan(invokeIndex);
        expect(source).toContain(
            'const currentProcessingMessageId = toolProcessingMessageId;',
        );
        expect(source).toContain('!isHiddenToolResultMessage(message)');
    });

    test('tool recursion uses normalized provider-aware helper', () => {
        const scriptSource = readSource('public/script.js');
        const toolCallingSource = readSource('public/scripts/tool-calling.js');

        expect(scriptSource).toContain('this.finishReason = null;');
        expect(scriptSource).toContain('this.finishReason = currentFinishReason;');
        expect(toolCallingSource).toContain('static shouldRecurseForToolCalls(');
        expect(scriptSource).toMatch(
            /ToolManager\.shouldRecurseForToolCalls\(\s*streamingProcessor\.toolCalls/,
        );
        expect(scriptSource).toContain(
            'ToolManager.shouldRecurseForToolCalls(\n                data,',
        );
        expect(scriptSource).not.toContain(
            'const shouldRecurseForToolCalls = responseFinishReason === \'tool_calls\';',
        );
    });

    test('mixed content plus tool calls preserves assistant text without duplicate prefixing', () => {
        const source = readSource('public/script.js');

        expect(source).toContain('function saveToolInvocationsToMessage(');
        expect(source).toContain(
            'Stores tool invocations on the assistant message',
        );
        expect(source).toContain(
            'saveToolInvocationsToMessage(\n                        currentProcessingMessageId,\n                        invocationResult.invocations,\n                    );',
        );
        expect(source).toMatch(
            /this\.continueMessage\s*=\s*type === 'continue'\s*\?\s*continueMessage\s*:\s*suppressContinuationPrefix\s*\?\s*''\s*:\s*getAssistantMessageContinuationPrefix\(chat\[this\.messageId\]\?\.mes\);/,
        );
        expect(source).toContain(
            'appendAssistantMessageText(this.continueMessage, text)',
        );
        expect(source).toContain(
            'appendAssistantMessageText(\n\t\t\t\t\t\t\t        streamingProcessor.continueMessage,',
        );
        expect(source).toContain(
            'currentProcessingMessageId,\n                            finalText,',
        );
        expect(source).not.toContain(
            'currentProcessingMessageId,\n                            getMessage,\n                            { unlockUI: false },',
        );
        expect(source).not.toContain('this.continueMessage + text');
        expect(source).not.toContain(
            'streamingProcessor.continueMessage + getMessage',
        );
    });

    test('tool follow-up uses explicit tool continuation mode instead of normal generation', () => {
        const source = readSource('public/script.js');
        const recursiveToolBranch = source.slice(
            source.indexOf(
                'return await Generate(\n                            TOOL_CONTINUATION_TYPE',
            ),
            source.indexOf('await cleanupTemporaryZTrackerToolResults();'),
        );

        expect(source).toContain('const TOOL_CONTINUATION_TYPE = \'tool-continue\';');
        expect(source).toContain('type === TOOL_CONTINUATION_TYPE');
        expect(source).toContain('isToolFlowContinuation: true');
        expect(source).toContain('suppressContinuationPrefix: false');
        expect(recursiveToolBranch).not.toContain('\'normal\'');
        expect(source).not.toContain(
            'return await Generate(\n                            \'normal\'',
        );
        expect(source).not.toContain(
            'return await Generate(\n                    \'normal\'',
        );
    });

    test('orphaned tool invocation system-message saver is removed', () => {
        const toolCallingSource = readSource('public/scripts/tool-calling.js');
        const eventsSource = readSource('public/scripts/events.js');

        expect(toolCallingSource).not.toContain('saveFunctionToolInvocations');
        expect(eventsSource).not.toContain('TOOL_CALLS_PERFORMED');
        expect(eventsSource).not.toContain('TOOL_CALLS_RENDERED');
    });

    test('processing tool-only messages with tool invocations remain in prompt history', () => {
        const source = readSource('public/script.js');

        expect(source).toContain('Array.isArray(x.extra?.tool_invocations) &&');
        expect(source).toContain('x.extra.tool_invocations.length > 0');
        expect(source).toContain(
            '(!x.extra?.isProcessingMessage ||\n\t\t\t\tString(x.mes ?? \'\').trim() ||',
        );
        expect(source).toContain(
            'updateMessageBlock(\n                    currentProcessingMessageId,\n                    chat[currentProcessingMessageId],\n                );',
        );
    });

    test('active tool-flow injections are moved before assistant tool-call pair', () => {
        const source = readSource('public/scripts/openai.js');
        const moveActiveToolFlowInjectionsBeforeToolCall = loadFunction(
            source,
            'moveActiveToolFlowInjectionsBeforeToolCall',
        );
        const toolTurn = {
            role: 'assistant',
            content: '',
            invocations: [{ id: 'call_1', result: 'failed', error: true }],
        };
        const depthZeroInjection = {
            role: 'system',
            content: '</chat_history><last_message>',
            injected: true,
        };

        const ordered = moveActiveToolFlowInjectionsBeforeToolCall([
            { role: 'system', content: 'system' },
            { role: 'assistant', content: 'previous' },
            { role: 'user', content: 'request' },
            toolTurn,
            depthZeroInjection,
        ]);

        expect(ordered.map((message) => message.content)).toEqual([
            'system',
            'previous',
            'request',
            '</chat_history><last_message>',
            '',
        ]);
        expect(ordered[3]).toBe(depthZeroInjection);
        expect(ordered[4]).toBe(toolTurn);
    });

    test('prompt reconstruction keeps assistant tool-call shape and carries reasoning through tool results', () => {
        const source = readSource('public/scripts/openai.js');

        expect(source).toContain(
            'const toolCallMessage = await Message.createAsync(\n                chatMessage.role,\n                /** @type {string} */ (chatMessage.content),',
        );
        expect(source).toContain('function addToolReasoningToResultContent(');
        expect(source).toContain('Assistant reasoning before this tool call:');
        expect(source).toContain(
            'addToolReasoningToResultContent(\n                                invocation.result,\n                                invocation.reasoning || activeToolReasoning,',
        );
        expect(source).toContain(
            'chatPrompt.reasoning ||\n\t\t\t\tinvocations.find',
        );
        expect(source).toContain('assistantReasoning ||');
        expect(source).toContain('async countTokens() {');
        expect(source).toMatch(
            /async countTokens\(\) \{[\s\S]*role: this\.role,[\s\S]*content: this\.content,[\s\S]*this\.name[\s\S]*tool_calls: JSON\.stringify\(this\.tool_calls\)[\s\S]*this\.reasoning[\s\S]*\}\);[\s\S]*\}/,
        );
        expect(source).toContain('await this.countTokens();');
        expect(source).not.toContain(
            'const toolCallMessage = await Message.createAsync(\n                chatMessage.role,\n                undefined,\n                \'toolCall-\' + chatMessage.identifier,\n            );',
        );
    });
});

describe('Stable Diffusion tool-image regressions', () => {
    test('tool images hidden by visibility settings are marked as hidden tool results', () => {
        const source = readSource(
            'public/scripts/extensions/stable-diffusion/index.js',
        );

        expect(source).toContain(
            'const isVisible = getVisibilityByInitiator(initiator);',
        );
        expect(source).toContain('initiator === initiators.tool');
        expect(source).toContain('isToolResult: true');
    });

    test('background image type is normalized before validation', () => {
        const source = readSource(
            'public/scripts/extensions/stable-diffusion/index.js',
        );

        expect(source).toContain('args.type.trim().toLowerCase()');
        expect(source).toContain('background: generationMode.BACKGROUND');
        expect(source).toContain('Invalid image type:');
    });
});

describe('/del visible-message regressions', () => {
    test('visible message helpers skip hidden tool-result messages', () => {
        const source = readSource('public/script.js');
        const chat = [
            { mes: 'visible 0' },
            { mes: 'hidden', extra: { isToolResult: true } },
            { mes: 'visible 2' },
            { mes: 'hidden 2', extra: { isToolResult: true } },
        ];
        const isHiddenToolResultMessage = (message) =>
            Boolean(message?.extra?.isToolResult);
        const getVisibleMessageIds = loadFunction(source, 'getVisibleMessageIds', {
            chat,
            isHiddenToolResultMessage,
        });
        const getVisibleMessageCount = loadFunction(
            source,
            'getVisibleMessageCount',
            { getVisibleMessageIds },
        );
        const getLastVisibleMessageId = loadFunction(
            source,
            'getLastVisibleMessageId',
            { chat, isHiddenToolResultMessage },
        );

        expect(getVisibleMessageIds()).toEqual([0, 2]);
        expect(getVisibleMessageCount()).toBe(2);
        expect(getLastVisibleMessageId()).toBe(2);
    });

    test('/del derives deletion range from visible IDs in one pass', () => {
        const source = readSource('public/scripts/power-user.js');
        const doDelModeSource = source.match(
            /async function doDelMode[\s\S]*?\n}\n\nfunction doResetPanels/,
        )?.[0];

        expect(doDelModeSource).toContain(
            'const visibleMessageIds = getVisibleMessageIds();',
        );
        expect(doDelModeSource).toContain(
            'const visibleCount = visibleMessageIds.length;',
        );
        expect(doDelModeSource).toContain('visibleMessageIds.slice(-count)');
        expect(doDelModeSource).not.toContain('count > chat.length');
        expect(doDelModeSource).not.toContain('chat.length - count');
    });
});
