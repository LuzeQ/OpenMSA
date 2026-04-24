import { after, NextRequest } from 'next/server';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { getCurrentUserFromSession } from '@/lib/server/auth/current-user';
import {
  attachClassroomJobToLearningTask,
  createLearningLessonGenerationTask,
  getLearningProgramDetailByLesson,
} from '@/lib/server/learning-store';
import { createClassroomGenerationJob } from '@/lib/server/classroom-job-store';
import { runClassroomGenerationJob } from '@/lib/server/classroom-job-runner';
import { buildRequestOrigin } from '@/lib/server/classroom-storage';
import { resolveModel } from '@/lib/server/resolve-model';
import { ensureTeacherOrAdmin, mapLearningDomainError } from '@/app/api/learning/utils';
import type { ImageProviderId, VideoProviderId } from '@/lib/media/types';

const log = createLogger('LearningLessonGenerateContent API');

const requestSchema = z.object({
  syllabusId: z.string().optional(),
  requirements: z.string().max(1200).optional(),
  language: z.enum(['zh-CN', 'en-US']).optional(),
  materials: z
    .array(
      z.object({
        fileId: z.string().optional(),
        name: z.string().max(120).optional(),
      }),
    )
    .max(10)
    .optional(),
});

function parseBooleanHeader(value: string | null, fallback: boolean): boolean {
  if (value == null || value === '') return fallback;
  return value === 'true';
}

function parseIntegerHeader(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.floor(parsed);
}

