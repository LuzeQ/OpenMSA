export type LearningEnrollmentStatus = 'pending_acceptance' | 'active' | 'completed';

export type LearningAssignmentSource = 'teacher_assign' | 'student_apply';

export type LearningApplicationStatus = 'pending' | 'approved' | 'rejected';

export type LearningLessonProgressStatus = 'not_started' | 'in_progress' | 'completed';

export type LearningProgramStatus = 'draft' | 'published' | 'archived';

export type LearningProgramSource = 'manual' | 'ai_generated' | 'mixed';

export type LearningLessonDifficulty = 'basic' | 'intermediate' | 'advanced';

export type LearningLessonGenerationStatus =
  | 'not_started'
  | 'started'
  | 'processing'
  | 'binding_pending'
  | 'succeeded'
  | 'failed';

export type LearningLessonGenerationTaskStatus =
  | 'started'
  | 'processing'
  | 'binding_pending'
  | 'succeeded'
  | 'failed';

export type LearningStuckStatus = 'open' | 'resolved';

export type LearningWarningLevel = 'info' | 'warning';

export type LearningRiskLevel = 'low' | 'medium' | 'high';

export type LearningWeaknessSeverity = 'low' | 'medium' | 'high';

export type LearningRecommendationType =
  | 'complete_profile'
  | 'strengthen_weakness'
  | 'review_risk'
  | 'apply_program'
  | 'continue_learning';

export type LearningRecommendationPriority = 'low' | 'medium' | 'high';

export interface LearningPublishWarning {
  code: string;
  level: LearningWarningLevel;
  message: string;
  chapterId?: string;
  lessonId?: string;
}

export interface LearningLesson {
  id: string;
  title: string;
  description: string;
  order: number;
  learningObjectives: string[];
  prerequisites: string[];
  difficulty: LearningLessonDifficulty;
  diagnosticTags: string[];
  generationStatus: LearningLessonGenerationStatus;
  classroomId?: string;
  previewUrl?: string;
  lastGenerationTaskId?: string;
}

export interface LearningChapter {
  id: string;
  title: string;
  description: string;
  order: number;
  lessons: LearningLesson[];
}

