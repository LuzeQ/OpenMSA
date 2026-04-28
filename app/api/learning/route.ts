import { apiError, apiSuccess } from '@/lib/server/api-response';
import { getCurrentUserFromSession } from '@/lib/server/auth/current-user';
import {
  acceptLearningAssignment,
  applyLearningProgram,
  assignLearningCourse,
  assignLearningProgramToStudents,
  bindLearningLessonClassroom,
  createLearningCourse,
  createLearningProgram,
  getStudentLearningView,
  getTeacherLearningView,
  prepublishLearningProgram,
  publishLearningCourse,
  publishLearningProgram,
  recordLearningLessonMetrics,
  reportLearningStuckPoint,
  resolveLearningRiskSignal,
  resolveLearningStuckPoint,
  reviewLearningApplication,
  submitLearningQuizResult,
  updateLearningLessonStatus,
  updateLearningProgramStructure,
  upsertLearningStudentProfile,
} from '@/lib/server/learning-store';
import type { LearningLessonProgressStatus } from '@/lib/types/learning';
import { mapLearningDomainError, ensureTeacherOrAdmin } from './utils';

export async function GET(request: Request) {
  const user = await getCurrentUserFromSession();
  if (!user) {
    return apiError('INVALID_REQUEST', 401, 'Authentication required');
  }

  const url = new URL(request.url);
  const view = url.searchParams.get('view');

  try {
    if (view === 'teacher') {
      const data = await getTeacherLearningView(user);
      return apiSuccess({ data });
    }

    if (view === 'student') {
      const data = await getStudentLearningView(user);
      return apiSuccess({ data });
    }

    return apiError('INVALID_REQUEST', 400, 'Missing or invalid query parameter: view');
  } catch (error) {
    return mapLearningDomainError(error);
  }
}

type LearningAction =
  | 'create_program'
  | 'update_program_structure'
  | 'bind_lesson_classroom'
  | 'prepublish_check'
  | 'publish_program'
  | 'assign_program_to_students'
  | 'apply_program'
  | 'review_application'
  | 'accept_assignment'
  | 'update_lesson_status'
  | 'record_lesson_metrics'
  | 'submit_quiz_result'
  | 'report_stuck'
  | 'resolve_stuck'
  | 'resolve_risk'
  | 'upsert_student_profile'
  | 'create_course'
  | 'publish_course'
  | 'assign_course'
  | 'update_lesson';

interface ActionLessonInput {
  id?: string;
  title?: string;
  description?: string;
  classroomId?: string;
}

interface ActionChapterInput {
  id?: string;
  title?: string;
  description?: string;
  lessons?: ActionLessonInput[];
}

interface ActionBody {
  action?: LearningAction;
  title?: string;
  description?: string;
  moduleTitle?: string;
  lessonLines?: string[];
  chapters?: ActionChapterInput[];
  courseId?: string;
  programId?: string;
  lessonId?: string;
  classroomId?: string;
  confirmPublish?: boolean;
  studentIds?: string[];
  applicationId?: string;
  decision?: 'approved' | 'rejected';
  reviewNote?: string;
  assignmentId?: string;
  status?: LearningLessonProgressStatus;
  studySecondsDelta?: number;
  pauseSecondsDelta?: number;
  replaySecondsDelta?: number;
  replayCountDelta?: number;
  aiQuestion?: string;
  aiQuestions?: string[];
  attempts?: number;
  correct?: number;
  note?: string;
  stuckId?: string;
  riskKey?: string;
  goals?: unknown;
  preferences?: unknown;
  weaknesses?: unknown;
}

function normalizeChapters(chapters: ActionChapterInput[] | undefined) {
  if (!Array.isArray(chapters)) return [];

  return chapters.map((chapter) => ({
    id: chapter.id,
    title: chapter.title?.trim() || '',
    description: chapter.description || '',
    lessons: Array.isArray(chapter.lessons)
      ? chapter.lessons.map((lesson) => ({
          id: lesson.id,
          title: lesson.title?.trim() || '',
          description: lesson.description || '',
          classroomId: lesson.classroomId,
        }))
      : [],
  }));
}

