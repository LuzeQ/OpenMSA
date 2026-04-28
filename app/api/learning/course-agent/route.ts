import { NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonrepair } from 'jsonrepair';
import { callLLM } from '@/lib/ai/llm';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { getCurrentUserFromSession } from '@/lib/server/auth/current-user';
import { resolveModelFromHeaders } from '@/lib/server/resolve-model';
import { ensureTeacherOrAdmin } from '@/app/api/learning/utils';

const log = createLogger('LearningCourseAgent API');

const difficultySchema = z.enum(['basic', 'intermediate', 'advanced']);
const generationStatusSchema = z.enum([
  'not_started',
  'started',
  'processing',
  'binding_pending',
  'succeeded',
  'failed',
]);

const draftLessonSchema = z.object({
  id: z.string().optional(),
  title: z.string().max(120).default(''),
  description: z.string().max(500).default(''),
  learningObjectivesText: z.string().max(1000).default(''),
  prerequisitesText: z.string().max(1000).default(''),
  difficulty: difficultySchema.default('basic'),
  diagnosticTagsText: z.string().max(1000).default(''),
  classroomId: z.string().max(120).default(''),
  generationStatus: generationStatusSchema.optional(),
  previewUrl: z.string().max(260).optional(),
  lastGenerationTaskId: z.string().max(120).optional(),
});

const draftChapterSchema = z.object({
  id: z.string().optional(),
  title: z.string().max(120).default(''),
  description: z.string().max(500).default(''),
  lessons: z.array(draftLessonSchema).min(1).max(20),
});

const draftSchema = z.object({
  title: z.string().max(120).default(''),
  description: z.string().max(600).default(''),
  targetAudience: z.string().max(200).default(''),
  source: z.enum(['manual', 'ai_generated', 'mixed']).default('mixed'),
  chapters: z.array(draftChapterSchema).min(1).max(20),
});

const courseAgentMessageSchema = z.object({
  role: z.enum(['teacher', 'agent']),
  content: z.string().max(2000),
});

const generationRequestSchema = z.object({
  chapterIndex: z.number().int().nonnegative().optional(),
  lessonIndex: z.number().int().nonnegative().optional(),
  chapterTitle: z.string().max(120).optional(),
  lessonTitle: z.string().max(120).optional(),
  requirements: z.string().max(1200).optional(),
});

const requestSchema = z.object({
  message: z.string().min(1).max(2000),
  messages: z.array(courseAgentMessageSchema).max(20).default([]),
  draft: draftSchema,
  editingProgramId: z.string().optional().nullable(),
});

const agentOutputSchema = z.object({
  assistantMessage: z.string().min(1).max(2000),
  summary: z.array(z.string().min(1).max(160)).max(8).default([]),
  draft: draftSchema,
  saveProgram: z.boolean().default(false),
  generationRequests: z.array(generationRequestSchema).max(10).default([]),
});

type ProgramDraft = z.infer<typeof draftSchema>;
type DraftChapter = z.infer<typeof draftChapterSchema>;
type DraftLesson = z.infer<typeof draftLessonSchema>;
type AgentOutput = z.infer<typeof agentOutputSchema>;

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

function parseAgentOutput(rawText: string): AgentOutput {
  const rawJson = extractJsonObject(rawText);
  try {
    return agentOutputSchema.parse(JSON.parse(rawJson));
  } catch {
    const repaired = jsonrepair(rawJson);
    return agentOutputSchema.parse(JSON.parse(repaired));
  }
}

function normalizeKey(value: string | undefined): string {
  return (value || '').trim().toLowerCase();
}

function pickExistingChapter(
  current: ProgramDraft,
  chapter: DraftChapter,
  index: number,
): DraftChapter | undefined {
  const byPosition = current.chapters[index];
  const key = normalizeKey(chapter.title);
  if (!key) return byPosition;
  return current.chapters.find((item) => normalizeKey(item.title) === key) || byPosition;
}

