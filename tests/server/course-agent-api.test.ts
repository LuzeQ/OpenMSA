import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { callLLMMock, getCurrentUserFromSessionMock, resolveModelFromHeadersMock } = vi.hoisted(
  () => ({
    callLLMMock: vi.fn(),
    getCurrentUserFromSessionMock: vi.fn(),
    resolveModelFromHeadersMock: vi.fn(),
  }),
);

vi.mock('@/lib/ai/llm', () => ({
  callLLM: callLLMMock,
}));

vi.mock('@/lib/server/auth/current-user', () => ({
  getCurrentUserFromSession: getCurrentUserFromSessionMock,
}));

vi.mock('@/lib/server/resolve-model', () => ({
  resolveModelFromHeaders: resolveModelFromHeadersMock,
}));

const baseDraft = {
  title: '',
  description: '',
  targetAudience: '',
  source: 'manual',
  chapters: [
    {
      title: '章节 1',
      description: '',
      lessons: [
        {
          title: '',
          description: '',
          learningObjectivesText: '',
          prerequisitesText: '',
          difficulty: 'basic',
          diagnosticTagsText: '',
          classroomId: '',
        },
      ],
    },
  ],
};

function makeRequest(body: Record<string, unknown>) {
  return new Request('http://localhost/api/learning/course-agent', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as NextRequest;
}

function agentJson(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    assistantMessage: '已更新课程草稿。',
    summary: ['创建 1 章 1 课'],
    draft: {
      title: '初二电学课程',
      description: '电学基础能力训练',
      targetAudience: '初二学生',
      source: 'ai_generated',
      chapters: [
        {
          title: '电流与电压',
          description: '建立基本概念',
          lessons: [
            {
              title: '电流基础',
              description: '理解电流概念',
              learningObjectivesText: '理解电流；识别电路',
              prerequisitesText: '',
              difficulty: 'basic',
              diagnosticTagsText: '电流；电路',
              classroomId: '',
            },
          ],
        },
      ],
    },
    saveProgram: false,
    generationRequests: [],
    ...overrides,
  });
}

describe('course-agent API', () => {
  beforeEach(() => {
    vi.resetModules();
    callLLMMock.mockReset();
    getCurrentUserFromSessionMock.mockReset();
    resolveModelFromHeadersMock.mockReset();
    getCurrentUserFromSessionMock.mockResolvedValue({
      id: 'teacher-1',
      username: 'teacher',
      role: 'teacher',
    });
    resolveModelFromHeadersMock.mockResolvedValue({
      model: 'mock-model',
      modelString: 'openai:gpt-test',
      providerId: 'openai',
    });
  });

  it('returns a complete draft for a natural language course creation request', async () => {
    callLLMMock.mockResolvedValue({ text: agentJson() });
    const { POST } = await import('@/app/api/learning/course-agent/route');

    const res = await POST(
      makeRequest({
        message: '帮我创建一个初二电学课程',
        messages: [],
        draft: baseDraft,
        editingProgramId: null,
      }),
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.draft.title).toBe('初二电学课程');
    expect(json.generationRequests).toEqual([]);
  });

  it('keeps generation requests when the teacher explicitly asks for courseware generation', async () => {
    callLLMMock.mockResolvedValue({
      text: agentJson({
        saveProgram: true,
        generationRequests: [{ chapterIndex: 0, lessonIndex: 0, requirements: '加入互动实验' }],
      }),
    });
    const { POST } = await import('@/app/api/learning/course-agent/route');

    const res = await POST(
      makeRequest({
        message: '请生成第 1 课课件',
        messages: [],
        draft: baseDraft,
        editingProgramId: null,
      }),
    );
    const json = await res.json();

    expect(json.saveProgram).toBe(true);
    expect(json.generationRequests).toHaveLength(1);
  });

  it('drops generation requests when the teacher only asks to edit the syllabus', async () => {
    callLLMMock.mockResolvedValue({
      text: agentJson({
        generationRequests: [{ chapterIndex: 0, lessonIndex: 0 }],
      }),
    });
    const { POST } = await import('@/app/api/learning/course-agent/route');

    const res = await POST(
      makeRequest({
        message: '把第一课标题改得更具体',
        messages: [],
        draft: baseDraft,
        editingProgramId: null,
      }),
    );
    const json = await res.json();

    expect(json.generationRequests).toEqual([]);
  });

  it('repairs malformed JSON before validation', async () => {
    callLLMMock.mockResolvedValue({
      text: agentJson().replace('"generationRequests":[]', '"generationRequests":[],'),
    });
    const { POST } = await import('@/app/api/learning/course-agent/route');

    const res = await POST(
      makeRequest({
        message: '创建课程草稿',
        messages: [],
        draft: baseDraft,
        editingProgramId: null,
      }),
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
  });

  it('returns an error when model output fails schema validation', async () => {
    callLLMMock.mockResolvedValue({ text: '{"assistantMessage":"bad"}' });
    const { POST } = await import('@/app/api/learning/course-agent/route');

    const res = await POST(
      makeRequest({
        message: '创建课程草稿',
        messages: [],
        draft: baseDraft,
        editingProgramId: null,
      }),
    );
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.success).toBe(false);
    expect(json.errorCode).toBe('GENERATION_FAILED');
  });
});
