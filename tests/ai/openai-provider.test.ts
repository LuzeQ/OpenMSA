import { describe, expect, it } from 'vitest';

import { getModelInfo, getProvider } from '@/lib/ai/providers';

describe('OpenAI provider defaults', () => {
  it('includes GPT-5.5 in the built-in model list', () => {
    const modelIds = getProvider('openai')?.models.map((model) => model.id) ?? [];

    expect(modelIds).toContain('gpt-5.5');
    expect(getModelInfo('openai', 'gpt-5.5')).toMatchObject({
      id: 'gpt-5.5',
      name: 'GPT-5.5',
      capabilities: {
        streaming: true,
        tools: true,
        vision: true,
        thinking: {
          toggleable: true,
          budgetAdjustable: true,
          defaultEnabled: false,
        },
      },
    });
  });
});
