import crypto from 'crypto';
import path from 'path';
import { promises as fs } from 'fs';
import { writeJsonFileAtomic } from '@/lib/server/classroom-storage';
import { listUsers } from '@/lib/server/auth/storage';
import type { AuthUserRecord } from '@/lib/server/auth/types';
import type {
  LearningAssignment,
  LearningBehaviorSummary,
  LearningChapter,
  LearningChapterProgressSummary,
  LearningCourseProgram,
  LearningIntervention,
  LearningLesson,
  LearningLessonAnalyticsRow,
  LearningLessonDifficulty,
  LearningLessonGenerationStatus,
  LearningLessonGenerationTask,
  LearningLessonGenerationTaskStatus,
  LearningLessonMetrics,
  LearningLessonProgressRecord,
  LearningLessonProgressStatus,
  LearningProgramSource,
  LearningProgramStatus,
  LearningProgramApplication,
  LearningPublishWarning,
  LearningRiskSignal,
  LearningSyllabusAnalytics,
  LearningStoreData,
  StudentCourseView,
  StudentLearningView,
  TeacherAssignmentSummary,
  TeacherInterventionItem,
  TeacherLearningView,
  TeacherProgramSummary,
} from '@/lib/types/learning';

const DEFAULT_LEARNING_FILE = path.join(process.cwd(), 'data', 'learning', 'store.json');

function getLearningFilePath(): string {
  return process.env.LEARNING_DATA_FILE || DEFAULT_LEARNING_FILE;
}

function nowIso(): string {
  return new Date().toISOString();
}

function clampNonNegativeNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, value);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const dedup = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const normalized = item.trim();
    if (!normalized) continue;
    dedup.add(normalized);
  }
  return [...dedup];
}

function normalizeDifficulty(value: unknown): LearningLessonDifficulty {
  return value === 'advanced' || value === 'intermediate' ? value : 'basic';
}

function normalizeLessonGenerationStatus(value: unknown): LearningLessonGenerationStatus {
  switch (value) {
    case 'started':
    case 'processing':
    case 'binding_pending':
    case 'succeeded':
    case 'failed':
      return value;
    default:
      return 'not_started';
  }
}

function normalizeProgramStatus(value: unknown): LearningProgramStatus {
  if (value === 'archived') return 'archived';
  if (value === 'published') return 'published';
  return 'draft';
}

function normalizeProgramSource(value: unknown): LearningProgramSource {
  if (value === 'ai_generated' || value === 'mixed') return value;
  return 'manual';
}

function percent(completed: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((completed / total) * 100);
}

function ratioPercent(correct: number, attempts: number): number | null {
  if (attempts <= 0) return null;
  return Math.round((correct / attempts) * 1000) / 10;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }
  return sorted[middle];
}

function normalizeQuestionText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u3000\s]+/g, ' ')
    .replace(/[\p{P}\p{S}]/gu, '')
    .trim();
}

function createDefaultProgress(timestamp: string): LearningLessonProgressRecord {
  return {
    status: 'not_started',
    inProgressCount: 0,
    updatedAt: timestamp,
  };
}

function createDefaultMetrics(timestamp: string): LearningLessonMetrics {
  return {
    studySeconds: 0,
    pauseSeconds: 0,
    replaySeconds: 0,
    replayCount: 0,
    quizAttempts: 0,
    quizCorrect: 0,
    aiQuestionTotal: 0,
    aiRepeatedQuestionTotal: 0,
    aiQuestionFrequency: {},
    lastUpdatedAt: timestamp,
  };
}

function sanitizeMetrics(value: unknown, timestamp: string): LearningLessonMetrics {
  if (!value || typeof value !== 'object') {
    return createDefaultMetrics(timestamp);
  }

  const metrics = value as Partial<LearningLessonMetrics>;
  const frequency =
    metrics.aiQuestionFrequency && typeof metrics.aiQuestionFrequency === 'object'
      ? Object.entries(metrics.aiQuestionFrequency).reduce<Record<string, number>>((acc, [key, count]) => {
          if (typeof key !== 'string') return acc;
          if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) return acc;
          acc[key] = Math.floor(count);
          return acc;
        }, {})
      : {};

  return {
    studySeconds: clampNonNegativeNumber(metrics.studySeconds),
    pauseSeconds: clampNonNegativeNumber(metrics.pauseSeconds),
    replaySeconds: clampNonNegativeNumber(metrics.replaySeconds),
    replayCount: clampNonNegativeNumber(metrics.replayCount),
    quizAttempts: clampNonNegativeNumber(metrics.quizAttempts),
    quizCorrect: clampNonNegativeNumber(metrics.quizCorrect),
    aiQuestionTotal: clampNonNegativeNumber(metrics.aiQuestionTotal),
    aiRepeatedQuestionTotal: clampNonNegativeNumber(metrics.aiRepeatedQuestionTotal),
    aiQuestionFrequency: frequency,
    lastUpdatedAt: asOptionalString(metrics.lastUpdatedAt) || timestamp,
  };
}

function sanitizeProgress(value: unknown, timestamp: string): LearningLessonProgressRecord {
  if (!value || typeof value !== 'object') {
    return createDefaultProgress(timestamp);
  }

  const progress = value as Partial<LearningLessonProgressRecord>;
  if (
    progress.status !== 'not_started' &&
    progress.status !== 'in_progress' &&
    progress.status !== 'completed'
  ) {
    return createDefaultProgress(timestamp);
  }

  return {
    status: progress.status,
    inProgressCount: clampNonNegativeNumber(progress.inProgressCount),
    updatedAt: asOptionalString(progress.updatedAt) || timestamp,
    startedAt: asOptionalString(progress.startedAt),
    completedAt: asOptionalString(progress.completedAt),
  };
}

function sanitizeLesson(value: unknown, index: number): LearningLesson | null {
  if (!value || typeof value !== 'object') return null;
  const lesson = value as Partial<LearningLesson>;

  const title = asString(lesson.title).trim();
  if (!title) return null;

  const classroomId = asOptionalString(lesson.classroomId);
  const normalizedGenerationStatus = normalizeLessonGenerationStatus(lesson.generationStatus);

  return {
    id: asOptionalString(lesson.id) || crypto.randomUUID(),
    title,
    description: asString(lesson.description).trim(),
    order: typeof lesson.order === 'number' && Number.isFinite(lesson.order) ? lesson.order : index,
    learningObjectives: normalizeStringArray(lesson.learningObjectives),
    prerequisites: normalizeStringArray(lesson.prerequisites),
    difficulty: normalizeDifficulty(lesson.difficulty),
    diagnosticTags: normalizeStringArray(lesson.diagnosticTags),
    generationStatus:
      normalizedGenerationStatus === 'not_started' && classroomId ? 'succeeded' : normalizedGenerationStatus,
    classroomId,
    previewUrl: asOptionalString(lesson.previewUrl),
    lastGenerationTaskId: asOptionalString(lesson.lastGenerationTaskId),
  };
}

function sanitizeChapter(value: unknown, index: number): LearningChapter | null {
  if (!value || typeof value !== 'object') return null;
  const chapter = value as Partial<LearningChapter>;
  const title = asString(chapter.title).trim();
  if (!title) return null;

  const lessonsRaw = Array.isArray(chapter.lessons) ? chapter.lessons : [];
  const lessons = lessonsRaw
    .map((lesson, lessonIndex) => sanitizeLesson(lesson, lessonIndex))
    .filter((lesson): lesson is NonNullable<typeof lesson> => lesson !== null)
    .sort((a, b) => a.order - b.order)
    .map((lesson, order) => ({ ...lesson, order }));

  return {
    id: asOptionalString(chapter.id) || crypto.randomUUID(),
    title,
    description: asString(chapter.description).trim(),
    order: typeof chapter.order === 'number' && Number.isFinite(chapter.order) ? chapter.order : index,
    lessons,
  };
}

function sanitizeProgram(value: unknown): LearningCourseProgram | null {
  if (!value || typeof value !== 'object') return null;
  const program = value as Partial<LearningCourseProgram>;

  const title = asString(program.title).trim();
  const teacherId = asString(program.teacherId).trim();
  const teacherUsername = asString(program.teacherUsername).trim();
  if (!title || !teacherId || !teacherUsername) return null;

  const chaptersRaw = Array.isArray(program.chapters) ? program.chapters : [];
  const chapters = chaptersRaw
    .map((chapter, index) => sanitizeChapter(chapter, index))
    .filter((chapter): chapter is NonNullable<typeof chapter> => chapter !== null)
    .sort((a, b) => a.order - b.order)
    .map((chapter, order) => ({
      ...chapter,
      order,
      lessons: chapter.lessons.map((lesson, lessonOrder) => ({ ...lesson, order: lessonOrder })),
    }));

  const published = Boolean(program.published);
  const status = normalizeProgramStatus(program.status);
  const normalizedStatus = published && status === 'draft' ? 'published' : status;

  return {
    id: asOptionalString(program.id) || crypto.randomUUID(),
    teacherId,
    teacherUsername,
    title,
    description: asString(program.description).trim(),
    targetAudience: asOptionalString(program.targetAudience),
    source: normalizeProgramSource(program.source),
    status: normalizedStatus,
    chapters,
    published,
    publishedAt: asOptionalString(program.publishedAt),
    createdAt: asOptionalString(program.createdAt) || nowIso(),
    updatedAt: asOptionalString(program.updatedAt) || nowIso(),
  };
}

