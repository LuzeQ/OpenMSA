import { apiError, apiSuccess } from '@/lib/server/api-response';
import { getCurrentUserFromSession } from '@/lib/server/auth/current-user';
import {
  getLearningLessonGenerationTask,
  syncLearningLessonGenerationTask,
} from '@/lib/server/learning-store';
import { readClassroomGenerationJob } from '@/lib/server/classroom-job-store';
import { ensureTeacherOrAdmin, mapLearningDomainError } from '@/app/api/learning/utils';

export async function GET(
  _req: Request,
  context: { params: Promise<{ generationTaskId: string }> },
) {
  try {
    const user = await getCurrentUserFromSession();
    if (!user) {
      return apiError('INVALID_REQUEST', 401, 'Authentication required');
    }
    if (!ensureTeacherOrAdmin(user.role)) {
      return apiError('INVALID_REQUEST', 403, 'Permission denied');
    }

    const { generationTaskId } = await context.params;
    let task = await getLearningLessonGenerationTask({
      teacherId: user.id,
      generationTaskId,
    });
    let classroomJob = null as Awaited<ReturnType<typeof readClassroomGenerationJob>> | null;

    if (task.classroomJobId) {
      const job = await readClassroomGenerationJob(task.classroomJobId);
      if (job) {
        classroomJob = job;
        if (
          (job.status === 'queued' || job.status === 'running') &&
          task.status !== 'binding_pending' &&
          task.status !== 'succeeded'
        ) {
          task = await syncLearningLessonGenerationTask({
            teacherId: user.id,
            generationTaskId: task.id,
            status: 'processing',
          });
        } else if (job.status === 'failed' && task.status !== 'failed') {
          task = await syncLearningLessonGenerationTask({
            teacherId: user.id,
            generationTaskId: task.id,
            status: 'failed',
            errorCode: 'GENERATION_FAILED',
            errorMessage: job.error || 'Lesson generation failed',
          });
        } else if (
          job.status === 'succeeded' &&
          task.status !== 'binding_pending' &&
          task.status !== 'succeeded'
        ) {
          task = await syncLearningLessonGenerationTask({
            teacherId: user.id,
            generationTaskId: task.id,
            status: 'binding_pending',
            resultClassroomId: job.result?.classroomId,
            resultPreviewUrl: job.result?.url,
          });
        }
      }
    }

    return apiSuccess({
      generationTaskId: task.id,
      status: task.status,
      previewUrl: task.resultPreviewUrl || null,
      classroomId: task.resultClassroomId || null,
      classroomJobId: task.classroomJobId || null,
      lessonId: task.lessonId,
      classroomJob: classroomJob
        ? {
            id: classroomJob.id,
            status: classroomJob.status,
            step: classroomJob.step,
            progress: classroomJob.progress,
            message: classroomJob.message,
            scenesGenerated: classroomJob.scenesGenerated,
            totalScenes: classroomJob.totalScenes ?? null,
            result: classroomJob.result || null,
            error: classroomJob.error || null,
            canResume:
              classroomJob.status === 'failed' &&
              Boolean(classroomJob.resumeInput?.requirement?.trim()),
            resumedScenes: classroomJob.checkpoint?.completedSceneIndexes.length || 0,
            done: classroomJob.status === 'succeeded' || classroomJob.status === 'failed',
          }
        : null,
      error: task.errorMessage
        ? {
            code: task.errorCode || 'GENERATION_FAILED',
            message: task.errorMessage,
          }
        : null,
    });
  } catch (error) {
    return mapLearningDomainError(error);
  }
}
