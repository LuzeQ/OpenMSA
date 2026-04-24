import { z } from 'zod';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { getCurrentUserFromSession } from '@/lib/server/auth/current-user';
import { createLearningProgram } from '@/lib/server/learning-store';
import { ensureTeacherOrAdmin, mapLearningDomainError } from '@/app/api/learning/utils';

const lessonInputSchema = z.object({
  id: z.string().optional(),
  title: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  learningObjectives: z.array(z.string().min(1).max(120)).optional(),
  prerequisites: z.array(z.string().min(1).max(120)).optional(),
  difficulty: z.enum(['basic', 'intermediate', 'advanced']).optional(),
  diagnosticTags: z.array(z.string().min(1).max(60)).optional(),
  classroomId: z.string().max(120).optional(),
});

const chapterInputSchema = z.object({
  id: z.string().optional(),
  title: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  lessons: z.array(lessonInputSchema).min(1).max(20),
});

const requestSchema = z.object({
  title: z.string().min(1).max(120),
  description: z.string().max(600).optional(),
  targetAudience: z.string().max(200).optional(),
  source: z.enum(['manual', 'ai_generated', 'mixed']).optional(),
  status: z.enum(['draft', 'published', 'archived']).optional(),
  chapters: z.array(chapterInputSchema).min(1).max(20),
});

export async function POST(req: Request) {
  try {
    const user = await getCurrentUserFromSession();
    if (!user) {
      return apiError('INVALID_REQUEST', 401, 'Authentication required');
    }
    if (!ensureTeacherOrAdmin(user.role)) {
      return apiError('INVALID_REQUEST', 403, 'Permission denied');
    }

    const body = requestSchema.parse(await req.json());

    const program = await createLearningProgram({
      teacherId: user.id,
      teacherUsername: user.username,
      title: body.title,
      description: body.description,
      targetAudience: body.targetAudience,
      source: body.source,
      status: body.status,
      chapters: body.chapters.map((chapter) => ({
        id: chapter.id,
        title: chapter.title,
        description: chapter.description,
        lessons: chapter.lessons.map((lesson) => ({
          id: lesson.id,
          title: lesson.title,
          description: lesson.description,
          learningObjectives: lesson.learningObjectives,
          prerequisites: lesson.prerequisites,
          difficulty: lesson.difficulty,
          diagnosticTags: lesson.diagnosticTags,
          classroomId: lesson.classroomId,
        })),
      })),
    });

    return apiSuccess(
      {
        syllabusId: program.id,
        status: program.status,
        chapters: program.chapters.map((chapter) => ({
          chapterId: chapter.id,
          lessons: chapter.lessons.map((lesson) => ({
            lessonId: lesson.id,
            generationStatus: lesson.generationStatus,
            classroomId: lesson.classroomId || null,
          })),
        })),
        syllabus: program,
      },
      201,
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      return apiError('INVALID_REQUEST', 400, error.issues[0]?.message || 'Invalid request');
    }
    return mapLearningDomainError(error);
  }
}