function sanitizeStuckPoints(value: unknown[]): LearningAssignment['stuckPoints'] {
  return value
    .map((raw) => {
      if (!raw || typeof raw !== 'object') return null;
      const stuck = raw as Partial<LearningAssignment['stuckPoints'][number]>;
      if (!stuck.id || !stuck.lessonId || !stuck.chapterId || !stuck.note || !stuck.createdAt) {
        return null;
      }
      const status: LearningAssignment['stuckPoints'][number]['status'] =
        stuck.status === 'resolved' ? 'resolved' : 'open';
      return {
        id: stuck.id,
        chapterId: stuck.chapterId,
        chapterTitle: asString(stuck.chapterTitle),
        lessonId: stuck.lessonId,
        lessonTitle: asString(stuck.lessonTitle),
        note: asString(stuck.note),
        status,
        createdAt: stuck.createdAt,
        resolvedAt: asOptionalString(stuck.resolvedAt),
        resolvedBy: asOptionalString(stuck.resolvedBy),
        resolutionNote: asOptionalString(stuck.resolutionNote),
      } satisfies LearningAssignment['stuckPoints'][number];
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);
}

function sanitizeInterventions(value: unknown[]): LearningIntervention[] {
  return value
    .map((raw) => {
      if (!raw || typeof raw !== 'object') return null;
      const intervention = raw as Partial<LearningIntervention>;
      if (!intervention.id || !intervention.assignmentId || !intervention.type || !intervention.note) {
        return null;
      }
      if (intervention.type !== 'stuck' && intervention.type !== 'risk') return null;

      const status: LearningIntervention['status'] =
        intervention.status === 'resolved' ? 'resolved' : 'open';
      return {
        id: intervention.id,
        assignmentId: intervention.assignmentId,
        type: intervention.type,
        note: asString(intervention.note),
        status,
        createdAt: asOptionalString(intervention.createdAt) || nowIso(),
        resolvedAt: asOptionalString(intervention.resolvedAt),
        resolvedBy: asOptionalString(intervention.resolvedBy),
        stuckId: asOptionalString(intervention.stuckId),
        riskKey: asOptionalString(intervention.riskKey),
      } satisfies LearningIntervention;
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);
}

function sanitizeAssignment(value: unknown, timestamp: string): LearningAssignment | null {
  if (!value || typeof value !== 'object') return null;
  const assignment = value as Partial<LearningAssignment>;

  const id = asOptionalString(assignment.id);
  const programId = asOptionalString(assignment.programId);
  const teacherId = asOptionalString(assignment.teacherId);
  const studentId = asOptionalString(assignment.studentId);
  const studentUsername = asOptionalString(assignment.studentUsername);
  if (!id || !programId || !teacherId || !studentId || !studentUsername) {
    return null;
  }

  const status: LearningAssignment['status'] =
    assignment.status === 'completed'
      ? 'completed'
      : assignment.status === 'active'
        ? 'active'
        : 'pending_acceptance';

  const source: LearningAssignment['source'] =
    assignment.source === 'student_apply' ? 'student_apply' : 'teacher_assign';

  const lessonProgressRaw = assignment.lessonProgress;
  const lessonMetricsRaw = assignment.lessonMetrics;

  const lessonProgress: Record<string, LearningLessonProgressRecord> = {};
  if (lessonProgressRaw && typeof lessonProgressRaw === 'object') {
    for (const [lessonId, raw] of Object.entries(lessonProgressRaw)) {
      lessonProgress[lessonId] = sanitizeProgress(raw, timestamp);
    }
  }

  const lessonMetrics: Record<string, LearningLessonMetrics> = {};
  if (lessonMetricsRaw && typeof lessonMetricsRaw === 'object') {
    for (const [lessonId, raw] of Object.entries(lessonMetricsRaw)) {
      lessonMetrics[lessonId] = sanitizeMetrics(raw, timestamp);
    }
  }

  return {
    id,
    programId,
    teacherId,
    studentId,
    studentUsername,
    source,
    status,
    assignedAt: asOptionalString(assignment.assignedAt) || timestamp,
    acceptedAt: asOptionalString(assignment.acceptedAt),
    completedAt: asOptionalString(assignment.completedAt),
    lastActivityAt: asOptionalString(assignment.lastActivityAt) || timestamp,
    lessonProgress,
    lessonMetrics,
    stuckPoints: sanitizeStuckPoints(Array.isArray(assignment.stuckPoints) ? assignment.stuckPoints : []),
    interventions: sanitizeInterventions(Array.isArray(assignment.interventions) ? assignment.interventions : []),
    resolvedRiskKeys: Array.isArray(assignment.resolvedRiskKeys)
      ? assignment.resolvedRiskKeys.filter((item): item is string => typeof item === 'string')
      : [],
  };
}

function sanitizeApplication(value: unknown): LearningProgramApplication | null {
  if (!value || typeof value !== 'object') return null;
  const application = value as Partial<LearningProgramApplication>;

  if (
    !application.id ||
    !application.programId ||
    !application.teacherId ||
    !application.studentId ||
    !application.studentUsername ||
    !application.createdAt
  ) {
    return null;
  }

  const status: LearningProgramApplication['status'] =
    application.status === 'approved'
      ? 'approved'
      : application.status === 'rejected'
        ? 'rejected'
        : 'pending';

  return {
    id: application.id,
    programId: application.programId,
    teacherId: application.teacherId,
    studentId: application.studentId,
    studentUsername: application.studentUsername,
    status,
    note: asOptionalString(application.note),
    createdAt: application.createdAt,
    reviewedAt: asOptionalString(application.reviewedAt),
    reviewedBy: asOptionalString(application.reviewedBy),
    reviewNote: asOptionalString(application.reviewNote),
  };
}

function normalizeGenerationTaskStatus(value: unknown): LearningLessonGenerationTaskStatus {
  switch (value) {
    case 'processing':
    case 'binding_pending':
    case 'succeeded':
    case 'failed':
      return value;
    default:
      return 'started';
  }
}

function sanitizeGenerationTask(value: unknown): LearningLessonGenerationTask | null {
  if (!value || typeof value !== 'object') return null;
  const task = value as Partial<LearningLessonGenerationTask>;

  const id = asOptionalString(task.id);
  const lessonId = asOptionalString(task.lessonId);
  const programId = asOptionalString(task.programId);
  const teacherUserId = asOptionalString(task.teacherUserId);
  if (!id || !lessonId || !programId || !teacherUserId) {
    return null;
  }

  const rawLaunch = task.launchContext;
  const launchContext =
    rawLaunch && typeof rawLaunch === 'object'
      ? rawLaunch
      : {
          courseTitle: '',
          chapterTitle: '',
          lessonTitle: '',
        };

  return {
    id,
    lessonId,
    programId,
    teacherUserId,
    status: normalizeGenerationTaskStatus(task.status),
    requirementsText: asOptionalString(task.requirementsText),
    materialsSnapshot: Array.isArray(task.materialsSnapshot)
      ? task.materialsSnapshot.map((item) => ({
          fileId: asOptionalString(item?.fileId),
          name: asOptionalString(item?.name),
        }))
      : [],
    launchContext: {
      courseTitle: asString((launchContext as { courseTitle?: unknown }).courseTitle).trim(),
      courseDescription: asOptionalString((launchContext as { courseDescription?: unknown }).courseDescription),
      chapterTitle: asString((launchContext as { chapterTitle?: unknown }).chapterTitle).trim(),
      lessonTitle: asString((launchContext as { lessonTitle?: unknown }).lessonTitle).trim(),
      lessonDescription: asOptionalString((launchContext as { lessonDescription?: unknown }).lessonDescription),
      learningObjectives: normalizeStringArray(
        (launchContext as { learningObjectives?: unknown }).learningObjectives,
      ),
      prerequisites: normalizeStringArray((launchContext as { prerequisites?: unknown }).prerequisites),
      difficulty: normalizeDifficulty((launchContext as { difficulty?: unknown }).difficulty),
      diagnosticTags: normalizeStringArray((launchContext as { diagnosticTags?: unknown }).diagnosticTags),
    },
    classroomJobId: asOptionalString(task.classroomJobId),
    resultClassroomId: asOptionalString(task.resultClassroomId),
    resultPreviewUrl: asOptionalString(task.resultPreviewUrl),
    errorCode: asOptionalString(task.errorCode),
    errorMessage: asOptionalString(task.errorMessage),
    createdAt: asOptionalString(task.createdAt) || nowIso(),
    updatedAt: asOptionalString(task.updatedAt) || nowIso(),
    completedAt: asOptionalString(task.completedAt),
  };
}

function createEmptyStore(): LearningStoreData {
  return {
    version: 2,
    programs: [],
    assignments: [],
    applications: [],
    generationTasks: [],
  };
}

function migrateFromV1(raw: Record<string, unknown>): LearningStoreData {
  const timestamp = nowIso();

  const programs = Array.isArray(raw.courses)
    ? raw.courses
        .map((course) => {
          if (!course || typeof course !== 'object') return null;
          const legacy = course as {
            id?: string;
            teacherId?: string;
            teacherUsername?: string;
            title?: string;
            description?: string;
            modules?: Array<{
              id?: string;
              title?: string;
              lessons?: Array<{ id?: string; title?: string; classroomId?: string }>;
            }>;
            createdAt?: string;
            updatedAt?: string;
            published?: boolean;
          };

          const chapters = Array.isArray(legacy.modules)
            ? legacy.modules
                .map((module, moduleIndex) => {
                  if (!module || typeof module !== 'object') return null;
                  const lessons = Array.isArray(module.lessons)
                    ? module.lessons
                        .map((lesson, lessonIndex) => {
                          if (!lesson || typeof lesson !== 'object') return null;
                          const title = asString(lesson.title).trim();
                          if (!title) return null;
                          return {
                            id: asOptionalString(lesson.id) || crypto.randomUUID(),
                            title,
                            description: '',
                            order: lessonIndex,
                            learningObjectives: [],
                            prerequisites: [],
                            difficulty: 'basic',
                            diagnosticTags: [],
                            generationStatus: asOptionalString(lesson.classroomId)
                              ? 'succeeded'
                              : 'not_started',
                            classroomId: asOptionalString(lesson.classroomId),
                            previewUrl: undefined,
                            lastGenerationTaskId: undefined,
                          } satisfies LearningLesson;
                        })
                        .filter((lesson): lesson is NonNullable<typeof lesson> => lesson !== null)
                    : [];

                  const title = asString(module.title).trim() || `章节 ${moduleIndex + 1}`;
                  return {
                    id: asOptionalString(module.id) || crypto.randomUUID(),
                    title,
                    description: '',
                    order: moduleIndex,
                    lessons,
                  } satisfies LearningChapter;
                })
                .filter((chapter): chapter is NonNullable<typeof chapter> => chapter !== null)
            : [];

          const title = asString(legacy.title).trim();
          const teacherId = asString(legacy.teacherId).trim();
          const teacherUsername = asString(legacy.teacherUsername).trim();
          if (!title || !teacherId || !teacherUsername) return null;

          return {
            id: asOptionalString(legacy.id) || crypto.randomUUID(),
            teacherId,
            teacherUsername,
            title,
            description: asString(legacy.description).trim(),
            targetAudience: undefined,
            source: 'manual',
            status: legacy.published ? 'published' : 'draft',
            chapters,
            published: Boolean(legacy.published),
            publishedAt: undefined,
            createdAt: asOptionalString(legacy.createdAt) || timestamp,
            updatedAt: asOptionalString(legacy.updatedAt) || timestamp,
          } satisfies LearningCourseProgram;
        })
        .filter((program): program is NonNullable<typeof program> => program !== null)
    : [];

  const programMap = new Map(programs.map((program) => [program.id, program]));

  const assignments = Array.isArray(raw.assignments)
    ? raw.assignments
        .map((item) => {
          if (!item || typeof item !== 'object') return null;
          const legacy = item as {
            id?: string;
            courseId?: string;
            teacherId?: string;
            studentId?: string;
            studentUsername?: string;
            status?: LearningAssignment['status'];
            assignedAt?: string;
            acceptedAt?: string;
            completedAt?: string;
            lastActivityAt?: string;
            lessonProgress?: Record<string, LearningLessonProgressStatus>;
            lessonMetrics?: Record<string, Partial<LearningLessonMetrics>>;
            stuckPoints?: unknown[];
          };

          const program = legacy.courseId ? programMap.get(legacy.courseId) : undefined;
          if (!program) return null;

          const lessonProgress: Record<string, LearningLessonProgressRecord> = {};
          for (const lesson of getProgramLessons(program)) {
            lessonProgress[lesson.id] = createDefaultProgress(timestamp);
          }

          if (legacy.lessonProgress && typeof legacy.lessonProgress === 'object') {
            for (const [lessonId, status] of Object.entries(legacy.lessonProgress)) {
              if (!lessonProgress[lessonId]) {
                lessonProgress[lessonId] = createDefaultProgress(timestamp);
              }
              lessonProgress[lessonId] = {
                ...lessonProgress[lessonId],
                status:
                  status === 'completed' ? 'completed' : status === 'in_progress' ? 'in_progress' : 'not_started',
                inProgressCount: status === 'in_progress' ? 1 : lessonProgress[lessonId].inProgressCount,
                updatedAt: timestamp,
                startedAt: status === 'in_progress' || status === 'completed' ? timestamp : undefined,
                completedAt: status === 'completed' ? timestamp : undefined,
              };
            }
          }

          const lessonMetrics: Record<string, LearningLessonMetrics> = {};
          for (const lesson of getProgramLessons(program)) {
            lessonMetrics[lesson.id] = createDefaultMetrics(timestamp);
          }

          if (legacy.lessonMetrics && typeof legacy.lessonMetrics === 'object') {
            for (const [lessonId, rawMetrics] of Object.entries(legacy.lessonMetrics)) {
              lessonMetrics[lessonId] = sanitizeMetrics(rawMetrics, timestamp);
            }
          }

          const id = asOptionalString(legacy.id);
          const teacherId = asOptionalString(legacy.teacherId);
          const studentId = asOptionalString(legacy.studentId);
          const studentUsername = asOptionalString(legacy.studentUsername);
          if (!id || !teacherId || !studentId || !studentUsername) {
            return null;
          }

          return {
            id,
            programId: program.id,
            teacherId,
            studentId,
            studentUsername,
            source: 'teacher_assign',
            status:
              legacy.status === 'completed'
                ? 'completed'
                : legacy.status === 'active'
                  ? 'active'
                  : 'pending_acceptance',
            assignedAt: asOptionalString(legacy.assignedAt) || timestamp,
            acceptedAt: asOptionalString(legacy.acceptedAt),
            completedAt: asOptionalString(legacy.completedAt),
            lastActivityAt: asOptionalString(legacy.lastActivityAt) || timestamp,
            lessonProgress,
            lessonMetrics,
            stuckPoints: sanitizeStuckPoints(Array.isArray(legacy.stuckPoints) ? legacy.stuckPoints : []),
            interventions: [],
            resolvedRiskKeys: [],
          } satisfies LearningAssignment;
        })
        .filter((assignment): assignment is NonNullable<typeof assignment> => assignment !== null)
    : [];

  return {
    version: 2,
    programs,
    assignments,
    applications: [],
    generationTasks: [],
  };
}

function normalizeStore(raw: unknown): LearningStoreData {
  if (!raw || typeof raw !== 'object') {
    return createEmptyStore();
  }

  const value = raw as Record<string, unknown>;
  if (value.version === 2) {
    const timestamp = nowIso();
    const programs = Array.isArray(value.programs)
      ? value.programs
          .map((program) => sanitizeProgram(program))
          .filter((program): program is NonNullable<typeof program> => program !== null)
      : [];

    const assignments = Array.isArray(value.assignments)
      ? value.assignments
          .map((assignment) => sanitizeAssignment(assignment, timestamp))
          .filter((assignment): assignment is NonNullable<typeof assignment> => assignment !== null)
      : [];

    const applications = Array.isArray(value.applications)
      ? value.applications
          .map((application) => sanitizeApplication(application))
          .filter((application): application is LearningProgramApplication => application !== null)
      : [];

    const generationTasks = Array.isArray(value.generationTasks)
      ? value.generationTasks
          .map((task) => sanitizeGenerationTask(task))
          .filter((task): task is LearningLessonGenerationTask => task !== null)
      : [];

    return {
      version: 2,
      programs,
      assignments,
      applications,
      generationTasks,
    };
  }

  if (Array.isArray(value.courses)) {
    return migrateFromV1(value);
  }

  return createEmptyStore();
}

async function readStore(): Promise<LearningStoreData> {
  const filePath = getLearningFilePath();
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return normalizeStore(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return createEmptyStore();
    }
    throw error;
  }
}

async function writeStore(store: LearningStoreData): Promise<void> {
  await writeJsonFileAtomic(getLearningFilePath(), store);
}

function getProgramLessons(program: LearningCourseProgram): LearningLesson[] {
  return program.chapters.flatMap((chapter) => chapter.lessons);
}

function findLessonInProgram(program: LearningCourseProgram, lessonId: string) {
  for (const chapter of program.chapters) {
    const lesson = chapter.lessons.find((candidate) => candidate.id === lessonId);
    if (lesson) {
      return { chapter, lesson };
    }
  }
  return null;
}

function syncAssignmentWithProgram(assignment: LearningAssignment, program: LearningCourseProgram, timestamp: string) {
  const lessonIds = new Set(getProgramLessons(program).map((lesson) => lesson.id));

  for (const lessonId of Object.keys(assignment.lessonProgress)) {
    if (!lessonIds.has(lessonId)) {
      delete assignment.lessonProgress[lessonId];
    }
  }
  for (const lessonId of Object.keys(assignment.lessonMetrics)) {
    if (!lessonIds.has(lessonId)) {
      delete assignment.lessonMetrics[lessonId];
    }
  }

  for (const lessonId of lessonIds) {
    if (!assignment.lessonProgress[lessonId]) {
      assignment.lessonProgress[lessonId] = createDefaultProgress(timestamp);
    }
    if (!assignment.lessonMetrics[lessonId]) {
      assignment.lessonMetrics[lessonId] = createDefaultMetrics(timestamp);
    }
  }

  assignment.stuckPoints = assignment.stuckPoints.filter((stuck) => lessonIds.has(stuck.lessonId));

  updateAssignmentCompletionStatus(assignment, program, timestamp);
}

function updateAssignmentCompletionStatus(
  assignment: LearningAssignment,
  program: LearningCourseProgram,
  timestamp: string,
) {
  const lessons = getProgramLessons(program);
  const totalLessons = lessons.length;
  const completedLessons = lessons.filter(
    (lesson) => assignment.lessonProgress[lesson.id]?.status === 'completed',
  ).length;

  if (totalLessons > 0 && completedLessons >= totalLessons) {
    assignment.status = 'completed';
    assignment.completedAt = assignment.completedAt || timestamp;
    if (!assignment.acceptedAt) {
      assignment.acceptedAt = timestamp;
    }
    return;
  }

  if (assignment.status === 'completed') {
    assignment.status = 'active';
    assignment.completedAt = undefined;
  }
}

function buildAssignment(
  params: {
    program: LearningCourseProgram;
    studentId: string;
    studentUsername: string;
    source: LearningAssignment['source'];
  },
  timestamp: string,
): LearningAssignment {
  const lessonProgress: Record<string, LearningLessonProgressRecord> = {};
  const lessonMetrics: Record<string, LearningLessonMetrics> = {};

  for (const lesson of getProgramLessons(params.program)) {
    lessonProgress[lesson.id] = createDefaultProgress(timestamp);
    lessonMetrics[lesson.id] = createDefaultMetrics(timestamp);
  }

  return {
    id: crypto.randomUUID(),
    programId: params.program.id,
    teacherId: params.program.teacherId,
    studentId: params.studentId,
    studentUsername: params.studentUsername,
    source: params.source,
    status: 'pending_acceptance',
    assignedAt: timestamp,
    lastActivityAt: timestamp,
    lessonProgress,
    lessonMetrics,
    stuckPoints: [],
    interventions: [],
    resolvedRiskKeys: [],
  };
}

function summarizeProgramProgress(assignment: LearningAssignment, program: LearningCourseProgram) {
  const lessons = getProgramLessons(program);
  const totalLessons = lessons.length;
  const completedLessons = lessons.filter(
    (lesson) => assignment.lessonProgress[lesson.id]?.status === 'completed',
  ).length;

  return {
    totalLessons,
    completedLessons,
    progressPercent: percent(completedLessons, totalLessons),
  };
}

function buildChapterSummaries(
  assignment: LearningAssignment,
  program: LearningCourseProgram,
): LearningChapterProgressSummary[] {
  return program.chapters.map((chapter) => {
    const totalLessons = chapter.lessons.length;
    let completedLessons = 0;
    let studySeconds = 0;
    let pauseSeconds = 0;
    let replaySeconds = 0;
    let replayCount = 0;
    let quizAttempts = 0;
    let quizCorrect = 0;
    let aiQuestionTotal = 0;
    let aiRepeatedQuestionTotal = 0;

    for (const lesson of chapter.lessons) {
      const progress = assignment.lessonProgress[lesson.id];
      if (progress?.status === 'completed') {
        completedLessons += 1;
      }

      const metrics = assignment.lessonMetrics[lesson.id];
      if (metrics) {
        studySeconds += metrics.studySeconds;
        pauseSeconds += metrics.pauseSeconds;
        replaySeconds += metrics.replaySeconds;
        replayCount += metrics.replayCount;
        quizAttempts += metrics.quizAttempts;
        quizCorrect += metrics.quizCorrect;
        aiQuestionTotal += metrics.aiQuestionTotal;
        aiRepeatedQuestionTotal += metrics.aiRepeatedQuestionTotal;
      }
    }

    return {
      chapterId: chapter.id,
      chapterTitle: chapter.title,
      totalLessons,
      completedLessons,
      progressPercent: percent(completedLessons, totalLessons),
      studySeconds,
      pauseSeconds,
      replaySeconds,
      replayCount,
      quizAttempts,
      quizCorrect,
      quizAccuracy: ratioPercent(quizCorrect, quizAttempts),
      aiQuestionTotal,
      aiRepeatedQuestionTotal,
    };
  });
}

function buildBehaviorSummary(chapterSummaries: LearningChapterProgressSummary[]): LearningBehaviorSummary {
  const base = chapterSummaries.reduce(
    (acc, chapter) => {
      acc.studySeconds += chapter.studySeconds;
      acc.pauseSeconds += chapter.pauseSeconds;
      acc.replaySeconds += chapter.replaySeconds;
      acc.replayCount += chapter.replayCount;
      acc.quizAttempts += chapter.quizAttempts;
      acc.quizCorrect += chapter.quizCorrect;
      acc.aiQuestionTotal += chapter.aiQuestionTotal;
      acc.aiRepeatedQuestionTotal += chapter.aiRepeatedQuestionTotal;
      return acc;
    },
    {
      studySeconds: 0,
      pauseSeconds: 0,
      replaySeconds: 0,
      replayCount: 0,
      quizAttempts: 0,
      quizCorrect: 0,
      aiQuestionTotal: 0,
      aiRepeatedQuestionTotal: 0,
    },
  );

  return {
    ...base,
    quizAccuracy: ratioPercent(base.quizCorrect, base.quizAttempts),
  };
}

interface ChapterCohortStat {
  pauseReplayMedian: number;
  studyMedian: number;
}

function buildChapterCohortStats(
  summaries: Array<{ program: LearningCourseProgram; chapterSummaries: LearningChapterProgressSummary[] }>,
): Map<string, ChapterCohortStat> {
  const bucket = new Map<string, { pauseReplay: number[]; study: number[] }>();

  for (const summary of summaries) {
    for (const chapter of summary.chapterSummaries) {
      const key = `${summary.program.id}:${chapter.chapterId}`;
      const current = bucket.get(key) || { pauseReplay: [], study: [] };
      current.pauseReplay.push(chapter.pauseSeconds + chapter.replaySeconds);
      current.study.push(chapter.studySeconds);
      bucket.set(key, current);
    }
  }

  const stats = new Map<string, ChapterCohortStat>();
  for (const [key, value] of bucket) {
    stats.set(key, {
      pauseReplayMedian: median(value.pauseReplay),
      studyMedian: median(value.study),
    });
  }

  return stats;
}

function buildRiskSignals(
  assignment: LearningAssignment,
  program: LearningCourseProgram,
  chapterSummaries: LearningChapterProgressSummary[],
  cohortStats: Map<string, ChapterCohortStat>,
): LearningRiskSignal[] {
  const risks: LearningRiskSignal[] = [];

  for (const chapter of chapterSummaries) {
    const statKey = `${program.id}:${chapter.chapterId}`;
    const stat = cohortStats.get(statKey);
    const pauseReplaySeconds = chapter.pauseSeconds + chapter.replaySeconds;
    const pauseReplayThreshold = stat
      ? Math.max(stat.pauseReplayMedian * 1.6, 900)
      : 1800;
    const repeatedQuestionThreshold = Math.max(4, chapter.totalLessons * 2);

    if (
      (chapter.progressPercent < 30 && pauseReplaySeconds > pauseReplayThreshold) ||
      chapter.aiRepeatedQuestionTotal >= repeatedQuestionThreshold
    ) {
      risks.push({
        key: `HIGH:${chapter.chapterId}`,
        code: 'HIGH_FRICTION_OR_REPEATED_QUESTIONS',
        level: 'high',
        chapterId: chapter.chapterId,
        chapterTitle: chapter.chapterTitle,
        message:
          chapter.aiRepeatedQuestionTotal >= repeatedQuestionThreshold
            ? `${chapter.chapterTitle} 重复提问次数偏高，建议老师尽快介入讲解关键概念。`
            : `${chapter.chapterTitle} 进度偏低且停顿/复看显著偏高，存在高风险卡点。`,
      });
    }

    const studyThreshold = stat ? Math.max(stat.studyMedian * 1.4, 1800) : 2400;
    if (
      chapter.quizAccuracy !== null &&
      chapter.quizAccuracy < 60 &&
      chapter.studySeconds > studyThreshold
    ) {
      risks.push({
        key: `MEDIUM:${chapter.chapterId}`,
        code: 'LOW_QUIZ_ACCURACY_WITH_LONG_STUDY',
        level: 'medium',
        chapterId: chapter.chapterId,
        chapterTitle: chapter.chapterTitle,
        message: `${chapter.chapterTitle} 小测正确率低且停留时长较长，建议安排针对性答疑。`,
      });
    }
  }

  for (const chapter of program.chapters) {
    for (const lesson of chapter.lessons) {
      const progress = assignment.lessonProgress[lesson.id];
      if (!progress) continue;
      if (progress.status === 'completed') continue;
      if (progress.inProgressCount >= 3) {
        risks.push({
          key: `LOW:${lesson.id}`,
          code: 'REPEATED_ENTER_NOT_COMPLETED',
          level: 'low',
          chapterId: chapter.id,
          chapterTitle: chapter.title,
          lessonId: lesson.id,
          lessonTitle: lesson.title,
          message: `${lesson.title} 多次进入仍未完成，建议老师关注学生是否存在基础断层。`,
        });
      }
    }
  }

  const riskLevelOrder: Record<LearningRiskSignal['level'], number> = {
    high: 0,
    medium: 1,
    low: 2,
  };

  return risks.sort((a, b) => riskLevelOrder[a.level] - riskLevelOrder[b.level]);
}

function buildPublishWarnings(program: LearningCourseProgram): LearningPublishWarning[] {
  const warnings: LearningPublishWarning[] = [];

  if (!program.description.trim()) {
    warnings.push({
      code: 'PROGRAM_DESCRIPTION_MISSING',
      level: 'info',
      message: '课程简介为空，建议补充学习目标与适用人群。',
    });
  }

  if (program.chapters.length === 0) {
    warnings.push({
      code: 'PROGRAM_WITHOUT_CHAPTERS',
      level: 'warning',
      message: '当前课程体系没有章节，发布后学生将无法开始学习。',
    });
    return warnings;
  }

  let unboundLessons = 0;
  let hasQuizLikeLesson = false;

  for (const chapter of program.chapters) {
    if (!chapter.description.trim()) {
      warnings.push({
        code: 'CHAPTER_DESCRIPTION_MISSING',
        level: 'info',
        chapterId: chapter.id,
        message: `章节「${chapter.title}」缺少描述，建议补充学习重点。`,
      });
    }

    if (chapter.lessons.length === 0) {
      warnings.push({
        code: 'EMPTY_CHAPTER',
        level: 'warning',
        chapterId: chapter.id,
        message: `章节「${chapter.title}」暂无课时，请补充内容后再发布。`,
      });
      continue;
    }

    for (const lesson of chapter.lessons) {
      if (!lesson.classroomId?.trim()) {
        unboundLessons += 1;
      }
      if (/(测验|小测|quiz|test)/i.test(lesson.title)) {
        hasQuizLikeLesson = true;
      }
    }
  }

  if (unboundLessons > 0) {
    warnings.push({
      code: 'LESSON_CLASSROOM_UNBOUND',
      level: 'warning',
      message: `仍有 ${unboundLessons} 个课时未绑定课堂内容（classroomId）。`,
    });
  }

  if (!hasQuizLikeLesson) {
    warnings.push({
      code: 'QUIZ_SIGNAL_WEAK',
      level: 'info',
      message: '课程内暂未识别到小测课时，后续可能缺少学习效果诊断数据。',
    });
  }

  return warnings;
}

function ensureTeacherOwnsProgram(program: LearningCourseProgram, teacherId: string) {
  if (program.teacherId !== teacherId) {
    throw new LearningDomainError('FORBIDDEN');
  }
}

function findProgramOrThrow(store: LearningStoreData, programId: string): LearningCourseProgram {
  const program = store.programs.find((item) => item.id === programId);
  if (!program) {
    throw new LearningDomainError('PROGRAM_NOT_FOUND');
  }
  return program;
}

function findAssignmentOrThrow(store: LearningStoreData, assignmentId: string): LearningAssignment {
  const assignment = store.assignments.find((item) => item.id === assignmentId);
  if (!assignment) {
    throw new LearningDomainError('ASSIGNMENT_NOT_FOUND');
  }
  return assignment;
}

function findGenerationTaskOrThrow(
  store: LearningStoreData,
  generationTaskId: string,
): LearningLessonGenerationTask {
  const task = store.generationTasks.find((item) => item.id === generationTaskId);
  if (!task) {
    throw new LearningDomainError('GENERATION_TASK_NOT_FOUND');
  }
  return task;
}

async function listStudentUsers(): Promise<Array<{ id: string; username: string; role: string }>> {
  const users = await listUsers();
  return users
    .filter((user) => user.role === 'student')
    .map((user) => ({ id: user.id, username: user.username, role: user.role }));
}

function upsertQuestionFrequency(metrics: LearningLessonMetrics, rawQuestion: string) {
  const normalized = normalizeQuestionText(rawQuestion);
  if (!normalized) return;

  const existingCount = metrics.aiQuestionFrequency[normalized] || 0;
  metrics.aiQuestionFrequency[normalized] = existingCount + 1;
  metrics.aiQuestionTotal += 1;
  if (existingCount >= 1) {
    metrics.aiRepeatedQuestionTotal += 1;
  }
}

function parseLegacyLessonLine(line: string): { title: string; classroomId?: string } | null {
  const [titlePart, classroomIdPart] = line.split('|');
  const title = titlePart?.trim();
  if (!title) return null;

  return {
    title,
    classroomId: classroomIdPart?.trim() || undefined,
  };
}

export class LearningDomainError extends Error {
  code: string;
  details?: unknown;

  constructor(code: string, details?: unknown) {
    super(code);
    this.code = code;
    this.details = details;
  }
}

export interface LearningProgramLessonInput {
  id?: string;
  title: string;
  description?: string;
  learningObjectives?: string[];
  prerequisites?: string[];
  difficulty?: LearningLessonDifficulty;
  diagnosticTags?: string[];
  generationStatus?: LearningLessonGenerationStatus;
  classroomId?: string;
  previewUrl?: string;
  lastGenerationTaskId?: string;
}

export interface LearningProgramChapterInput {
  id?: string;
  title: string;
  description?: string;
  lessons: LearningProgramLessonInput[];
}

export interface CreateLearningProgramInput {
  teacherId: string;
  teacherUsername: string;
  title: string;
  description?: string;
  targetAudience?: string;
  source?: LearningProgramSource;
  status?: LearningProgramStatus;
  chapters?: LearningProgramChapterInput[];
}

function normalizeProgramChapters(chapters: LearningProgramChapterInput[]): LearningChapter[] {
  return chapters
    .map((chapter, chapterOrder) => {
      const chapterTitle = chapter.title.trim();
      if (!chapterTitle) {
        return null;
      }

      const normalizedLessons = chapter.lessons
        .map((lesson, lessonOrder) => {
          const lessonTitle = lesson.title.trim();
          if (!lessonTitle) {
            return null;
          }

          return {
            id: lesson.id?.trim() || crypto.randomUUID(),
            title: lessonTitle,
            description: lesson.description?.trim() || '',
            order: lessonOrder,
            learningObjectives: normalizeStringArray(lesson.learningObjectives),
            prerequisites: normalizeStringArray(lesson.prerequisites),
            difficulty: normalizeDifficulty(lesson.difficulty),
            diagnosticTags: normalizeStringArray(lesson.diagnosticTags),
            generationStatus:
              normalizeLessonGenerationStatus(lesson.generationStatus) === 'not_started' &&
              Boolean(lesson.classroomId?.trim())
                ? 'succeeded'
                : normalizeLessonGenerationStatus(lesson.generationStatus),
            classroomId: lesson.classroomId?.trim() || undefined,
            previewUrl: lesson.previewUrl?.trim() || undefined,
            lastGenerationTaskId: lesson.lastGenerationTaskId?.trim() || undefined,
          } satisfies LearningLesson;
        })
        .filter((lesson): lesson is NonNullable<typeof lesson> => lesson !== null);

      return {
        id: chapter.id?.trim() || crypto.randomUUID(),
        title: chapterTitle,
        description: chapter.description?.trim() || '',
        order: chapterOrder,
        lessons: normalizedLessons,
      } satisfies LearningChapter;
    })
    .filter((chapter): chapter is NonNullable<typeof chapter> => chapter !== null);
}

function normalizeAndValidateTitle(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) {
    throw new LearningDomainError('TITLE_REQUIRED');
  }
  return trimmed;
}