export interface LearningCourseProgram {
  id: string;
  teacherId: string;
  teacherUsername: string;
  title: string;
  description: string;
  targetAudience?: string;
  source: LearningProgramSource;
  status: LearningProgramStatus;
  chapters: LearningChapter[];
  published: boolean;
  publishedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface LearningLessonGenerationTask {
  id: string;
  lessonId: string;
  programId: string;
  teacherUserId: string;
  status: LearningLessonGenerationTaskStatus;
  requirementsText?: string;
  materialsSnapshot?: Array<{ fileId?: string; name?: string }>;
  launchContext: {
    courseTitle: string;
    courseDescription?: string;
    chapterTitle: string;
    lessonTitle: string;
    lessonDescription?: string;
    learningObjectives: string[];
    prerequisites: string[];
    difficulty: LearningLessonDifficulty;
    diagnosticTags: string[];
  };
  classroomJobId?: string;
  resultClassroomId?: string;
  resultPreviewUrl?: string;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface LearningLessonProgressRecord {
  status: LearningLessonProgressStatus;
  inProgressCount: number;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface LearningLessonMetrics {
  studySeconds: number;
  pauseSeconds: number;
  replaySeconds: number;
  replayCount: number;
  quizAttempts: number;
  quizCorrect: number;
  aiQuestionTotal: number;
  aiRepeatedQuestionTotal: number;
  aiQuestionFrequency: Record<string, number>;
  lastUpdatedAt: string;
}

export interface LearningStuckPoint {
  id: string;
  chapterId: string;
  chapterTitle: string;
  lessonId: string;
  lessonTitle: string;
  note: string;
  status: LearningStuckStatus;
  createdAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  resolutionNote?: string;
}

export interface LearningIntervention {
  id: string;
  type: 'stuck' | 'risk';
  assignmentId: string;
  note: string;
  status: 'open' | 'resolved';
  createdAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  stuckId?: string;
  riskKey?: string;
}

export interface LearningRiskSignal {
  key: string;
  code: string;
  level: LearningRiskLevel;
  message: string;
  chapterId?: string;
  chapterTitle?: string;
  lessonId?: string;
  lessonTitle?: string;
}

export interface LearningAssignment {
  id: string;
  programId: string;
  teacherId: string;
  studentId: string;
  studentUsername: string;
  source: LearningAssignmentSource;
  status: LearningEnrollmentStatus;
  assignedAt: string;
  acceptedAt?: string;
  completedAt?: string;
  lastActivityAt: string;
  lessonProgress: Record<string, LearningLessonProgressRecord>;
  lessonMetrics: Record<string, LearningLessonMetrics>;
  stuckPoints: LearningStuckPoint[];
  interventions: LearningIntervention[];
  resolvedRiskKeys: string[];
}

export interface LearningProgramApplication {
  id: string;
  programId: string;
  teacherId: string;
  studentId: string;
  studentUsername: string;
  status: LearningApplicationStatus;
  note?: string;
  createdAt: string;
  reviewedAt?: string;
  reviewedBy?: string;
  reviewNote?: string;
}

export interface LearningGoal {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface LearningPreference {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface LearningWeakness {
  id: string;
  title: string;
  severity: LearningWeaknessSeverity;
  evidence?: string;
  createdAt: string;
  updatedAt: string;
}

export interface LearningStudentProfile {
  studentId: string;
  studentUsername: string;
  goals: LearningGoal[];
  preferences: LearningPreference[];
  weaknesses: LearningWeakness[];
  createdAt: string;
  updatedAt: string;
}

export interface LearningRecommendation {
  id: string;
  type: LearningRecommendationType;
  priority: LearningRecommendationPriority;
  title: string;
  description: string;
  reason: string;
  actionLabel?: string;
  programId?: string;
  assignmentId?: string;
  chapterId?: string;
  lessonId?: string;
}

export interface LearningStoreData {
  version: 3;
  programs: LearningCourseProgram[];
  assignments: LearningAssignment[];
  applications: LearningProgramApplication[];
  generationTasks: LearningLessonGenerationTask[];
  studentProfiles: LearningStudentProfile[];
}

export interface LearningLessonAnalyticsRow {
  lessonId: string;
  title: string;
  completionRate: number;
  averageTimeSpentSec: number;
  quizAccuracy: number | null;
  strugglingStudentCount: number;
  topErrorTags: string[];
}

export interface LearningSyllabusAnalytics {
  summary: {
    studentCount: number;
    completionRate: number;
    averageAccuracy: number | null;
  };
  lessons: LearningLessonAnalyticsRow[];
}

export interface LearningChapterProgressSummary {
  chapterId: string;
  chapterTitle: string;
  totalLessons: number;
  completedLessons: number;
  progressPercent: number;
  studySeconds: number;
  pauseSeconds: number;
  replaySeconds: number;
  replayCount: number;
  quizAttempts: number;
  quizCorrect: number;
  quizAccuracy: number | null;
  aiQuestionTotal: number;
  aiRepeatedQuestionTotal: number;
}

export interface LearningBehaviorSummary {
  studySeconds: number;
  pauseSeconds: number;
  replaySeconds: number;
  replayCount: number;
  quizAttempts: number;
  quizCorrect: number;
  quizAccuracy: number | null;
  aiQuestionTotal: number;
  aiRepeatedQuestionTotal: number;
}

export interface TeacherProgramSummary {
  program: LearningCourseProgram;
  assignedCount: number;
  activeCount: number;
  completedCount: number;
  pendingApplicationCount: number;
  publishWarnings: LearningPublishWarning[];
}

export interface TeacherAssignmentSummary {
  assignment: LearningAssignment;
  program: LearningCourseProgram;
  totalLessons: number;
  completedLessons: number;
  progressPercent: number;
  openStuckCount: number;
  chapterSummaries: LearningChapterProgressSummary[];
  behaviorSummary: LearningBehaviorSummary;
  riskSignals: LearningRiskSignal[];
}

export interface TeacherInterventionItem {
  id: string;
  type: 'stuck' | 'risk';
  assignmentId: string;
  studentId: string;
  studentUsername: string;
  programId: string;
  programTitle: string;
  chapterId?: string;
  chapterTitle?: string;
  lessonId?: string;
  lessonTitle?: string;
  stuckId?: string;
  riskKey?: string;
  riskCode?: string;
  riskLevel?: LearningRiskLevel;
  note: string;
  createdAt: string;
}

export interface TeacherLearningView {
  programs: TeacherProgramSummary[];
  assignments: TeacherAssignmentSummary[];
  interventionInbox: TeacherInterventionItem[];
  students: Array<{ id: string; username: string; role: string }>;
  applications: LearningProgramApplication[];
  studentProfiles: LearningStudentProfile[];
}

export interface StudentCourseView {
  assignment: LearningAssignment;
  program: LearningCourseProgram;
  totalLessons: number;
  completedLessons: number;
  progressPercent: number;
  chapterSummaries: LearningChapterProgressSummary[];
  behaviorSummary: LearningBehaviorSummary;
  riskSignals: LearningRiskSignal[];
  pendingStuckCount: number;
}

export interface StudentLearningView {
  assignments: StudentCourseView[];
  availablePrograms: LearningCourseProgram[];
  applications: LearningProgramApplication[];
  profile?: LearningStudentProfile;
  recommendations: LearningRecommendation[];
}

// Backward-compatible aliases used by pre-existing code paths.
export type LearningCourse = LearningCourseProgram;
export type LearningCourseModule = LearningChapter;
export type TeacherCourseSummary = TeacherProgramSummary;
