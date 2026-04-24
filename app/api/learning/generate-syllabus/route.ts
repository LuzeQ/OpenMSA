import { NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonrepair } from 'jsonrepair';
import { callLLM } from '@/lib/ai/llm';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { getCurrentUserFromSession } from '@/lib/server/auth/current-user';
import { resolveModelFromHeaders } from '@/lib/server/resolve-model';
import { ensureTeacherOrAdmin } from '@/app/api/learning/utils';

const log = createLogger('LearningGenerateSyllabus API');

const lessonSchema = z.object({
  title: z.string().min(1).max(120),
  description: z.string().max(500).default(''),
  learningObjectives: z.array(z.string().min(1).max(120)).max(8).default([]),
  prerequisites: z.array(z.string().min(1).max(120)).max(8).default([]),
  difficulty: z.enum(['basic', 'intermediate', 'advanced']).default('basic'),
  diagnosticTags: z.array(z.string().min(1).max(60)).max(8).default([]),
  order: z.number().int().positive().optional(),
});

const chapterSchema = z.object({
  title: z.string().min(1).max(120),
  description: z.string().max(500).default(''),
  order: z.number().int().positive().optional(),
  lessons: z.array(lessonSchema).min(1).max(20),
});

const syllabusSchema = z.object({
  title: z.string().min(1).max(120),
  description: z.string().max(600).default(''),
  chapters: z.array(chapterSchema).min(1).max(20),
});

const requestSchema = z.object({
  topic: z.string().min(1).max(200),
  targetAudience: z.string().max(200).optional(),
  requirements: z.string().max(800).optional(),
});

function stripCodeFences(text: string): string {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  return cleaned.trim();
}

function extractJsonObject(text: string): string {
  const cleaned = stripCodeFences(text);
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error('No JSON object found in model output');
  }
  return cleaned.slice(firstBrace, lastBrace + 1);
}

function parseSyllabusOutput(rawText: string) {
  const rawJson = extractJsonObject(rawText);
  try {
    return syllabusSchema.parse(JSON.parse(rawJson));
  } catch {
    const repaired = jsonrepair(rawJson);
    return syllabusSchema.parse(JSON.parse(repaired));
  }
}

function normalizeSyllabusForClient(input: z.infer<typeof syllabusSchema>) {
  return {
    title: input.title.trim(),
    description: input.description.trim(),
    chapters: input.chapters.map((chapter, chapterIndex) => ({
      title: chapter.title.trim(),
      description: chapter.description.trim(),
      order: chapterIndex + 1,
      lessons: chapter.lessons.map((lesson, lessonIndex) => ({
        title: lesson.title.trim(),
        description: lesson.description.trim(),
        learningObjectives: lesson.learningObjectives.map((item) => item.trim()).filter(Boolean),
        prerequisites: lesson.prerequisites.map((item) => item.trim()).filter(Boolean),
        difficulty: lesson.difficulty,
        diagnosticTags: lesson.diagnosticTags.map((item) => item.trim()).filter(Boolean),
        order: lessonIndex + 1,
      })),
    })),
  };
}

export async function POST(req: NextRequest) {
  let topic = '';
  try {
    const user = await getCurrentUserFromSession();
    if (!user) {
      return apiError('INVALID_REQUEST', 401, 'Authentication required');
    }
    if (!ensureTeacherOrAdmin(user.role)) {
      return apiError('INVALID_REQUEST', 403, 'Permission denied');
    }

    const body = requestSchema.parse(await req.json());
    topic = body.topic;

    const requestModelHeader = req.headers.get('x-model') || undefined;
    const { model: languageModel, modelString, providerId } = await resolveModelFromHeaders(req);
    log.info(
      `Generate syllabus model resolved [request=${requestModelHeader || 'none'}, resolved=${modelString}, provider=${providerId}]`,
    );

    const systemPrompt = `你是一位资深教学设计专家。请根据老师输入生成“课程体系大纲”。
必须只返回 JSON，不要返回 markdown，不要解释。

JSON 结构必须严格符合：
{
  "title": "string",
  "description": "string",
  "chapters": [
    {
      "title": "string",
      "description": "string",
      "order": 1,
      "lessons": [
        {
          "title": "string",
          "description": "string",
          "learningObjectives": ["string"],
          "prerequisites": ["string"],
          "difficulty": "basic|intermediate|advanced",
          "diagnosticTags": ["string"],
          "order": 1
        }
      ]
    }
  ]
}`;

    const userPrompt = `课程主题：${body.topic}
目标受众：${body.targetAudience || '未指定'}
补充要求：${body.requirements || '无'}

约束：
1. 至少输出 1 个章节，每个章节至少 1 个课时。
2. 章节和课时标题必须具体，不要空泛。
3. 输出为老师可编辑草稿，语气客观中性。
4. difficulty 只能是 basic / intermediate / advanced。`;

    const result = await callLLM(
      {
        model: languageModel,
        system: systemPrompt,
        prompt: userPrompt,
        maxOutputTokens: 2600,
      },
      'learning-generate-syllabus',
      {
        retries: 1,
        validate: (text) => {
          try {
            parseSyllabusOutput(text);
            return true;
          } catch {
            return false;
          }
        },
      },
    );

    const parsed = parseSyllabusOutput(result.text);
    const normalized = normalizeSyllabusForClient(parsed);
    return apiSuccess({
      ...normalized,
      modelString,
      providerId,
    });
  } catch (error) {
    log.error(`Failed to generate syllabus [topic="${topic || 'unknown'}"]`, error);
    if (error instanceof z.ZodError) {
      return apiError('INVALID_REQUEST', 400, error.issues[0]?.message || 'Invalid request');
    }
    return apiError(
      'GENERATION_FAILED',
      500,
      error instanceof Error ? error.message : 'Failed to generate syllabus',
    );
  }
}