export async function createLearningProgram(
  input: CreateLearningProgramInput,
): Promise<LearningCourseProgram> {
  const timestamp = nowIso();
  const title = normalizeAndValidateTitle(input.title);

  const store = await readStore();
  const source = normalizeProgramSource(input.source);
  const status = normalizeProgramStatus(input.status);
  const program: LearningCourseProgram = {
    id: crypto.randomUUID(),
    teacherId: input.teacherId,
    teacherUsername: input.teacherUsername,
    title,
    description: input.description?.trim() || '',
    targetAudience: input.targetAudience?.trim() || undefined,
    source,
    status: status === 'published' ? 'draft' : status,
    chapters: normalizeProgramChapters(input.chapters || []),
    published: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  store.programs.unshift(program);
  await writeStore(store);
  return program;
}

export interface CreateLearningCourseInput {
  teacherId: string;
  teacherUsername: string;
  title: string;
  description?: string;
  moduleTitle?: string;
  lessonLines: string[];
}

export async function createLearningCourse(
  input: CreateLearningCourseInput,
): Promise<LearningCourseProgram> {
  const lessons = input.lessonLines
    .map((line) => parseLegacyLessonLine(line))
    .filter((lesson): lesson is NonNullable<typeof lesson> => lesson !== null);

  if (lessons.length === 0) {
    throw new LearningDomainError('LESSONS_REQUIRED');
  }

  return createLearningProgram({
    teacherId: input.teacherId,
    teacherUsername: input.teacherUsername,
    title: input.title,
    description: input.description,
    chapters: [
      {
        title: input.moduleTitle?.trim() || '核心章节',
        description: '',
        lessons: lessons.map((lesson) => ({
          title: lesson.title,
          classroomId: lesson.classroomId,
        })),
      },
    ],
  });
}

export interface UpdateLearningProgramStructureInput {
  teacherId: string;
  programId: string;
  title?: string;
  description?: string;
  targetAudience?: string;
  source?: LearningProgramSource;
  status?: LearningProgramStatus;
  chapters: LearningProgramChapterInput[];
}

export async function updateLearningProgramStructure(
  input: UpdateLearningProgramStructureInput,
): Promise<LearningCourseProgram> {
  const timestamp = nowIso();
  const store = await readStore();
  const program = findProgramOrThrow(store, input.programId);
  ensureTeacherOwnsProgram(program, input.teacherId);

  if (typeof input.title === 'string') {
    program.title = normalizeAndValidateTitle(input.title);
  }

  if (typeof input.description === 'string') {
    program.description = input.description.trim();
  }

  if (typeof input.targetAudience === 'string') {
    program.targetAudience = input.targetAudience.trim() || undefined;
  }

  if (typeof input.source === 'string') {
    program.source = normalizeProgramSource(input.source);
  }

  if (typeof input.status === 'string') {
    const nextStatus = normalizeProgramStatus(input.status);
    if (nextStatus === 'archived') {
      program.status = 'archived';
      program.published = false;
      program.publishedAt = undefined;
    } else if (nextStatus === 'published') {
      program.status = 'published';
      program.published = true;
      program.publishedAt = program.publishedAt || timestamp;
    } else {
      program.status = 'draft';
      program.published = false;
    }
  }

  program.chapters = normalizeProgramChapters(input.chapters || []);
  program.updatedAt = timestamp;

  for (const assignment of store.assignments.filter((item) => item.programId === program.id)) {
    syncAssignmentWithProgram(assignment, program, timestamp);
  }

  await writeStore(store);
  return program;
}

export async function deleteLearningProgram(input: {
  teacherId: string;
  programId: string;
}): Promise<LearningCourseProgram> {
  const store = await readStore();
  const program = findProgramOrThrow(store, input.programId);
  ensureTeacherOwnsProgram(program, input.teacherId);

  store.programs = store.programs.filter((item) => item.id !== program.id);
  store.assignments = store.assignments.filter((item) => item.programId !== program.id);
  store.applications = store.applications.filter((item) => item.programId !== program.id);
  store.generationTasks = store.generationTasks.filter((item) => item.programId !== program.id);

  await writeStore(store);
  return program;
}

export interface BindLearningLessonClassroomInput {
  teacherId: string;
  programId: string;
  lessonId: string;
  classroomId?: string;
  previewUrl?: string;
  generationStatus?: LearningLessonGenerationStatus;
  generationTaskId?: string;
}

export async function bindLearningLessonClassroom(
  input: BindLearningLessonClassroomInput,
): Promise<LearningCourseProgram> {
  const timestamp = nowIso();
  const store = await readStore();
  const program = findProgramOrThrow(store, input.programId);
  ensureTeacherOwnsProgram(program, input.teacherId);

  const found = findLessonInProgram(program, input.lessonId);
  if (!found) {
    throw new LearningDomainError('LESSON_NOT_FOUND');
  }

  const nextClassroomId = input.classroomId?.trim() || undefined;
  found.lesson.classroomId = nextClassroomId;
  found.lesson.previewUrl = input.previewUrl?.trim() || found.lesson.previewUrl;
  found.lesson.lastGenerationTaskId = input.generationTaskId?.trim() || found.lesson.lastGenerationTaskId;
  if (input.generationStatus) {
    found.lesson.generationStatus = normalizeLessonGenerationStatus(input.generationStatus);
  } else {
    found.lesson.generationStatus = nextClassroomId ? 'succeeded' : 'not_started';
  }
  program.updatedAt = timestamp;
  await writeStore(store);
  return program;
}

export async function getLearningProgramDetail(input: {
  teacherId: string;
  programId: string;
}): Promise<LearningCourseProgram> {
  const store = await readStore();
  const program = findProgramOrThrow(store, input.programId);
  ensureTeacherOwnsProgram(program, input.teacherId);
  return program;
}

export async function getLearningProgramDetailByLesson(input: {
  teacherId: string;
  lessonId: string;
}): Promise<{ program: LearningCourseProgram; chapter: LearningChapter; lesson: LearningLesson }> {
  const store = await readStore();
  for (const program of store.programs) {
    if (program.teacherId !== input.teacherId) continue;
    const found = findLessonInProgram(program, input.lessonId);
    if (found) {
      return { program, chapter: found.chapter, lesson: found.lesson };
    }
  }
  throw new LearningDomainError('LESSON_NOT_FOUND');
}

export interface CreateLearningLessonGenerationTaskInput {
  teacherId: string;
  programId: string;
  lessonId: string;
  requirementsText?: string;
  materialsSnapshot?: Array<{ fileId?: string; name?: string }>;
}

export async function createLearningLessonGenerationTask(
  input: CreateLearningLessonGenerationTaskInput,
): Promise<LearningLessonGenerationTask> {
  const timestamp = nowIso();
  const store = await readStore();
  const program = findProgramOrThrow(store, input.programId);
  ensureTeacherOwnsProgram(program, input.teacherId);

  const found = findLessonInProgram(program, input.lessonId);
  if (!found) {
    throw new LearningDomainError('LESSON_NOT_FOUND');
  }

  const task: LearningLessonGenerationTask = {
    id: crypto.randomUUID(),
    lessonId: found.lesson.id,
    programId: program.id,
    teacherUserId: input.teacherId,
    status: 'started',
    requirementsText: input.requirementsText?.trim() || undefined,
    materialsSnapshot: Array.isArray(input.materialsSnapshot)
      ? input.materialsSnapshot.map((item) => ({
          fileId: item.fileId?.trim() || undefined,
          name: item.name?.trim() || undefined,
        }))
      : [],
    launchContext: {
      courseTitle: program.title,
      courseDescription: program.description || undefined,
      chapterTitle: found.chapter.title,
      lessonTitle: found.lesson.title,
      lessonDescription: found.lesson.description || undefined,
      learningObjectives: found.lesson.learningObjectives || [],
      prerequisites: found.lesson.prerequisites || [],
      difficulty: found.lesson.difficulty || 'basic',
      diagnosticTags: found.lesson.diagnosticTags || [],
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  store.generationTasks.unshift(task);
  found.lesson.generationStatus = 'started';
  found.lesson.lastGenerationTaskId = task.id;
  program.updatedAt = timestamp;

  await writeStore(store);
  return task;
}

export async function attachClassroomJobToLearningTask(input: {
  teacherId: string;
  generationTaskId: string;
  classroomJobId: string;
}): Promise<LearningLessonGenerationTask> {
  const timestamp = nowIso();
  const store = await readStore();
  const task = findGenerationTaskOrThrow(store, input.generationTaskId);
  if (task.teacherUserId !== input.teacherId) {
    throw new LearningDomainError('FORBIDDEN');
  }

  const program = findProgramOrThrow(store, task.programId);
  ensureTeacherOwnsProgram(program, input.teacherId);
  const found = findLessonInProgram(program, task.lessonId);
  if (!found) {
    throw new LearningDomainError('LESSON_NOT_FOUND');
  }

  task.classroomJobId = input.classroomJobId.trim();
  task.status = 'processing';
  task.updatedAt = timestamp;

  if (!found.lesson.lastGenerationTaskId || found.lesson.lastGenerationTaskId === task.id) {
    found.lesson.generationStatus = 'processing';
    found.lesson.lastGenerationTaskId = task.id;
  }
  program.updatedAt = timestamp;

  await writeStore(store);
  return task;
}

export interface SyncLearningLessonGenerationTaskInput {
  teacherId: string;
  generationTaskId: string;
  status: LearningLessonGenerationTaskStatus;
  resultClassroomId?: string;
  resultPreviewUrl?: string;
  errorCode?: string;
  errorMessage?: string;
}

export async function syncLearningLessonGenerationTask(
  input: SyncLearningLessonGenerationTaskInput,
): Promise<LearningLessonGenerationTask> {
  const timestamp = nowIso();
  const store = await readStore();
  const task = findGenerationTaskOrThrow(store, input.generationTaskId);
  if (task.teacherUserId !== input.teacherId) {
    throw new LearningDomainError('FORBIDDEN');
  }

  const program = findProgramOrThrow(store, task.programId);
  ensureTeacherOwnsProgram(program, input.teacherId);
  const found = findLessonInProgram(program, task.lessonId);
  if (!found) {
    throw new LearningDomainError('LESSON_NOT_FOUND');
  }

  task.status = input.status;
  task.resultClassroomId = input.resultClassroomId?.trim() || task.resultClassroomId;
  task.resultPreviewUrl = input.resultPreviewUrl?.trim() || task.resultPreviewUrl;
  task.errorCode = input.errorCode?.trim() || undefined;
  task.errorMessage = input.errorMessage?.trim() || undefined;
  task.updatedAt = timestamp;
  if (input.status === 'failed' || input.status === 'succeeded') {
    task.completedAt = timestamp;
  }

  if (!found.lesson.lastGenerationTaskId || found.lesson.lastGenerationTaskId === task.id) {
    found.lesson.lastGenerationTaskId = task.id;
    found.lesson.generationStatus =
      input.status === 'started'
        ? 'started'
        : input.status === 'processing'
          ? 'processing'
          : input.status === 'binding_pending'
            ? 'binding_pending'
            : input.status === 'failed'
              ? 'failed'
              : 'succeeded';
    if (task.resultPreviewUrl) {
      found.lesson.previewUrl = task.resultPreviewUrl;
    }
  }

  program.updatedAt = timestamp;
  await writeStore(store);
  return task;
}

export async function getLearningLessonGenerationTask(input: {
  teacherId: string;
  generationTaskId: string;
}): Promise<LearningLessonGenerationTask> {
  const store = await readStore();
  const task = findGenerationTaskOrThrow(store, input.generationTaskId);
  if (task.teacherUserId !== input.teacherId) {
    throw new LearningDomainError('FORBIDDEN');
  }
  return task;
}

export async function bindLearningLessonClassroomFromGenerationTask(input: {
  teacherId: string;
  generationTaskId: string;
  classroomId?: string;
}): Promise<{ program: LearningCourseProgram; task: LearningLessonGenerationTask }> {
  const timestamp = nowIso();
  const store = await readStore();
  const task = findGenerationTaskOrThrow(store, input.generationTaskId);
  if (task.teacherUserId !== input.teacherId) {
    throw new LearningDomainError('FORBIDDEN');
  }

  const program = findProgramOrThrow(store, task.programId);
  ensureTeacherOwnsProgram(program, input.teacherId);
  const found = findLessonInProgram(program, task.lessonId);
  if (!found) {
    throw new LearningDomainError('LESSON_NOT_FOUND');
  }

  const classroomId = input.classroomId?.trim() || task.resultClassroomId;
  if (!classroomId) {
    throw new LearningDomainError('MISSING_REQUIRED_FIELD');
  }

  found.lesson.classroomId = classroomId;
  found.lesson.previewUrl = task.resultPreviewUrl || found.lesson.previewUrl;
  found.lesson.generationStatus = 'succeeded';
  found.lesson.lastGenerationTaskId = task.id;
  task.status = 'succeeded';
  task.resultClassroomId = classroomId;
  task.updatedAt = timestamp;
  task.completedAt = task.completedAt || timestamp;
  task.errorCode = undefined;
  task.errorMessage = undefined;
  program.updatedAt = timestamp;

  await writeStore(store);
  return { program, task };
}

export async function prepublishLearningProgram(input: {
  teacherId: string;
  programId: string;
}): Promise<LearningPublishWarning[]> {
  const store = await readStore();
  const program = findProgramOrThrow(store, input.programId);
  ensureTeacherOwnsProgram(program, input.teacherId);
  return buildPublishWarnings(program);
}

export async function publishLearningProgram(input: {
  teacherId: string;
  programId: string;
  confirmPublish?: boolean;
}): Promise<{ program: LearningCourseProgram; warnings: LearningPublishWarning[] }> {
  const timestamp = nowIso();
  const store = await readStore();
  const program = findProgramOrThrow(store, input.programId);
  ensureTeacherOwnsProgram(program, input.teacherId);

  const warnings = buildPublishWarnings(program);
  const hasBlockingWarnings = warnings.some((warning) => warning.level === 'warning');

  if (hasBlockingWarnings && !input.confirmPublish) {
    throw new LearningDomainError('PUBLISH_CONFIRM_REQUIRED', warnings);
  }

  program.published = true;
  program.status = 'published';
  program.publishedAt = timestamp;
  program.updatedAt = timestamp;
  await writeStore(store);

  return { program, warnings };
}

export async function publishLearningCourse(input: {
  teacherId: string;
  courseId: string;
}): Promise<LearningCourseProgram> {
  const result = await publishLearningProgram({
    teacherId: input.teacherId,
    programId: input.courseId,
    confirmPublish: true,
  });
  return result.program;
}

export interface AssignLearningProgramInput {
  teacherId: string;
  programId: string;
  studentIds: string[];
}

export async function assignLearningProgramToStudents(
  input: AssignLearningProgramInput,
): Promise<LearningAssignment[]> {
  if (!Array.isArray(input.studentIds) || input.studentIds.length === 0) {
    throw new LearningDomainError('STUDENTS_REQUIRED');
  }

  const timestamp = nowIso();
  const store = await readStore();
  const program = findProgramOrThrow(store, input.programId);
  ensureTeacherOwnsProgram(program, input.teacherId);

  if (!program.published) {
    throw new LearningDomainError('PROGRAM_NOT_PUBLISHED');
  }

  const studentSet = new Set(input.studentIds);
  const users = await listUsers();
  const students = users.filter((user) => user.role === 'student' && studentSet.has(user.id));

  if (students.length === 0) {
    throw new LearningDomainError('STUDENTS_REQUIRED');
  }

  const affectedAssignments: LearningAssignment[] = [];
  for (const student of students) {
    let assignment = store.assignments.find(
      (item) =>
        item.programId === program.id &&
        item.studentId === student.id &&
        item.status !== 'completed',
    );

    if (!assignment) {
      assignment = buildAssignment(
        {
          program,
          studentId: student.id,
          studentUsername: student.username,
          source: 'teacher_assign',
        },
        timestamp,
      );
      store.assignments.push(assignment);
    }

    assignment.lastActivityAt = timestamp;
    syncAssignmentWithProgram(assignment, program, timestamp);
    affectedAssignments.push(assignment);
  }

  await writeStore(store);
  return affectedAssignments;
}

export async function assignLearningCourse(input: {
  teacherId: string;
  courseId: string;
  studentIds: string[];
}): Promise<LearningAssignment[]> {
  return assignLearningProgramToStudents({
    teacherId: input.teacherId,
    programId: input.courseId,
    studentIds: input.studentIds,
  });
}

export async function applyLearningProgram(input: {
  studentId: string;
  studentUsername: string;
  programId: string;
  note?: string;
}): Promise<LearningProgramApplication> {
  const store = await readStore();
  const program = findProgramOrThrow(store, input.programId);
  if (!program.published) {
    throw new LearningDomainError('PROGRAM_NOT_PUBLISHED');
  }

  const existingAssignment = store.assignments.find(
    (assignment) => assignment.programId === program.id && assignment.studentId === input.studentId,
  );
  if (existingAssignment) {
    throw new LearningDomainError('ALREADY_ASSIGNED');
  }

  const existingApplication = store.applications.find(
    (application) =>
      application.programId === program.id &&
      application.studentId === input.studentId &&
      application.status === 'pending',
  );
  if (existingApplication) {
    return existingApplication;
  }

  const application: LearningProgramApplication = {
    id: crypto.randomUUID(),
    programId: program.id,
    teacherId: program.teacherId,
    studentId: input.studentId,
    studentUsername: input.studentUsername,
    status: 'pending',
    note: input.note?.trim() || undefined,
    createdAt: nowIso(),
  };

  store.applications.push(application);
  await writeStore(store);
  return application;
}

export async function reviewLearningApplication(input: {
  teacherId: string;
  applicationId: string;
  decision: 'approved' | 'rejected';
  reviewer: string;
  reviewNote?: string;
}): Promise<{ application: LearningProgramApplication; assignment?: LearningAssignment }> {
  const timestamp = nowIso();
  const store = await readStore();
  const application = store.applications.find((item) => item.id === input.applicationId);

  if (!application) {
    throw new LearningDomainError('APPLICATION_NOT_FOUND');
  }

  if (application.teacherId !== input.teacherId) {
    throw new LearningDomainError('FORBIDDEN');
  }

  if (application.status !== 'pending') {
    throw new LearningDomainError('APPLICATION_ALREADY_REVIEWED');
  }

  application.status = input.decision;
  application.reviewedAt = timestamp;
  application.reviewedBy = input.reviewer;
  application.reviewNote = input.reviewNote?.trim() || undefined;

  let assignment: LearningAssignment | undefined;
  if (input.decision === 'approved') {
    const program = findProgramOrThrow(store, application.programId);
    assignment = store.assignments.find(
      (item) => item.programId === program.id && item.studentId === application.studentId,
    );

    if (!assignment) {
      assignment = buildAssignment(
        {
          program,
          studentId: application.studentId,
          studentUsername: application.studentUsername,
          source: 'student_apply',
        },
        timestamp,
      );
      store.assignments.push(assignment);
    }
  }

  await writeStore(store);
  return { application, assignment };
}

export async function acceptLearningAssignment(input: {
  studentId: string;
  assignmentId: string;
}): Promise<LearningAssignment> {
  const timestamp = nowIso();
  const store = await readStore();
  const assignment = findAssignmentOrThrow(store, input.assignmentId);
  if (assignment.studentId !== input.studentId) {
    throw new LearningDomainError('FORBIDDEN');
  }

  const program = findProgramOrThrow(store, assignment.programId);
  syncAssignmentWithProgram(assignment, program, timestamp);

  if (assignment.status === 'pending_acceptance') {
    assignment.status = 'active';
    assignment.acceptedAt = timestamp;
  }
  assignment.lastActivityAt = timestamp;

  updateAssignmentCompletionStatus(assignment, program, timestamp);

  await writeStore(store);
  return assignment;
}

export async function updateLearningLessonStatus(input: {
  studentId: string;
  assignmentId: string;
  lessonId: string;
  status: LearningLessonProgressStatus;
}): Promise<LearningAssignment> {
  const timestamp = nowIso();
  const store = await readStore();
  const assignment = findAssignmentOrThrow(store, input.assignmentId);
  if (assignment.studentId !== input.studentId) {
    throw new LearningDomainError('FORBIDDEN');
  }

  const program = findProgramOrThrow(store, assignment.programId);
  const lessonRef = findLessonInProgram(program, input.lessonId);
  if (!lessonRef) {
    throw new LearningDomainError('LESSON_NOT_FOUND');
  }

  syncAssignmentWithProgram(assignment, program, timestamp);

  if (assignment.status === 'pending_acceptance') {
    assignment.status = 'active';
    assignment.acceptedAt = assignment.acceptedAt || timestamp;
  }

  const current = assignment.lessonProgress[input.lessonId] || createDefaultProgress(timestamp);
  const next: LearningLessonProgressRecord = {
    ...current,
    status: input.status,
    updatedAt: timestamp,
  };

  if (input.status === 'in_progress') {
    next.inProgressCount = current.status === 'in_progress' ? current.inProgressCount : current.inProgressCount + 1;
    next.startedAt = current.startedAt || timestamp;
    next.completedAt = undefined;
  }

  if (input.status === 'completed') {
    next.startedAt = current.startedAt || timestamp;
    next.completedAt = timestamp;
  }

  if (input.status === 'not_started') {
    next.completedAt = undefined;
  }

  assignment.lessonProgress[input.lessonId] = next;
  assignment.lastActivityAt = timestamp;

  updateAssignmentCompletionStatus(assignment, program, timestamp);

  await writeStore(store);
  return assignment;
}

export async function recordLearningLessonMetrics(input: {
  studentId: string;
  assignmentId: string;
  lessonId: string;
  studySecondsDelta?: number;
  pauseSecondsDelta?: number;
  replaySecondsDelta?: number;
  replayCountDelta?: number;
  aiQuestion?: string;
  aiQuestions?: string[];
}): Promise<LearningAssignment> {
  const timestamp = nowIso();
  const store = await readStore();
  const assignment = findAssignmentOrThrow(store, input.assignmentId);
  if (assignment.studentId !== input.studentId) {
    throw new LearningDomainError('FORBIDDEN');
  }

  const program = findProgramOrThrow(store, assignment.programId);
  const lessonRef = findLessonInProgram(program, input.lessonId);
  if (!lessonRef) {
    throw new LearningDomainError('LESSON_NOT_FOUND');
  }

  syncAssignmentWithProgram(assignment, program, timestamp);

  if (assignment.status === 'pending_acceptance') {
    assignment.status = 'active';
    assignment.acceptedAt = assignment.acceptedAt || timestamp;
  }

  const metrics = assignment.lessonMetrics[input.lessonId] || createDefaultMetrics(timestamp);
  metrics.studySeconds += clampNonNegativeNumber(input.studySecondsDelta);
  metrics.pauseSeconds += clampNonNegativeNumber(input.pauseSecondsDelta);
  metrics.replaySeconds += clampNonNegativeNumber(input.replaySecondsDelta);
  metrics.replayCount += clampNonNegativeNumber(input.replayCountDelta);

  if (input.aiQuestion?.trim()) {
    upsertQuestionFrequency(metrics, input.aiQuestion);
  }
  if (Array.isArray(input.aiQuestions)) {
    for (const question of input.aiQuestions) {
      if (typeof question === 'string' && question.trim()) {
        upsertQuestionFrequency(metrics, question);
      }
    }
  }

  metrics.lastUpdatedAt = timestamp;
  assignment.lessonMetrics[input.lessonId] = metrics;
  assignment.lastActivityAt = timestamp;

  await writeStore(store);
  return assignment;
}

export async function submitLearningQuizResult(input: {
  studentId: string;
  assignmentId: string;
  lessonId: string;
  attempts: number;
  correct: number;
}): Promise<LearningAssignment> {
  const timestamp = nowIso();
  const store = await readStore();
  const assignment = findAssignmentOrThrow(store, input.assignmentId);
  if (assignment.studentId !== input.studentId) {
    throw new LearningDomainError('FORBIDDEN');
  }

  const program = findProgramOrThrow(store, assignment.programId);
  const lessonRef = findLessonInProgram(program, input.lessonId);
  if (!lessonRef) {
    throw new LearningDomainError('LESSON_NOT_FOUND');
  }

  syncAssignmentWithProgram(assignment, program, timestamp);

  if (assignment.status === 'pending_acceptance') {
    assignment.status = 'active';
    assignment.acceptedAt = assignment.acceptedAt || timestamp;
  }

  const metrics = assignment.lessonMetrics[input.lessonId] || createDefaultMetrics(timestamp);
  const attempts = Math.max(0, Math.floor(input.attempts));
  const correct = Math.max(0, Math.min(attempts, Math.floor(input.correct)));

  metrics.quizAttempts += attempts;
  metrics.quizCorrect += correct;
  metrics.lastUpdatedAt = timestamp;

  assignment.lessonMetrics[input.lessonId] = metrics;
  assignment.lastActivityAt = timestamp;

  await writeStore(store);
  return assignment;
}

export async function reportLearningStuckPoint(input: {
  studentId: string;
  assignmentId: string;
  lessonId: string;
  note: string;
}): Promise<LearningAssignment> {
  const note = input.note.trim();
  if (!note) {
    throw new LearningDomainError('NOTE_REQUIRED');
  }

  const timestamp = nowIso();
  const store = await readStore();
  const assignment = findAssignmentOrThrow(store, input.assignmentId);
  if (assignment.studentId !== input.studentId) {
    throw new LearningDomainError('FORBIDDEN');
  }

  const program = findProgramOrThrow(store, assignment.programId);
  const lessonRef = findLessonInProgram(program, input.lessonId);
  if (!lessonRef) {
    throw new LearningDomainError('LESSON_NOT_FOUND');
  }

  if (assignment.status === 'pending_acceptance') {
    assignment.status = 'active';
    assignment.acceptedAt = assignment.acceptedAt || timestamp;
  }

  const stuckId = crypto.randomUUID();

  assignment.stuckPoints.push({
    id: stuckId,
    chapterId: lessonRef.chapter.id,
    chapterTitle: lessonRef.chapter.title,
    lessonId: lessonRef.lesson.id,
    lessonTitle: lessonRef.lesson.title,
    note,
    status: 'open',
    createdAt: timestamp,
  });

  assignment.interventions.push({
    id: crypto.randomUUID(),
    type: 'stuck',
    assignmentId: assignment.id,
    stuckId,
    note,
    status: 'open',
    createdAt: timestamp,
  });

  assignment.lastActivityAt = timestamp;

  await writeStore(store);
  return assignment;
}

export async function resolveLearningStuckPoint(input: {
  teacherId: string;
  assignmentId: string;
  stuckId: string;
  resolver: string;
  resolutionNote?: string;
}): Promise<LearningAssignment> {
  const timestamp = nowIso();
  const store = await readStore();
  const assignment = findAssignmentOrThrow(store, input.assignmentId);
  const program = findProgramOrThrow(store, assignment.programId);

  ensureTeacherOwnsProgram(program, input.teacherId);

  const stuck = assignment.stuckPoints.find((item) => item.id === input.stuckId);
  if (!stuck) {
    throw new LearningDomainError('STUCK_NOT_FOUND');
  }

  stuck.status = 'resolved';
  stuck.resolvedAt = timestamp;
  stuck.resolvedBy = input.resolver;
  stuck.resolutionNote = input.resolutionNote?.trim() || undefined;

  for (const intervention of assignment.interventions) {
    if (intervention.type === 'stuck' && intervention.stuckId === input.stuckId) {
      intervention.status = 'resolved';
      intervention.resolvedAt = timestamp;
      intervention.resolvedBy = input.resolver;
    }
  }

  assignment.lastActivityAt = timestamp;
  await writeStore(store);
  return assignment;
}

export async function resolveLearningRiskSignal(input: {
  teacherId: string;
  assignmentId: string;
  riskKey: string;
  resolver: string;
  resolutionNote?: string;
}): Promise<LearningAssignment> {
  const timestamp = nowIso();
  const store = await readStore();
  const assignment = findAssignmentOrThrow(store, input.assignmentId);
  const program = findProgramOrThrow(store, assignment.programId);

  ensureTeacherOwnsProgram(program, input.teacherId);

  if (!assignment.resolvedRiskKeys.includes(input.riskKey)) {
    assignment.resolvedRiskKeys.push(input.riskKey);
  }

  assignment.interventions.push({
    id: crypto.randomUUID(),
    type: 'risk',
    assignmentId: assignment.id,
    riskKey: input.riskKey,
    note: input.resolutionNote?.trim() || '老师已介入风险项',
    status: 'resolved',
    createdAt: timestamp,
    resolvedAt: timestamp,
    resolvedBy: input.resolver,
  });

  assignment.lastActivityAt = timestamp;
  await writeStore(store);
  return assignment;
}

function toTeacherAssignmentSummary(
  assignment: LearningAssignment,
  program: LearningCourseProgram,
): Omit<TeacherAssignmentSummary, 'riskSignals'> {
  const progress = summarizeProgramProgress(assignment, program);
  const chapterSummaries = buildChapterSummaries(assignment, program);
  const behaviorSummary = buildBehaviorSummary(chapterSummaries);

  return {
    assignment,
    program,
    totalLessons: progress.totalLessons,
    completedLessons: progress.completedLessons,
    progressPercent: progress.progressPercent,
    openStuckCount: assignment.stuckPoints.filter((stuck) => stuck.status === 'open').length,
    chapterSummaries,
    behaviorSummary,
  };
}

function buildTeacherInterventionInbox(
  summaries: TeacherAssignmentSummary[],
): TeacherInterventionItem[] {
  const inbox: TeacherInterventionItem[] = [];

  for (const summary of summaries) {
    const openStuck = summary.assignment.stuckPoints.filter((stuck) => stuck.status === 'open');
    for (const stuck of openStuck) {
      inbox.push({
        id: `stuck:${stuck.id}`,
        type: 'stuck',
        assignmentId: summary.assignment.id,
        studentId: summary.assignment.studentId,
        studentUsername: summary.assignment.studentUsername,
        programId: summary.program.id,
        programTitle: summary.program.title,
        chapterId: stuck.chapterId,
        chapterTitle: stuck.chapterTitle,
        lessonId: stuck.lessonId,
        lessonTitle: stuck.lessonTitle,
        stuckId: stuck.id,
        note: stuck.note,
        createdAt: stuck.createdAt,
      });
    }

    for (const risk of summary.riskSignals) {
      if (summary.assignment.resolvedRiskKeys.includes(risk.key)) {
        continue;
      }

      inbox.push({
        id: `risk:${summary.assignment.id}:${risk.key}`,
        type: 'risk',
        assignmentId: summary.assignment.id,
        studentId: summary.assignment.studentId,
        studentUsername: summary.assignment.studentUsername,
        programId: summary.program.id,
        programTitle: summary.program.title,
        chapterId: risk.chapterId,
        chapterTitle: risk.chapterTitle,
        lessonId: risk.lessonId,
        lessonTitle: risk.lessonTitle,
        riskKey: risk.key,
        riskCode: risk.code,
        riskLevel: risk.level,
        note: risk.message,
        createdAt: summary.assignment.lastActivityAt,
      });
    }
  }

  return inbox.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function ensureRoleCanUseTeacherView(user: Pick<AuthUserRecord, 'role'>) {
  if (user.role !== 'teacher' && user.role !== 'admin') {
    throw new LearningDomainError('FORBIDDEN');
  }
}

export async function getTeacherLearningView(
  user: Pick<AuthUserRecord, 'id' | 'role' | 'username'>,
): Promise<TeacherLearningView> {
  ensureRoleCanUseTeacherView(user);

  const store = await readStore();
  const students = await listStudentUsers();

  const managedPrograms =
    user.role === 'admin' ? store.programs : store.programs.filter((program) => program.teacherId === user.id);

  const managedProgramIds = new Set(managedPrograms.map((program) => program.id));
  const managedAssignments = store.assignments.filter((assignment) =>
    managedProgramIds.has(assignment.programId),
  );

  const managedApplications = store.applications.filter((application) =>
    managedProgramIds.has(application.programId),
  );

  const summariesBase = managedAssignments
    .map((assignment) => {
      const program = managedPrograms.find((item) => item.id === assignment.programId);
      if (!program) return null;
      syncAssignmentWithProgram(assignment, program, nowIso());
      return toTeacherAssignmentSummary(assignment, program);
    })
    .filter(
      (summary): summary is Omit<TeacherAssignmentSummary, 'riskSignals'> => summary !== null,
    );

  const cohortStats = buildChapterCohortStats(
    summariesBase.map((item) => ({
      program: item.program,
      chapterSummaries: item.chapterSummaries,
    })),
  );

  const assignments: TeacherAssignmentSummary[] = summariesBase.map((item) => {
    const riskSignals = buildRiskSignals(
      item.assignment,
      item.program,
      item.chapterSummaries,
      cohortStats,
    );

    return {
      ...item,
      riskSignals,
    };
  });

  const programs: TeacherProgramSummary[] = managedPrograms.map((program) => {
    const programAssignments = managedAssignments.filter((assignment) => assignment.programId === program.id);
    const pendingApplicationCount = managedApplications.filter(
      (application) => application.programId === program.id && application.status === 'pending',
    ).length;

    return {
      program,
      assignedCount: programAssignments.length,
      activeCount: programAssignments.filter((assignment) => assignment.status === 'active').length,
      completedCount: programAssignments.filter((assignment) => assignment.status === 'completed').length,
      pendingApplicationCount,
      publishWarnings: buildPublishWarnings(program),
    };
  });

  const interventionInbox = buildTeacherInterventionInbox(assignments);

  return {
    programs,
    assignments,
    interventionInbox,
    students,
    applications: managedApplications.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  };
}

function buildStudentCourseView(
  assignment: LearningAssignment,
  program: LearningCourseProgram,
  cohortStats: Map<string, ChapterCohortStat>,
): StudentCourseView {
  const summary = toTeacherAssignmentSummary(assignment, program);

  return {
    assignment,
    program,
    totalLessons: summary.totalLessons,
    completedLessons: summary.completedLessons,
    progressPercent: summary.progressPercent,
    chapterSummaries: summary.chapterSummaries,
    behaviorSummary: summary.behaviorSummary,
    riskSignals: buildRiskSignals(assignment, program, summary.chapterSummaries, cohortStats),
    pendingStuckCount: assignment.stuckPoints.filter((stuck) => stuck.status === 'open').length,
  };
}

export async function getStudentLearningView(
  user: Pick<AuthUserRecord, 'id' | 'role' | 'username'>,
): Promise<StudentLearningView> {
  const store = await readStore();

  const assignments = store.assignments.filter((assignment) => assignment.studentId === user.id);

  const baseSummaries = assignments
    .map((assignment) => {
      const program = store.programs.find((item) => item.id === assignment.programId);
      if (!program) return null;
      syncAssignmentWithProgram(assignment, program, nowIso());
      return {
        assignment,
        program,
        chapterSummaries: buildChapterSummaries(assignment, program),
      };
    })
    .filter(
      (
        item,
      ): item is {
        assignment: LearningAssignment;
        program: LearningCourseProgram;
        chapterSummaries: LearningChapterProgressSummary[];
      } => item !== null,
    );

  const cohortStats = buildChapterCohortStats(
    baseSummaries.map((item) => ({
      program: item.program,
      chapterSummaries: item.chapterSummaries,
    })),
  );

  const assignmentViews = baseSummaries.map((item) =>
    buildStudentCourseView(item.assignment, item.program, cohortStats),
  );

  const assignedProgramIds = new Set(assignments.map((assignment) => assignment.programId));
  const studentApplications = store.applications.filter((application) => application.studentId === user.id);

  const pendingAppliedProgramIds = new Set(
    studentApplications
      .filter((application) => application.status === 'pending')
      .map((application) => application.programId),
  );

  const availablePrograms = store.programs.filter(
    (program) =>
      program.published &&
      !assignedProgramIds.has(program.id) &&
      !pendingAppliedProgramIds.has(program.id),
  );

  return {
    assignments: assignmentViews.sort(
      (a, b) => b.assignment.lastActivityAt.localeCompare(a.assignment.lastActivityAt),
    ),
    availablePrograms,
    applications: studentApplications.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  };
}

function ratio01(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 1000) / 1000;
}

export async function getLearningSyllabusAnalytics(input: {
  teacherId: string;
  programId: string;
}): Promise<LearningSyllabusAnalytics> {
  const store = await readStore();
  const program = findProgramOrThrow(store, input.programId);
  ensureTeacherOwnsProgram(program, input.teacherId);

  const assignments = store.assignments.filter((assignment) => assignment.programId === program.id);
  const lessons = getProgramLessons(program);

  const lessonRows: LearningLessonAnalyticsRow[] = lessons.map((lesson) => {
    let completed = 0;
    let totalStudySeconds = 0;
    let quizAttempts = 0;
    let quizCorrect = 0;
    let strugglingStudentCount = 0;
    const tagScore = new Map<string, number>();

    for (const assignment of assignments) {
      const progress = assignment.lessonProgress[lesson.id];
      const metrics = assignment.lessonMetrics[lesson.id];
      const openStuckCount = assignment.stuckPoints.filter(
        (stuck) => stuck.lessonId === lesson.id && stuck.status === 'open',
      ).length;

      if (progress?.status === 'completed') {
        completed += 1;
      }

      if (metrics) {
        totalStudySeconds += metrics.studySeconds;
        quizAttempts += metrics.quizAttempts;
        quizCorrect += metrics.quizCorrect;
      }

      const repeatedQuestions = (metrics?.aiRepeatedQuestionTotal || 0) >= 3;
      const lowAccuracy =
        (metrics?.quizAttempts || 0) > 0 &&
        (metrics?.quizCorrect || 0) / Math.max(1, metrics?.quizAttempts || 0) < 0.6;
      const longStudy = (metrics?.studySeconds || 0) >= 1800;
      if (openStuckCount > 0 || repeatedQuestions || (lowAccuracy && longStudy)) {
        strugglingStudentCount += 1;
        for (const tag of lesson.diagnosticTags) {
          tagScore.set(tag, (tagScore.get(tag) || 0) + 1);
        }
      }
    }

    const topErrorTags =
      [...tagScore.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([tag]) => tag) || [];

    return {
      lessonId: lesson.id,
      title: lesson.title,
      completionRate: ratio01(completed, assignments.length),
      averageTimeSpentSec:
        assignments.length > 0 ? Math.round(totalStudySeconds / assignments.length) : 0,
      quizAccuracy: quizAttempts > 0 ? ratio01(quizCorrect, quizAttempts) : null,
      strugglingStudentCount,
      topErrorTags,
    };
  });

  const totalCompleted = assignments.reduce(
    (acc, assignment) =>
      acc +
      lessons.reduce(
        (lessonAcc, lesson) =>
          lessonAcc + (assignment.lessonProgress[lesson.id]?.status === 'completed' ? 1 : 0),
        0,
      ),
    0,
  );
  const totalLessonSlots = assignments.length * lessons.length;
  const totalQuizAttempts = assignments.reduce(
    (acc, assignment) =>
      acc +
      lessons.reduce(
        (lessonAcc, lesson) => lessonAcc + (assignment.lessonMetrics[lesson.id]?.quizAttempts || 0),
        0,
      ),
    0,
  );
  const totalQuizCorrect = assignments.reduce(
    (acc, assignment) =>
      acc +
      lessons.reduce(
        (lessonAcc, lesson) => lessonAcc + (assignment.lessonMetrics[lesson.id]?.quizCorrect || 0),
        0,
      ),
    0,
  );

  return {
    summary: {
      studentCount: assignments.length,
      completionRate: ratio01(totalCompleted, totalLessonSlots),
      averageAccuracy: totalQuizAttempts > 0 ? ratio01(totalQuizCorrect, totalQuizAttempts) : null,
    },
    lessons: lessonRows,
  };
}
