/**
 * Small Host smoke test for prompt-editor without a Harness session.
 * Run with: node tests/smoke.mjs
 */

import { apply, Config } from '../index.js';

const listeners = new Map();
const registeredRoutes = [];

const ctx = {
  logger: { warn: () => {} },
  on(event, callback) {
    listeners.set(event, callback);
    return () => listeners.delete(event);
  },
  get(name) {
    if (name === 'agentPresets') {
      return {
        defaultId: 'standard',
        composedPreset: () => 'standard',
        async acquireScope(preset) {
          return { key: preset ?? 'default', [Symbol.asyncDispose]: async () => {} };
        },
      };
    }
    if (name === 'agentDefaultModel') {
      return {
        currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }),
      };
    }
    return undefined;
  },
  effect(effect) {
    effect();
  },
  inject(_services, callback) {
    callback(ctx);
  },
  webServer: {
    register(route) {
      registeredRoutes.push(route);
      return () => {};
    },
  },
  connection: {
    requestRejection: () => undefined,
  },
  systemPrompt: {
    async assemble(context) {
      return {
        sections:
          assemblyMode === 'minimal'
            ? [
                {
                  name: 'deployment:persona-prefix',
                  text: 'You are a helpful software engineer assistant.',
                },
              ]
            : [
                {
                  name: 'harness:identity',
                  text: 'You are an AI agent powered by DeepSeek Harness.',
                },
                {
                  name: 'deployment:persona-prefix',
                  text: 'You are a coding agent powered by the {{model}} model.',
                },
                { name: 'tool:read', text: 'Use the read tool.' },
              ],
        contexts: [],
        tools: [],
        variables: {},
        assembledFor: context,
      };
    },
  },
};

let currentPreset = 'standard';
let assemblyMode = 'standard';
let sectionOptions;
let disposed = false;
const agent = {
  id: 'session-smoke',
  session: { header: { agentPreset: 'standard' } },
  ctx: {
    systemPrompt: {
      section(options) {
        sectionOptions = options;
        return () => {
          disposed = true;
        };
      },
    },
  },
};

apply(ctx, Config({ prompts: { standard: 'Be extra concise.', minimal: '' } }));

listeners.get('agent/created')({ agent, source: 'startup' });
if (sectionOptions?.name !== 'prompt-editor:appended') throw new Error('missing section registration');
if (sectionOptions.order !== 20_000) throw new Error('wrong section order');
if (sectionOptions.interpolate !== false) throw new Error('user text must be literal');
if (sectionOptions.text() !== 'Be extra concise.') throw new Error('standard text was not captured');

currentPreset = 'minimal';
listeners.get('agent-preset/selected')('session-smoke', 'minimal');
if (sectionOptions.text() !== '') throw new Error('preset switch did not refresh text');

let responseStatus;
let responseBody;
const route = registeredRoutes.find((candidate) => candidate.path === '/prompt-editor/preview');
if (route === undefined) throw new Error('preview route was not registered');
await route.handler(
  { method: 'GET', url: '/prompt-editor/preview?preset=standard' },
  {
    writeHead(status) {
      responseStatus = status;
    },
    end(body) {
      responseBody = body;
    },
  }
);
const preview = JSON.parse(responseBody);
if (responseStatus !== 200 || preview.ok !== true) throw new Error(`preview failed: ${responseBody}`);
if (!preview.prompt.includes('You are a coding agent powered by the deepseek-flash model.')) {
  throw new Error(`model variable was not resolved: ${preview.prompt}`);
}
if (preview.likelyComplete !== false) throw new Error('ordinary preset was marked complete');

assemblyMode = 'minimal';
responseStatus = undefined;
responseBody = undefined;
await route.handler(
  { method: 'GET', url: '/prompt-editor/preview?preset=minimal' },
  {
    writeHead(status) {
      responseStatus = status;
    },
    end(body) {
      responseBody = body;
    },
  }
);
const completePreview = JSON.parse(responseBody);
if (responseStatus !== 200 || completePreview.ok !== true)
  throw new Error(`complete preview failed: ${responseBody}`);
if (completePreview.likelyComplete !== true) throw new Error('complete preset was not detected');
if (completePreview.sectionCount !== 1) throw new Error('complete preset preview had more than one section');

listeners.get('agent/disposed')({ agent });
if (!disposed) throw new Error('section disposer did not run');
console.log('prompt-editor smoke ok');