function buildRequirementText(input: {
  courseTitle: string;
  courseDescription?: string;
  chapterTitle: string;
  lessonTitle: string;
  lessonDescription?: string;
  learningObjectives: string[];
  prerequisites: string[];
  difficulty: 'basic' | 'intermediate' | 'advanced';
  diagnosticTags: string[];
  requirements?: string;
}) {
  const lines = [
    `课程标题：${input.courseTitle}`,
    input.courseDescription ? `课程简介：${input.courseDescription}` : '',
    `章节：${input.chapterTitle}`,
    `课时：${input.lessonTitle}`,
    input.lessonDescription ? `课时说明：${input.lessonDescription}` : '',
    input.learningObjectives.length > 0
      ? `学习目标：${input.learningObjectives.map((item, index) => `${index + 1}. ${item}`).join('；')}`
      : '',
    input.prerequisites.length > 0
      ? `先修知识：${input.prerequisites.map((item, index) => `${index + 1}. ${item}`).join('；')}`
      : '',
    `难度：${input.difficulty}`,
    input.diagnosticTags.length > 0 ? `诊断标签：${input.diagnosticTags.join('、')}` : '',
    input.requirements?.trim() ? `老师补充要求：${input.requirements.trim()}` : '',
  ].filter(Boolean);

  return `${lines.join('\n')}\n\n请基于以上结构生成可直接用于学生自学的互动课堂内容，包含讲解、练习和检查点。`;
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ lessonId: string }> },
) {
  let lessonId = '';
  try {
    const user = await getCurrentUserFromSession();
    if (!user) {
      return apiError('INVALID_REQUEST', 401, 'Authentication required');
    }
    if (!ensureTeacherOrAdmin(user.role)) {
      return apiError('INVALID_REQUEST', 403, 'Permission denied');
    }

    const { lessonId: resolvedLessonId } = await context.params;
    lessonId = resolvedLessonId;
    const body = requestSchema.parse(await req.json());
    const modelString = req.headers.get('x-model') || undefined;
    const apiKey = req.headers.get('x-api-key') || undefined;
    const modelBaseUrl = req.headers.get('x-base-url') || undefined;
    const providerType = req.headers.get('x-provider-type') || undefined;
    const enableImageGeneration = parseBooleanHeader(
      req.headers.get('x-image-generation-enabled'),
      true,
    );
    const enableVideoGeneration = parseBooleanHeader(
      req.headers.get('x-video-generation-enabled'),
      true,
    );
    const imageProvider = req.headers.get('x-image-provider') || undefined;
    const imageModel = req.headers.get('x-image-model') || undefined;
    const imageApiKey = req.headers.get('x-image-api-key') || undefined;
    const imageBaseUrl = req.headers.get('x-image-base-url') || undefined;
    const videoProvider = req.headers.get('x-video-provider') || undefined;
    const videoModel = req.headers.get('x-video-model') || undefined;
    const videoApiKey = req.headers.get('x-video-api-key') || undefined;
    const videoBaseUrl = req.headers.get('x-video-base-url') || undefined;
    const minImagesHeader = parseIntegerHeader(req.headers.get('x-richness-min-images'));
    const minVideosHeader = parseIntegerHeader(req.headers.get('x-richness-min-videos'));
    const minInteractiveHeader = parseIntegerHeader(req.headers.get('x-richness-min-interactive'));
    const interactiveDepthHeader = req.headers.get('x-richness-interactive-depth');
    const resolvedModel = await resolveModel({
      modelString,
      apiKey,
      baseUrl: modelBaseUrl,
      providerType,
    });
    log.info(
      `Lesson generation model resolved [request=${modelString || 'none'}, resolved=${resolvedModel.modelString}, provider=${resolvedModel.providerId}, lessonId=${lessonId}]`,
    );

    const detail = await getLearningProgramDetailByLesson({
      teacherId: user.id,
      lessonId,
    });

    if (body.syllabusId && body.syllabusId !== detail.program.id) {
      return apiError('INVALID_REQUEST', 400, 'syllabusId does not match lesson');
    }

    const generationTask = await createLearningLessonGenerationTask({
      teacherId: user.id,
      programId: detail.program.id,
      lessonId,
      requirementsText: body.requirements,
      materialsSnapshot: body.materials,
    });

    const requirement = buildRequirementText({
      ...generationTask.launchContext,
      requirements: body.requirements,
    });

    const jobId = nanoid(10);
    const mediaConfig = {
      ...(imageProvider || imageModel || imageApiKey || imageBaseUrl
        ? {
            image: {
              ...(imageProvider ? { providerId: imageProvider as ImageProviderId } : {}),
              ...(imageModel ? { model: imageModel } : {}),
              ...(imageApiKey ? { apiKey: imageApiKey } : {}),
              ...(imageBaseUrl ? { baseUrl: imageBaseUrl } : {}),
            },
          }
        : {}),
      ...(videoProvider || videoModel || videoApiKey || videoBaseUrl
        ? {
            video: {
              ...(videoProvider ? { providerId: videoProvider as VideoProviderId } : {}),
              ...(videoModel ? { model: videoModel } : {}),
              ...(videoApiKey ? { apiKey: videoApiKey } : {}),
              ...(videoBaseUrl ? { baseUrl: videoBaseUrl } : {}),
            },
          }
        : {}),
    };
    const richnessPolicy = {
      minImages:
        typeof minImagesHeader === 'number'
          ? Math.max(0, minImagesHeader)
          : enableImageGeneration
            ? 1
            : 0,
      minVideos:
        typeof minVideosHeader === 'number'
          ? Math.max(0, minVideosHeader)
          : enableVideoGeneration
            ? 1
            : 0,
      minInteractive:
        typeof minInteractiveHeader === 'number' ? Math.max(0, minInteractiveHeader) : 1,
      interactiveDepth:
        interactiveDepthHeader === 'medium' || interactiveDepthHeader === 'heavy'
          ? interactiveDepthHeader
          : 'light',
    } as const;
    const generateInput = {
      requirement,
      language: body.language || 'zh-CN',
      // Lesson generation already has rich syllabus context; disable web search
      // by default to reduce latency and improve stability.
      enableWebSearch: false,
      enableImageGeneration,
      enableVideoGeneration,
      modelString: resolvedModel.modelString,
      richnessPolicy,
      ...(Object.keys(mediaConfig).length > 0 ? { mediaConfig } : {}),
      ...(apiKey ? { apiKey } : {}),
      ...(modelBaseUrl ? { baseUrl: modelBaseUrl } : {}),
      ...(providerType ? { providerType } : {}),
    };
    await createClassroomGenerationJob(jobId, generateInput);
    await attachClassroomJobToLearningTask({
      teacherId: user.id,
      generationTaskId: generationTask.id,
      classroomJobId: jobId,
    });

    const baseUrl = buildRequestOrigin(req);
    after(() => runClassroomGenerationJob(jobId, generateInput, baseUrl));

    return apiSuccess(
      {
        generationTaskId: generationTask.id,
        classroomJobId: jobId,
        status: 'started',
        launchUrl: `/api/generate-classroom/${jobId}`,
        progressViewUrl: `/generation-preview?jobId=${jobId}&from=teacher`,
        context: generationTask.launchContext,
        modelString: resolvedModel.modelString,
        providerId: resolvedModel.providerId,
      },
      202,
    );
  } catch (error) {
    log.error(`Failed to start lesson generation [lessonId=${lessonId || 'unknown'}]`, error);
    if (error instanceof z.ZodError) {
      return apiError('INVALID_REQUEST', 400, error.issues[0]?.message || 'Invalid request');
    }
    return mapLearningDomainError(error);
  }
}