function pickExistingLesson(
  existingChapter: DraftChapter | undefined,
  lesson: DraftLesson,
  index: number,
): DraftLesson | undefined {
  const byPosition = existingChapter?.lessons[index];
  const key = normalizeKey(lesson.title);
  if (!key) return byPosition;
  return existingChapter?.lessons.find((item) => normalizeKey(item.title) === key) || byPosition;
}

function normalizeAgentDraft(nextDraft: ProgramDraft, currentDraft: ProgramDraft): ProgramDraft {
  return {
    title: nextDraft.title.trim() || currentDraft.title.trim() || '未命名课程',
    description: nextDraft.description.trim(),
    targetAudience: nextDraft.targetAudience.trim(),
    source: nextDraft.source || currentDraft.source || 'mixed',
    chapters: nextDraft.chapters.map((chapter, chapterIndex) => {
      const existingChapter = pickExistingChapter(currentDraft, chapter, chapterIndex);
      return {
        id: chapter.id || existingChapter?.id,
        title: chapter.title.trim() || `章节 ${chapterIndex + 1}`,
        description: chapter.description.trim(),
        lessons: chapter.lessons.map((lesson, lessonIndex) => {
          const existingLesson = pickExistingLesson(existingChapter, lesson, lessonIndex);
          return {
            id: lesson.id || existingLesson?.id,
            title: lesson.title.trim() || `课时 ${lessonIndex + 1}`,
            description: lesson.description.trim(),
            learningObjectivesText: lesson.learningObjectivesText.trim(),
            prerequisitesText: lesson.prerequisitesText.trim(),
            difficulty: lesson.difficulty || existingLesson?.difficulty || 'basic',
            diagnosticTagsText: lesson.diagnosticTagsText.trim(),
            classroomId: lesson.classroomId.trim() || existingLesson?.classroomId || '',
            generationStatus: lesson.generationStatus || existingLesson?.generationStatus,
            previewUrl: lesson.previewUrl || existingLesson?.previewUrl,
            lastGenerationTaskId:
              lesson.lastGenerationTaskId || existingLesson?.lastGenerationTaskId,
          };
        }),
      };
    }),
  };
}

function hasExplicitContentGenerationIntent(message: string): boolean {
  const normalized = message.replace(/\s+/g, '');
  return (
    /(生成|重生成|重新生成|制作|创建).{0,16}(课件|课堂内容|课时内容|教学内容|互动课堂|课堂)/.test(
      normalized,
    ) || /第[一二三四五六七八九十百\d]+课.{0,16}(生成|重生成|重新生成|制作)/.test(normalized)
  );
}

function hasExplicitSaveIntent(message: string): boolean {
  const normalized = message.replace(/\s+/g, '');
  return /(保存|创建到课程列表|新建课程体系|更新课程体系|保存课程|落库)/.test(normalized);
}

