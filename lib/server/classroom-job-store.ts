import { promises as fs } from 'fs';
import path from 'path';
import type {
  ClassroomGenerationCheckpoint,
  ClassroomGenerationProgress,
  ClassroomGenerationStep,
  GenerateClassroomInput,
  GenerateClassroomResult,
} from '@/lib/server/classroom-generation';
import {
  CLASSROOM_JOBS_DIR,
  ensureClassroomJobsDir,
  writeJsonFileAtomic,
} from '@/lib/server/classroom-storage';

export type ClassroomGenerationJobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface ClassroomGenerationJob {
  id: string;
  status: ClassroomGenerationJobStatus;
  step: ClassroomGenerationStep | 'queued' | 'failed';
  progress: number;
  message: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  inputSummary: {
    requirementPreview: string;
    language?: string;
    hasPdf: boolean;
    pdfTextLength: number;
    pdfImageCount: number;
    enableImageGeneration?: boolean;
    enableVideoGeneration?: boolean;
    imageProviderId?: string;
    imageModel?: string;
    videoProviderId?: string;
    videoModel?: string;
    minImages?: number;
    minVideos?: number;
    minInteractive?: number;
  };
  scenesGenerated: number;
  totalScenes?: number;
  attemptCount: number;
  resumeInput: GenerateClassroomInput;
  checkpoint?: ClassroomGenerationCheckpoint;
  result?: {
    classroomId: string;
    url: string;
    scenesCount: number;
  };
  error?: string;
}

function jobFilePath(jobId: string) {
  return path.join(CLASSROOM_JOBS_DIR, `${jobId}.json`);
}

function buildInputSummary(input: GenerateClassroomInput): ClassroomGenerationJob['inputSummary'] {
  return {
    requirementPreview:
      input.requirement.length > 200 ? `${input.requirement.slice(0, 197)}...` : input.requirement,
    hasPdf: !!input.pdfContent,
    pdfTextLength: input.pdfContent?.text.length || 0,
    pdfImageCount: input.pdfContent?.images.length || 0,
    ...(input.enableImageGeneration != null
      ? { enableImageGeneration: input.enableImageGeneration }
      : {}),
    ...(input.enableVideoGeneration != null
      ? { enableVideoGeneration: input.enableVideoGeneration }
      : {}),
    ...(input.mediaConfig?.image?.providerId
      ? { imageProviderId: input.mediaConfig.image.providerId }
      : {}),
    ...(input.mediaConfig?.image?.model ? { imageModel: input.mediaConfig.image.model } : {}),
    ...(input.mediaConfig?.video?.providerId
      ? { videoProviderId: input.mediaConfig.video.providerId }
      : {}),
    ...(input.mediaConfig?.video?.model ? { videoModel: input.mediaConfig.video.model } : {}),
    ...(typeof input.richnessPolicy?.minImages === 'number'
      ? { minImages: input.richnessPolicy.minImages }
      : {}),
    ...(typeof input.richnessPolicy?.minVideos === 'number'
      ? { minVideos: input.richnessPolicy.minVideos }
      : {}),
    ...(typeof input.richnessPolicy?.minInteractive === 'number'
      ? { minInteractive: input.richnessPolicy.minInteractive }
      : {}),
  };
}

