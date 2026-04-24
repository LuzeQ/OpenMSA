import { createLogger } from '@/lib/logger';
import { generateClassroom, type GenerateClassroomInput } from '@/lib/server/classroom-generation';
import {
  markClassroomGenerationJobFailed,
  markClassroomGenerationJobRunning,
  markClassroomGenerationJobSucceeded,
  readClassroomGenerationJob,
  saveClassroomGenerationCheckpoint,
  updateClassroomGenerationJobProgress,
} from '@/lib/server/classroom-job-store';

const log = createLogger('ClassroomJob');
const runningJobs = new Map<string, Promise<void>>();

function stringifyUnknown(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncate(text: string, max = 600): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

function buildFailureMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return truncate(String(error));
  }

  const chunks: string[] = [];
  if (error.message) {
    chunks.push(error.message);
  }

  const errorLike = error as Error & {
    statusCode?: number;
    status?: number;
    responseBody?: unknown;
    responseText?: string;
    data?: unknown;
    cause?: unknown;
  };

  const status = errorLike.statusCode ?? errorLike.status;
  if (typeof status === 'number') {
    chunks.push(`status=${status}`);
  }

  const responsePayload =
    errorLike.responseText || stringifyUnknown(errorLike.responseBody) || stringifyUnknown(errorLike.data);
  if (responsePayload) {
    chunks.push(`response=${truncate(responsePayload, 400)}`);
  }

  let cause = errorLike.cause;
  let depth = 0;
  while (cause && depth < 4) {
    if (cause instanceof Error) {
      const causeLike = cause as Error & { statusCode?: number; status?: number; responseBody?: unknown };
      const causeStatus = causeLike.statusCode ?? causeLike.status;
      const causeStatusText = typeof causeStatus === 'number' ? ` status=${causeStatus}` : '';
      const causeBody = stringifyUnknown(causeLike.responseBody);
      const causeBodyText = causeBody ? ` response=${truncate(causeBody, 300)}` : '';
      chunks.push(`cause=${cause.message}${causeStatusText}${causeBodyText}`);
      cause = causeLike.cause;
    } else {
      chunks.push(`cause=${truncate(stringifyUnknown(cause), 300)}`);
      break;
    }
    depth += 1;
  }

  return truncate(chunks.filter(Boolean).join(' | '));
}

export function runClassroomGenerationJob(
  jobId: string,
  input: GenerateClassroomInput,
  baseUrl: string,
): Promise<void> {
  const existing = runningJobs.get(jobId);
  if (existing) {
    return existing;
  }

  const jobPromise = (async () => {
    try {
      const existingJob = await readClassroomGenerationJob(jobId);
      const resumeCheckpoint = existingJob?.checkpoint;
      await markClassroomGenerationJobRunning(jobId);

      const result = await generateClassroom(input, {
        baseUrl,
        onProgress: async (progress) => {
          await updateClassroomGenerationJobProgress(jobId, progress);
        },
        onCheckpoint: async (checkpoint) => {
          await saveClassroomGenerationCheckpoint(jobId, checkpoint);
        },
        resumeCheckpoint,
      });

      await markClassroomGenerationJobSucceeded(jobId, result);
    } catch (error) {
      const message = buildFailureMessage(error);
      log.error(`Classroom generation job ${jobId} failed:`, error);
      try {
        await markClassroomGenerationJobFailed(jobId, message);
      } catch (markFailedError) {
        log.error(`Failed to persist failed status for job ${jobId}:`, markFailedError);
      }
    } finally {
      runningJobs.delete(jobId);
    }
  })();

  runningJobs.set(jobId, jobPromise);
  return jobPromise;
}
