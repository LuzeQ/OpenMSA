import { apiError, apiSuccess } from '@/lib/server/api-response';
import { getCurrentUserFromSession } from '@/lib/server/auth/current-user';
import { getLearningSyllabusAnalytics } from '@/lib/server/learning-store';
import { ensureTeacherOrAdmin, mapLearningDomainError } from '@/app/api/learning/utils';

export async function GET(
  _req: Request,
  context: { params: Promise<{ syllabusId: string }> },
) {
  try {
    const user = await getCurrentUserFromSession();
    if (!user) {
      return apiError('INVALID_REQUEST', 401, 'Authentication required');
    }
    if (!ensureTeacherOrAdmin(user.role)) {
      return apiError('INVALID_REQUEST', 403, 'Permission denied');
    }

    const { syllabusId } = await context.params;
    const analytics = await getLearningSyllabusAnalytics({
      teacherId: user.id,
      programId: syllabusId,
    });
    return apiSuccess({
      summary: analytics.summary,
      lessons: analytics.lessons,
    });
  } catch (error) {
    return mapLearningDomainError(error);
  }
}