function buildResumeInput(input: GenerateClassroomInput): GenerateClassroomInput {
  const sanitizedMediaConfig = input.mediaConfig
    ? {
        ...(input.mediaConfig.image
          ? {
              image: {
                ...(input.mediaConfig.image.providerId
                  ? { providerId: input.mediaConfig.image.providerId }
                  : {}),
                ...(input.mediaConfig.image.model ? { model: input.mediaConfig.image.model } : {}),
                ...(input.mediaConfig.image.baseUrl ? { baseUrl: input.mediaConfig.image.baseUrl } : {}),
              },
            }
          : {}),
        ...(input.mediaConfig.video
          ? {
              video: {
                ...(input.mediaConfig.video.providerId
                  ? { providerId: input.mediaConfig.video.providerId }
                  : {}),
                ...(input.mediaConfig.video.model ? { model: input.mediaConfig.video.model } : {}),
                ...(input.mediaConfig.video.baseUrl ? { baseUrl: input.mediaConfig.video.baseUrl } : {}),
              },
            }
          : {}),
      }
    : undefined;

  return {
    requirement: input.requirement,
    ...(input.pdfContent
      ? {
          // Keep text context for resume; images are not used by classroom generation pipeline.
          pdfContent: {
            text: input.pdfContent.text,
            images: [],
          },
        }
      : {}),
    ...(input.language ? { language: input.language } : {}),
    ...(input.modelString ? { modelString: input.modelString } : {}),
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    ...(input.providerType ? { providerType: input.providerType } : {}),
    ...(input.enableWebSearch != null ? { enableWebSearch: input.enableWebSearch } : {}),
    ...(input.enableImageGeneration != null
      ? { enableImageGeneration: input.enableImageGeneration }
      : {}),
    ...(input.enableVideoGeneration != null
      ? { enableVideoGeneration: input.enableVideoGeneration }
      : {}),
    ...(input.enableTTS != null ? { enableTTS: input.enableTTS } : {}),
    ...(input.agentMode ? { agentMode: input.agentMode } : {}),
    ...(sanitizedMediaConfig ? { mediaConfig: sanitizedMediaConfig } : {}),
    ...(input.richnessPolicy
      ? {
          richnessPolicy: {
            ...(typeof input.richnessPolicy.minImages === 'number'
              ? { minImages: input.richnessPolicy.minImages }
              : {}),
            ...(typeof input.richnessPolicy.minVideos === 'number'
              ? { minVideos: input.richnessPolicy.minVideos }
              : {}),
            ...(typeof input.richnessPolicy.minInteractive === 'number'
              ? { minInteractive: input.richnessPolicy.minInteractive }
              : {}),
            ...(input.richnessPolicy.interactiveDepth
              ? { interactiveDepth: input.richnessPolicy.interactiveDepth }
              : {}),
          },
        }
      : {}),
  };
}

/** Simple per-job mutex to serialize read-modify-write on the same job file. */
const jobLocks = new Map<string, Promise<void>>();

async function withJobLock<T>(jobId: string, fn: () => Promise<T>): Promise<T> {
  const prev = jobLocks.get(jobId) ?? Promise.resolve();
  let resolve: () => void;
  const next = new Promise<void>((r) => {
    resolve = r;
  });
  jobLocks.set(jobId, next);
  try {
    await prev;
    return await fn();
  } finally {
    resolve!();
    if (jobLocks.get(jobId) === next) jobLocks.delete(jobId);
  }
}

/** Max age (ms) before a "running" job without an active runner is considered stale. */
const STALE_JOB_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

