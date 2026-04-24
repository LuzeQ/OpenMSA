import { beforeEach, describe, expect, it, vi } from 'vitest';

const getModelMock = vi.fn();
const parseModelStringMock = vi.fn((modelString: string) => {
  const colonIndex = modelString.indexOf(':');
  if (colonIndex >= 0) {
    return {
      providerId: modelString.slice(0, colonIndex),
      modelId: modelString.slice(colonIndex + 1),
    };
  }
  return { providerId: 'openai', modelId: modelString };
});

vi.mock('@/lib/ai/providers', () => ({
  getModel: getModelMock,
  parseModelString: parseModelStringMock,
}));

vi.mock('@/lib/server/provider-config', () => ({
  resolveApiKey: vi.fn((_: string, clientKey?: string) => clientKey || ''),
  resolveBaseUrl: vi.fn((_: string, clientBaseUrl?: string) => clientBaseUrl),
  resolveProxy: vi.fn(() => undefined),
}));

vi.mock('@/lib/server/ssrf-guard', () => ({
  validateUrlForSSRF: vi.fn(async () => undefined),
}));

describe('resolveModel', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    getModelMock.mockReset();
    parseModelStringMock.mockClear();
    getModelMock.mockReturnValue({
      model: { id: 'mock-model' },
      modelInfo: { id: 'mock-model', name: 'Mock Model' },
    });
  });

  it('falls back to GPT when DEFAULT_MODEL points to Anthropic', async () => {
    vi.stubEnv('DEFAULT_MODEL', 'anthropic:claude-sonnet-4-6');
    const { resolveModel } = await import('@/lib/server/resolve-model');

    const result = await resolveModel({});

    expect(parseModelStringMock).toHaveBeenCalledWith('anthropic:claude-sonnet-4-6');
    expect(parseModelStringMock).toHaveBeenCalledWith('gpt-4o-mini');
    expect(getModelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'openai',
        modelId: 'gpt-4o-mini',
      }),
    );
    expect(result.modelString).toBe('gpt-4o-mini');
    expect(result.providerId).toBe('openai');
  });

  it('keeps client-supplied Anthropic config available', async () => {
    const { resolveModel } = await import('@/lib/server/resolve-model');

    const result = await resolveModel({
      modelString: 'anthropic:claude-sonnet-4-6',
      apiKey: 'sk-client-anthropic',
      providerType: 'anthropic',
    });

    expect(getModelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'anthropic',
        modelId: 'claude-sonnet-4-6',
        apiKey: 'sk-client-anthropic',
        providerType: 'anthropic',
      }),
    );
    expect(result.modelString).toBe('anthropic:claude-sonnet-4-6');
    expect(result.providerId).toBe('anthropic');
  });
});
