import { z } from 'zod';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { getCurrentUserFromSession } from '@/lib/server/auth/current-user';
import {
  bindLearningLessonClassroom,
  bindLearningLessonClassroomFromGenerationTask,
  getLearningLessonGenerationTask,
  getLearningProgramDetailByLesson,
} from '@/lib/server/learning-store';
import { ensureTeacherOrAdmin, mapLearningDomainError } from '@/app/api/learning/utils';

const bodySchema = z.object({
  classroomId: z.string().max(120).optional(),
  generationTaskId: z.string().optional(),
});

export async function POST(
  req: Request,
  context: { params: Promise<{ lessonId: string }> },
) {
  try {
    const user = await getCurrentUserFromSession();
    if (!user) {
      return apiError('INVALID_REQUEST', 401, 'Authentication required');
    }
    if (!ensureTeacherOrAdmin(user.role)) {
      return apiError('INVALID_REQUEST', 403, 'Permission denied');
    }

    const { lessonId } = await context.params;
    const body = bodySchema.parse(await req.json());

    if (body.classroomId === undefined && !body.generationTaskId) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing classroomId or generationTaskId');
    }

    const boundAt = new Date().toISOString();

    if (body.generationTaskId) {
      const task = await getLearningLessonGenerationTask({
        teacherId: user.id,
        generationTaskId: body.generationTaskId,
      });
      if (task.lessonId !== lessonId) {
        return apiError('INVALID_REQUEST', 400, 'generationTaskId does not match lesson');
      }

      const { program, task: updatedTask } = await bindLearningLessonClassroomFromGenerationTask({
        teacherId: user.id,
        generationTaskId: body.generationTaskId,
        classroomId: body.classroomId,
      });
      const found = program.chapters
        .flatMap((chapter) => chapter.lessons)
        .find((lesson) => lesson.id === lessonId);

      return apiSuccess({
        lessonId,
        classroomId: updatedTask.resultClassroomId,
        generationStatus: found?.generationStatus || 'succeeded',
        boundAt,
      });
    }

    const detail = await getLearningProgramDetailByLesson({
      teacherId: user.id,
      lessonId,
    });
    const program = await bindLearningLessonClassroom({
      teacherId: user.id,
      programId: detail.program.id,
      lessonId,
      classroomId: body.classroomId,
      generationStatus: body.classroomId ? 'succeeded' : 'not_started',
    });
    const found = program.chapters
      .flatMap((chapter) => chapter.lessons)
      .find((lesson) => lesson.id === lessonId);

    return apiSuccess({
      lessonId,
      classroomId: found?.classroomId || null,
      generationStatus: found?.generationStatus || 'not_started',
      boundAt,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return apiError('INVALID_REQUEST', 400, error.issues[0]?.message || 'Invalid request');
    }
    return mapLearningDomainError(error);
  }
}