export async function POST(request: Request) {
  const user = await getCurrentUserFromSession();
  if (!user) {
    return apiError('INVALID_REQUEST', 401, 'Authentication required');
  }

  let body: ActionBody;
  try {
    body = (await request.json()) as ActionBody;
  } catch {
    return apiError('INVALID_REQUEST', 400, 'Invalid JSON body');
  }

  const action = body.action;
  if (!action) {
    return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing required field: action');
  }

  try {
    switch (action) {
      case 'create_program': {
        if (!ensureTeacherOrAdmin(user.role)) {
          return apiError('INVALID_REQUEST', 403, 'Permission denied');
        }
        if (!body.title) {
          return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing title');
        }

        const program = await createLearningProgram({
          teacherId: user.id,
          teacherUsername: user.username,
          title: body.title,
          description: body.description,
          chapters: normalizeChapters(body.chapters),
        });

        return apiSuccess({ program }, 201);
      }

      case 'update_program_structure': {
        if (!ensureTeacherOrAdmin(user.role)) {
          return apiError('INVALID_REQUEST', 403, 'Permission denied');
        }
        if (!body.programId || !Array.isArray(body.chapters)) {
          return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing programId or chapters');
        }

        const program = await updateLearningProgramStructure({
          teacherId: user.id,
          programId: body.programId,
          title: body.title,
          description: body.description,
          chapters: normalizeChapters(body.chapters),
        });

        return apiSuccess({ program });
      }

      case 'bind_lesson_classroom': {
        if (!ensureTeacherOrAdmin(user.role)) {
          return apiError('INVALID_REQUEST', 403, 'Permission denied');
        }
        if (!body.programId || !body.lessonId) {
          return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing programId or lessonId');
        }

        const program = await bindLearningLessonClassroom({
          teacherId: user.id,
          programId: body.programId,
          lessonId: body.lessonId,
          classroomId: body.classroomId,
        });

        return apiSuccess({ program });
      }

      case 'prepublish_check': {
        if (!ensureTeacherOrAdmin(user.role)) {
          return apiError('INVALID_REQUEST', 403, 'Permission denied');
        }
        if (!body.programId) {
          return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing programId');
        }

        const warnings = await prepublishLearningProgram({
          teacherId: user.id,
          programId: body.programId,
        });

        return apiSuccess({ warnings });
      }

      case 'publish_program': {
        if (!ensureTeacherOrAdmin(user.role)) {
          return apiError('INVALID_REQUEST', 403, 'Permission denied');
        }
        if (!body.programId) {
          return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing programId');
        }

        const result = await publishLearningProgram({
          teacherId: user.id,
          programId: body.programId,
          confirmPublish: Boolean(body.confirmPublish),
        });

        return apiSuccess(result);
      }

      case 'assign_program_to_students': {
        if (!ensureTeacherOrAdmin(user.role)) {
          return apiError('INVALID_REQUEST', 403, 'Permission denied');
        }
        if (!body.programId || !Array.isArray(body.studentIds)) {
          return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing programId or studentIds');
        }

        const assignments = await assignLearningProgramToStudents({
          teacherId: user.id,
          programId: body.programId,
          studentIds: body.studentIds,
        });

        return apiSuccess({ assignments });
      }

      case 'apply_program': {
        if (!body.programId) {
          return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing programId');
        }

        const application = await applyLearningProgram({
          studentId: user.id,
          studentUsername: user.username,
          programId: body.programId,
          note: body.note,
        });

        return apiSuccess({ application }, 201);
      }

      case 'review_application': {
        if (!ensureTeacherOrAdmin(user.role)) {
          return apiError('INVALID_REQUEST', 403, 'Permission denied');
        }
        if (!body.applicationId || !body.decision) {
          return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing applicationId or decision');
        }
        if (body.decision !== 'approved' && body.decision !== 'rejected') {
          return apiError('INVALID_REQUEST', 400, 'Invalid decision');
        }

        const result = await reviewLearningApplication({
          teacherId: user.id,
          applicationId: body.applicationId,
          decision: body.decision,
          reviewer: user.username,
          reviewNote: body.reviewNote,
        });

        return apiSuccess(result);
      }

      case 'accept_assignment': {
        if (!body.assignmentId) {
          return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing assignmentId');
        }

        const assignment = await acceptLearningAssignment({
          studentId: user.id,
          assignmentId: body.assignmentId,
        });

        return apiSuccess({ assignment });
      }

      case 'update_lesson_status':
      case 'update_lesson': {
        if (!body.assignmentId || !body.lessonId || !body.status) {
          return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing assignmentId, lessonId or status');
        }

        if (!['not_started', 'in_progress', 'completed'].includes(body.status)) {
          return apiError('INVALID_REQUEST', 400, 'Invalid lesson status');
        }

        const assignment = await updateLearningLessonStatus({
          studentId: user.id,
          assignmentId: body.assignmentId,
          lessonId: body.lessonId,
          status: body.status,
        });

        return apiSuccess({ assignment });
      }

      case 'record_lesson_metrics': {
        if (!body.assignmentId || !body.lessonId) {
          return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing assignmentId or lessonId');
        }

        const assignment = await recordLearningLessonMetrics({
          studentId: user.id,
          assignmentId: body.assignmentId,
          lessonId: body.lessonId,
          studySecondsDelta: body.studySecondsDelta,
          pauseSecondsDelta: body.pauseSecondsDelta,
          replaySecondsDelta: body.replaySecondsDelta,
          replayCountDelta: body.replayCountDelta,
          aiQuestion: body.aiQuestion,
          aiQuestions: Array.isArray(body.aiQuestions) ? body.aiQuestions : undefined,
        });

        return apiSuccess({ assignment });
      }

      case 'submit_quiz_result': {
        if (!body.assignmentId || !body.lessonId) {
          return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing assignmentId or lessonId');
        }

        const attempts = typeof body.attempts === 'number' ? body.attempts : 0;
        const correct = typeof body.correct === 'number' ? body.correct : 0;

        const assignment = await submitLearningQuizResult({
          studentId: user.id,
          assignmentId: body.assignmentId,
          lessonId: body.lessonId,
          attempts,
          correct,
        });

        return apiSuccess({ assignment });
      }

      case 'report_stuck': {
        if (!body.assignmentId || !body.lessonId || !body.note?.trim()) {
          return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing assignmentId, lessonId or note');
        }

        const assignment = await reportLearningStuckPoint({
          studentId: user.id,
          assignmentId: body.assignmentId,
          lessonId: body.lessonId,
          note: body.note,
        });

        return apiSuccess({ assignment });
      }

      case 'resolve_stuck': {
        if (!ensureTeacherOrAdmin(user.role)) {
          return apiError('INVALID_REQUEST', 403, 'Permission denied');
        }
        if (!body.assignmentId || !body.stuckId) {
          return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing assignmentId or stuckId');
        }

        const assignment = await resolveLearningStuckPoint({
          teacherId: user.id,
          assignmentId: body.assignmentId,
          stuckId: body.stuckId,
          resolver: user.username,
          resolutionNote: body.note,
        });

        return apiSuccess({ assignment });
      }

      case 'resolve_risk': {
        if (!ensureTeacherOrAdmin(user.role)) {
          return apiError('INVALID_REQUEST', 403, 'Permission denied');
        }
        if (!body.assignmentId || !body.riskKey) {
          return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing assignmentId or riskKey');
        }

        const assignment = await resolveLearningRiskSignal({
          teacherId: user.id,
          assignmentId: body.assignmentId,
          riskKey: body.riskKey,
          resolver: user.username,
          resolutionNote: body.note,
        });

        return apiSuccess({ assignment });
      }

      case 'upsert_student_profile': {
        if (user.role !== 'student') {
          return apiError('INVALID_REQUEST', 403, 'Only students can update their own learning profile');
        }

        const profile = await upsertLearningStudentProfile({
          studentId: user.id,
          studentUsername: user.username,
          goals: body.goals,
          preferences: body.preferences,
          weaknesses: body.weaknesses,
        });

        return apiSuccess({ profile });
      }

      // Backward compatibility for previous prototype actions.
      case 'create_course': {
        if (!ensureTeacherOrAdmin(user.role)) {
          return apiError('INVALID_REQUEST', 403, 'Permission denied');
        }
        if (!body.title || !Array.isArray(body.lessonLines)) {
          return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing title or lessonLines');
        }

        const program = await createLearningCourse({
          teacherId: user.id,
          teacherUsername: user.username,
          title: body.title,
          description: body.description,
          moduleTitle: body.moduleTitle,
          lessonLines: body.lessonLines,
        });

        return apiSuccess({ course: program, program }, 201);
      }

      case 'publish_course': {
        if (!ensureTeacherOrAdmin(user.role)) {
          return apiError('INVALID_REQUEST', 403, 'Permission denied');
        }
        if (!body.courseId) {
          return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing courseId');
        }

        const program = await publishLearningCourse({
          teacherId: user.id,
          courseId: body.courseId,
        });

        return apiSuccess({ course: program, program });
      }

      case 'assign_course': {
        if (!ensureTeacherOrAdmin(user.role)) {
          return apiError('INVALID_REQUEST', 403, 'Permission denied');
        }
        if (!body.courseId || !Array.isArray(body.studentIds)) {
          return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing courseId or studentIds');
        }

        const assignments = await assignLearningCourse({
          teacherId: user.id,
          courseId: body.courseId,
          studentIds: body.studentIds,
        });

        return apiSuccess({ assignments });
      }

      default:
        return apiError('INVALID_REQUEST', 400, 'Unsupported action');
    }
  } catch (error) {
    return mapLearningDomainError(error);
  }
}