function markStaleIfNeeded(job: ClassroomGenerationJob): ClassroomGenerationJob {
  if (job.status !== 'running') return job;
  const updatedAt = new Date(job.updatedAt).getTime();
  if (Date.now() - updatedAt > STALE_JOB_TIMEOUT_MS) {
    return {
      ...job,
      status: 'failed',
      step: 'failed',
      message: 'Job appears stale (no progress update for 30 minutes)',
      error: 'Stale job: process may have restarted during generation',
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  return job;
}

function normalizeJob(raw: Partial<ClassroomGenerationJob>): ClassroomGenerationJob {
  const resumeInput =
    raw.resumeInput && typeof raw.resumeInput.requirement === 'string'
      ? raw.resumeInput
      : {
          requirement: raw.inputSummary?.requirementPreview || '',
          language: raw.inputSummary?.language || 'zh-CN',
        };

  return {
    id: raw.id || '',
    status: raw.status || 'queued',
    step: raw.step || 'queued',
    progress: typeof raw.progress === 'number' ? raw.progress : 0,
    message: raw.message || '',
    createdAt: raw.createdAt || new Date().toISOString(),
    updatedAt: raw.updatedAt || raw.createdAt || new Date().toISOString(),
    startedAt: raw.startedAt,
    completedAt: raw.completedAt,
    inputSummary: {
      requirementPreview: raw.inputSummary?.requirementPreview || '',
      language: raw.inputSummary?.language || 'zh-CN',
      hasPdf: Boolean(raw.inputSummary?.hasPdf),
      pdfTextLength: raw.inputSummary?.pdfTextLength || 0,
      pdfImageCount: raw.inputSummary?.pdfImageCount || 0,
      ...(raw.inputSummary?.enableImageGeneration != null
        ? { enableImageGeneration: raw.inputSummary.enableImageGeneration }
        : {}),
      ...(raw.inputSummary?.enableVideoGeneration != null
        ? { enableVideoGeneration: raw.inputSummary.enableVideoGeneration }
        : {}),
      ...(raw.inputSummary?.imageProviderId ? { imageProviderId: raw.inputSummary.imageProviderId } : {}),
      ...(raw.inputSummary?.imageModel ? { imageModel: raw.inputSummary.imageModel } : {}),
      ...(raw.inputSummary?.videoProviderId ? { videoProviderId: raw.inputSummary.videoProviderId } : {}),
      ...(raw.inputSummary?.videoModel ? { videoModel: raw.inputSummary.videoModel } : {}),
      ...(typeof raw.inputSummary?.minImages === 'number' ? { minImages: raw.inputSummary.minImages } : {}),
      ...(typeof raw.inputSummary?.minVideos === 'number' ? { minVideos: raw.inputSummary.minVideos } : {}),
      ...(typeof raw.inputSummary?.minInteractive === 'number'
        ? { minInteractive: raw.inputSummary.minInteractive }
        : {}),
    },
    scenesGenerated: typeof raw.scenesGenerated === 'number' ? raw.scenesGenerated : 0,
    totalScenes: raw.totalScenes,
    attemptCount: typeof raw.attemptCount === 'number' ? raw.attemptCount : 0,
    resumeInput,
    checkpoint: raw.checkpoint,
    result: raw.result,
    error: raw.error,
  };
}

export function isValidClassroomJobId(jobId: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(jobId);
}

export async function createClassroomGenerationJob(
  jobId: string,
  input: GenerateClassroomInput,
): Promise<ClassroomGenerationJob> {
  const now = new Date().toISOString();
  const job: ClassroomGenerationJob = {
    id: jobId,
    status: 'queued',
    step: 'queued',
    progress: 0,
    message: 'Classroom generation job queued',
    createdAt: now,
    updatedAt: now,
    inputSummary: buildInputSummary(input),
    scenesGenerated: 0,
    attemptCount: 0,
    resumeInput: buildResumeInput(input),
  };

  await ensureClassroomJobsDir();
  await writeJsonFileAtomic(jobFilePath(jobId), job);
  return job;
}

export async function readClassroomGenerationJob(
  jobId: string,
): Promise<ClassroomGenerationJob | null> {
  try {
    const content = await fs.readFile(jobFilePath(jobId), 'utf-8');
    const job = normalizeJob(JSON.parse(content) as Partial<ClassroomGenerationJob>);
    return markStaleIfNeeded(job);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function updateClassroomGenerationJob(
  jobId: string,
  patch: Partial<ClassroomGenerationJob>,
): Promise<ClassroomGenerationJob> {
  return withJobLock(jobId, async () => {
    const existing = await readClassroomGenerationJob(jobId);
    if (!existing) {
      throw new Error(`Classroom generation job not found: ${jobId}`);
    }

    const updated: ClassroomGenerationJob = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    };

    await writeJsonFileAtomic(jobFilePath(jobId), updated);
    return updated;
  });
}

export async function markClassroomGenerationJobRunning(
  jobId: string,
): Promise<ClassroomGenerationJob> {
  return withJobLock(jobId, async () => {
    const existing = await readClassroomGenerationJob(jobId);
    if (!existing) {
      throw new Error(`Classroom generation job not found: ${jobId}`);
    }

    const updated: ClassroomGenerationJob = {
      ...existing,
      status: 'running',
      startedAt: existing.startedAt || new Date().toISOString(),
      message: 'Classroom generation started',
      progress: Math.max(existing.progress || 0, 1),
      attemptCount: (existing.attemptCount || 0) + 1,
      completedAt: undefined,
      error: undefined,
      updatedAt: new Date().toISOString(),
    };

    await writeJsonFileAtomic(jobFilePath(jobId), updated);
    return updated;
  });
}

export async function updateClassroomGenerationJobProgress(
  jobId: string,
  progress: ClassroomGenerationProgress,
): Promise<ClassroomGenerationJob> {
  return updateClassroomGenerationJob(jobId, {
    status: 'running',
    step: progress.step,
    progress: progress.progress,
    message: progress.message,
    scenesGenerated: progress.scenesGenerated,
    totalScenes: progress.totalScenes,
  });
}

export async function markClassroomGenerationJobSucceeded(
  jobId: string,
  result: GenerateClassroomResult,
): Promise<ClassroomGenerationJob> {
  return updateClassroomGenerationJob(jobId, {
    status: 'succeeded',
    step: 'completed',
    progress: 100,
    message: 'Classroom generation completed',
    completedAt: new Date().toISOString(),
    scenesGenerated: result.scenesCount,
    error: undefined,
    checkpoint: undefined,
    result: {
      classroomId: result.id,
      url: result.url,
      scenesCount: result.scenesCount,
    },
  });
}

export async function markClassroomGenerationJobFailed(
  jobId: string,
  error: string,
): Promise<ClassroomGenerationJob> {
  return updateClassroomGenerationJob(jobId, {
    status: 'failed',
    step: 'failed',
    message: 'Classroom generation failed',
    completedAt: new Date().toISOString(),
    error,
  });
}

export async function saveClassroomGenerationCheckpoint(
  jobId: string,
  checkpoint: ClassroomGenerationCheckpoint,
): Promise<ClassroomGenerationJob> {
  return updateClassroomGenerationJob(jobId, {
    checkpoint,
    totalScenes: checkpoint.outlines.length,
    scenesGenerated: checkpoint.completedSceneIndexes.length,
  });
}

export async function resetClassroomGenerationJobForResume(
  jobId: string,
  inputOverride?: Partial<GenerateClassroomInput>,
): Promise<ClassroomGenerationJob> {
  return withJobLock(jobId, async () => {
    const existing = await readClassroomGenerationJob(jobId);
    if (!existing) {
      throw new Error(`Classroom generation job not found: ${jobId}`);
    }

    const mergedResumeInput = {
      ...existing.resumeInput,
      ...(inputOverride || {}),
    } satisfies GenerateClassroomInput;
    const resumeInput = buildResumeInput(mergedResumeInput);
    if (!resumeInput.requirement?.trim()) {
      throw new Error('Classroom generation job has no resumable input payload');
    }
    const checkpoint = existing.checkpoint;
    const resumedScenes = checkpoint?.completedSceneIndexes.length || 0;
    const totalScenes = checkpoint?.outlines.length || existing.totalScenes;
    const resumeProgress =
      typeof totalScenes === 'number' && totalScenes > 0
        ? Math.max(31, Math.min(90, 30 + Math.floor((resumedScenes / totalScenes) * 60)))
        : 1;

    const updated: ClassroomGenerationJob = {
      ...existing,
      status: 'queued',
      step: checkpoint ? 'generating_scenes' : 'queued',
      progress: resumeProgress,
      message: checkpoint
        ? `Resume queued (${resumedScenes}/${totalScenes || 0} scenes completed)`
        : 'Resume queued',
      updatedAt: new Date().toISOString(),
      completedAt: undefined,
      error: undefined,
      result: undefined,
      resumeInput,
      scenesGenerated: resumedScenes,
      totalScenes,
    };

    await writeJsonFileAtomic(jobFilePath(jobId), updated);
    return updated;
  });
}