function buildSystemPrompt() {
  return `你是 OpenMAIC 教师端课程系统 Agent，只帮助老师创建和调整课程体系草稿。
必须只返回 JSON，不要返回 markdown，不要解释。

返回结构必须严格符合：
{
  "assistantMessage": "给老师看的简短回复",
  "summary": ["本轮改动摘要"],
  "draft": {
    "title": "课程标题",
    "description": "课程简介",
    "targetAudience": "目标受众",
    "source": "manual|ai_generated|mixed",
    "chapters": [
      {
        "id": "保留已有 id，没有则省略",
        "title": "章节标题",
        "description": "章节描述",
        "lessons": [
          {
            "id": "保留已有 id，没有则省略",
            "title": "课时标题",
            "description": "课时说明",
            "learningObjectivesText": "学习目标，用；分隔",
            "prerequisitesText": "先修知识，用；分隔",
            "difficulty": "basic|intermediate|advanced",
            "diagnosticTagsText": "诊断标签，用；分隔",
            "classroomId": "保留已有 classroomId，没有则为空字符串",
            "generationStatus": "保留已有状态，没有则省略",
            "previewUrl": "保留已有 previewUrl，没有则省略",
            "lastGenerationTaskId": "保留已有任务 id，没有则省略"
          }
        ]
      }
    ]
  },
  "saveProgram": false,
  "generationRequests": [
    {
      "chapterIndex": 0,
      "lessonIndex": 0,
      "chapterTitle": "章节标题",
      "lessonTitle": "课时标题",
      "requirements": "课件生成补充要求，可省略"
    }
  ]
}

规则：
1. draft 必须是完整课程草稿，不要只返回局部 patch。
2. 老师要求创建/调整课程时，直接改 draft，不要要求老师再填表。
3. 必须尽量保留已有 id、classroomId、generationStatus、previewUrl、lastGenerationTaskId。
4. 只有老师明确要求“生成课件、生成课堂内容、重生成课时内容、制作互动课堂”等课件/课堂内容生成动作时，才返回 generationRequests；普通“创建课程/生成课程体系/调整课程大纲”不能返回 generationRequests。
5. 老师明确要求保存/创建到课程列表/更新课程体系/生成课件时，saveProgram 才为 true。
6. 不处理发布、派发、删除课程；遇到这些请求，只说明仍需使用现有按钮流程，并保持 draft 合理。`;
}

function buildUserPrompt(input: z.infer<typeof requestSchema>) {
  return `当前编辑课程 ID：${input.editingProgramId || '未保存'}

当前课程草稿 JSON：
${JSON.stringify(input.draft, null, 2)}

最近对话：
${input.messages.map((item) => `${item.role === 'teacher' ? '老师' : 'Agent'}：${item.content}`).join('\n') || '无'}

老师最新消息：
${input.message}

请根据老师最新消息返回结构化 JSON。`;
}

export async function POST(req: NextRequest) {
  let message = '';
  try {
    const user = await getCurrentUserFromSession();
    if (!user) {
      return apiError('INVALID_REQUEST', 401, 'Authentication required');
    }
    if (!ensureTeacherOrAdmin(user.role)) {
      return apiError('INVALID_REQUEST', 403, 'Permission denied');
    }

    let body: z.infer<typeof requestSchema>;
    try {
      body = requestSchema.parse(await req.json());
    } catch (error) {
      if (error instanceof z.ZodError) {
        return apiError('INVALID_REQUEST', 400, error.issues[0]?.message || 'Invalid request');
      }
      throw error;
    }
    message = body.message;
    const requestModelHeader = req.headers.get('x-model') || undefined;
    const { model: languageModel, modelString, providerId } = await resolveModelFromHeaders(req);
    log.info(
      `Course agent model resolved [request=${requestModelHeader || 'none'}, resolved=${modelString}, provider=${providerId}]`,
    );

    const result = await callLLM(
      {
        model: languageModel,
        system: buildSystemPrompt(),
        prompt: buildUserPrompt(body),
        maxOutputTokens: 4200,
      },
      'learning-course-agent',
      {
        retries: 1,
        validate: (text) => {
          try {
            parseAgentOutput(text);
            return true;
          } catch {
            return false;
          }
        },
      },
    );

    const parsed = parseAgentOutput(result.text);
    const shouldGenerate = hasExplicitContentGenerationIntent(body.message);
    const generationRequests = shouldGenerate ? parsed.generationRequests : [];
    const saveProgram =
      parsed.saveProgram || generationRequests.length > 0 || hasExplicitSaveIntent(body.message);

    return apiSuccess({
      assistantMessage: parsed.assistantMessage.trim(),
      summary: parsed.summary.map((item) => item.trim()).filter(Boolean),
      draft: normalizeAgentDraft(parsed.draft, body.draft),
      saveProgram,
      generationRequests,
      modelString,
      providerId,
    });
  } catch (error) {
    log.error(`Failed to run course agent [message="${message || 'unknown'}"]`, error);
    return apiError(
      'GENERATION_FAILED',
      500,
      error instanceof Error ? error.message : 'Failed to run course agent',
    );
  }
}
