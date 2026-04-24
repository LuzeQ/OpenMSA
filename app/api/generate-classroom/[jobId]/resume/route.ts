import { after, type NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { runClassroomGenerationJob } from '@/lib/server/classroom-job-runner';
import {
  isValidClassroomJobId,
  readClassroomGenerationJob,
  resetClassroomGenerationJobForResume,
} from '@/lib/server/classroom-job-store';
import type { GenerateClassroomInput } from '@/lib/server/classroom-generation';
import { buildRequestOrigin } from '@/lib/server/classroom-storage';
import { createLogger } from '@/lib/logger';
import type { ImageProviderId, VideoProviderId } from '@/lib/media/types';

const log = createLogger('ClassroomJobResume API');

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

export async function POST(req: NextRequest, context: { params: Promise<{ jobId: string }> }) {
  let resolvedJobId: string | undefined;
  try {
    const { jobId } = await context.params;
    resolvedJobId = jobId;

    if (!isValidClassroomJobId(jobId)) {
      return apiError('INVALID_REQUEST', 400, 'Invalid classroom generation job id');
    }

    const existing = await readClassroomGenerationJob(jobId);
    if (!existing) {
      return apiError('INVALID_REQUEST', 404, 'Classroom generation job not found');
    }
    if (existing.status === 'queued' || existing.status === 'running') {
      return apiError('INVALID_REQUEST', 409, 'Classroom generation job is already running');
    }
    if (existing.status !== 'failed') {
      return apiError('INVALID_REQUEST', 409, 'Only failed jobs can be resumed');
    }
    if (!existing.resumeInput?.requirement?.trim()) {
      return apiError(
        'INVALID_REQUEST',
        409,
        'This job does not contain resumable input. Please start a new generation.',
      );
    }

    const modelString = req.headers.get('x-model') || undefined;
    const apiKey = req.headers.get('x-api-key') || undefined;
    const baseUrl = req.headers.get('x-base-url') || undefined;
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
    const inputOverride: Partial<GenerateClassroomInput> = {
      ...(modelString ? { modelString } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      ...(providerType ? { providerType } : {}),
      ...(apiKey ? { apiKey } : {}),
      enableImageGeneration,
      enableVideoGeneration,
      richnessPolicy: {
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
      },
      ...(Object.keys(mediaConfig).length > 0 ? { mediaConfig } : {}),
    };

    const resetJob = await resetClassroomGenerationJobForResume(jobId, inputOverride);
    const runInput: GenerateClassroomInput = {
      ...resetJob.resumeInput,
      ...(apiKey ? { apiKey } : {}),
      ...(Object.keys(mediaConfig).length > 0
        ? {
            mediaConfig: {
              ...(resetJob.resumeInput.mediaConfig || {}),
              ...mediaConfig,
            },
          }
        : {}),
    };

    const origin = buildRequestOrigin(req);
    after(() => runClassroomGenerationJob(jobId, runInput, origin));

    return apiSuccess(
      {
        jobId,
        status: 'started',
        step: resetJob.step,
        message: resetJob.message,
        pollUrl: `${origin}/api/generate-classroom/${jobId}`,
        pollIntervalMs: 5000,
        resumedScenes: resetJob.scenesGenerated,
        totalScenes: resetJob.totalScenes,
      },
      202,
    );
  } catch (error) {
    log.error(`Failed to resume classroom generation [jobId=${resolvedJobId ?? 'unknown'}]:`, error);
    return apiError(
      'INTERNAL_ERROR',
      500,
      'Failed to resume classroom generation',
      error instanceof Error ? error.message : String(error),
    );
  }
}
