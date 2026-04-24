import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'path';
import { promises as fs } from 'fs';
import type { AuthUserRecord } from '@/lib/server/auth/types';

const { listUsersMock } = vi.hoisted(() => ({
  listUsersMock: vi.fn(),
}));

vi.mock('@/lib/server/auth/storage', () => ({
  listUsers: listUsersMock,
}));

const TEACHER: AuthUserRecord = {
  id: 'teacher-1',
  username: 'teacher_a',
  role: 'teacher',
  passwordHash: '',
  passwordSalt: '',
  createdAt: '2026-01-01T00:00:00.000Z',
};

const STUDENT: AuthUserRecord = {
  id: 'student-1',
  username: 'student_a',
  role: 'student',
  passwordHash: '',
  passwordSalt: '',
  createdAt: '2026-01-01T00:00:00.000Z',
};

const STUDENT_2: AuthUserRecord = {
  id: 'student-2',
  username: 'student_b',
  role: 'student',
  passwordHash: '',
  passwordSalt: '',
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('learning store', () => {
  let storeFilePath = '';

  beforeEach(async () => {
    vi.resetModules();
    listUsersMock.mockReset();
    listUsersMock.mockResolvedValue([STUDENT, STUDENT_2]);

    const baseDir = path.join(process.cwd(), 'tmp', 'learning-tests');
    await fs.mkdir(baseDir, { recursive: true });
    storeFilePath = path.join(baseDir, `store-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    process.env.LEARNING_DATA_FILE = storeFilePath;
  });

  afterEach(async () => {
    delete process.env.LEARNING_DATA_FILE;
    if (storeFilePath) {
      await fs.rm(storeFilePath, { force: true });
    }
  });

  it('supports teacher create -> prepublish check -> confirm publish -> assign flow', async () => {
    const {
      assignLearningProgramToStudents,
      createLearningProgram,
      getTeacherLearningView,
      prepublishLearningProgram,
      publishLearningProgram,
    } = await import('@/lib/server/learning-store');

    const program = await createLearningProgram({
      teacherId: TEACHER.id,
      teacherUsername: TEACHER.username,
      title: '浮力体系课',
      description: '基础到应用',
      chapters: [
        {
          title: '浮力概念',
          description: '建立核心概念',
          lessons: [
            { title: '浮力概念导入' },
            { title: '阿基米德原理推导', classroomId: 'classroom_001' },
          ],
        },
      ],
    });

    expect(program.published).toBe(false);
    expect(program.chapters[0].lessons).toHaveLength(2);

    const warnings = await prepublishLearningProgram({
      teacherId: TEACHER.id,
      programId: program.id,
    });
    expect(warnings.some((warning) => warning.code === 'LESSON_CLASSROOM_UNBOUND')).toBe(true);

    await expect(
      publishLearningProgram({
        teacherId: TEACHER.id,
        programId: program.id,
        confirmPublish: false,
      }),
    ).rejects.toMatchObject({ code: 'PUBLISH_CONFIRM_REQUIRED' });

    const published = await publishLearningProgram({
      teacherId: TEACHER.id,
      programId: program.id,
      confirmPublish: true,
    });
    expect(published.program.published).toBe(true);

    const assignments = await assignLearningProgramToStudents({
      teacherId: TEACHER.id,
      programId: program.id,
      studentIds: [STUDENT.id],
    });
    expect(assignments).toHaveLength(1);
    expect(assignments[0].status).toBe('pending_acceptance');

    const teacherView = await getTeacherLearningView(TEACHER);
    expect(teacherView.programs).toHaveLength(1);
    expect(teacherView.programs[0].assignedCount).toBe(1);
  });

  it('supports student learning metrics + quiz + risk + intervention resolve flow', async () => {
    const {
      acceptLearningAssignment,
      assignLearningProgramToStudents,
      createLearningProgram,
      getTeacherLearningView,
      publishLearningProgram,
      recordLearningLessonMetrics,
      reportLearningStuckPoint,
      resolveLearningRiskSignal,
      resolveLearningStuckPoint,
      submitLearningQuizResult,
      updateLearningLessonStatus,
    } = await import('@/lib/server/learning-store');

    const program = await createLearningProgram({
      teacherId: TEACHER.id,
      teacherUsername: TEACHER.username,
      title: '电学体系课',
      description: '电学基础能力训练',
      chapters: [
        {
          title: '电流与电压',
          description: '',
          lessons: [
            { title: '电流基础', classroomId: 'classroom_e_001' },
            { title: '欧姆定律练习', classroomId: 'classroom_e_002' },
          ],
        },
      ],
    });

    await publishLearningProgram({
      teacherId: TEACHER.id,
      programId: program.id,
      confirmPublish: true,
    });

    const [assignment] = await assignLearningProgramToStudents({
      teacherId: TEACHER.id,
      programId: program.id,
      studentIds: [STUDENT.id],
    });

    const lessonA = program.chapters[0].lessons[0].id;
    const lessonB = program.chapters[0].lessons[1].id;

    await acceptLearningAssignment({
      studentId: STUDENT.id,
      assignmentId: assignment.id,
    });

    await updateLearningLessonStatus({
      studentId: STUDENT.id,
      assignmentId: assignment.id,
      lessonId: lessonA,
      status: 'in_progress',
    });

    await recordLearningLessonMetrics({
      studentId: STUDENT.id,
      assignmentId: assignment.id,
      lessonId: lessonA,
      studySecondsDelta: 2400,
      pauseSecondsDelta: 1600,
      replaySecondsDelta: 900,
      replayCountDelta: 4,
      aiQuestions: [
        '欧姆定律怎么推导',
        '欧姆定律怎么推导',
        '欧姆定律怎么推导',
        '欧姆定律怎么推导',
        '欧姆定律怎么推导',
        '欧姆定律怎么推导',
      ],
    });

    await submitLearningQuizResult({
      studentId: STUDENT.id,
      assignmentId: assignment.id,
      lessonId: lessonA,
      attempts: 5,
      correct: 2,
    });

    await reportLearningStuckPoint({
      studentId: STUDENT.id,
      assignmentId: assignment.id,
      lessonId: lessonB,
      note: '不知道如何套用公式',
    });

    let teacherView = await getTeacherLearningView(TEACHER);
    const currentAssignment = teacherView.assignments.find((item) => item.assignment.id === assignment.id);

    expect(currentAssignment).toBeDefined();
    expect(currentAssignment?.riskSignals.length).toBeGreaterThan(0);
    expect(teacherView.interventionInbox.some((item) => item.type === 'stuck')).toBe(true);

    const stuckItem = teacherView.interventionInbox.find((item) => item.type === 'stuck');
    expect(stuckItem?.stuckId).toBeTruthy();

    await resolveLearningStuckPoint({
      teacherId: TEACHER.id,
      assignmentId: assignment.id,
      stuckId: stuckItem!.stuckId!,
      resolver: TEACHER.username,
      resolutionNote: '已安排针对性答疑',
    });

    const riskItem = teacherView.interventionInbox.find((item) => item.type === 'risk');
    expect(riskItem?.riskKey).toBeTruthy();

    await resolveLearningRiskSignal({
      teacherId: TEACHER.id,
      assignmentId: assignment.id,
      riskKey: riskItem!.riskKey!,
      resolver: TEACHER.username,
      resolutionNote: '已安排课后辅导',
    });

    await updateLearningLessonStatus({
      studentId: STUDENT.id,
      assignmentId: assignment.id,
      lessonId: lessonA,
      status: 'completed',
    });
    await updateLearningLessonStatus({
      studentId: STUDENT.id,
      assignmentId: assignment.id,
      lessonId: lessonB,
      status: 'completed',
    });

    teacherView = await getTeacherLearningView(TEACHER);
    const finalAssignment = teacherView.assignments.find((item) => item.assignment.id === assignment.id);

    expect(finalAssignment?.assignment.status).toBe('completed');
    expect(finalAssignment?.progressPercent).toBe(100);
    expect(teacherView.interventionInbox.some((item) => item.assignmentId === assignment.id)).toBe(false);
  });

  it('supports student apply -> teacher review -> assignment generation flow', async () => {
    const {
      applyLearningProgram,
      createLearningProgram,
      getStudentLearningView,
      getTeacherLearningView,
      publishLearningProgram,
      reviewLearningApplication,
    } = await import('@/lib/server/learning-store');

    const program = await createLearningProgram({
      teacherId: TEACHER.id,
      teacherUsername: TEACHER.username,
      title: '函数综合体系课',
      description: '',
      chapters: [
        {
          title: '函数图像',
          description: '',
          lessons: [{ title: '一次函数图像' }],
        },
      ],
    });

    await publishLearningProgram({
      teacherId: TEACHER.id,
      programId: program.id,
      confirmPublish: true,
    });

    const application = await applyLearningProgram({
      studentId: STUDENT_2.id,
      studentUsername: STUDENT_2.username,
      programId: program.id,
      note: '我想提前预习这部分',
    });
    expect(application.status).toBe('pending');

    let teacherView = await getTeacherLearningView(TEACHER);
    expect(teacherView.applications.some((item) => item.id === application.id)).toBe(true);

    const reviewResult = await reviewLearningApplication({
      teacherId: TEACHER.id,
      applicationId: application.id,
      decision: 'approved',
      reviewer: TEACHER.username,
      reviewNote: '通过，加入本周学习计划',
    });

    expect(reviewResult.application.status).toBe('approved');
    expect(reviewResult.assignment).toBeDefined();

    const studentView = await getStudentLearningView(STUDENT_2);
    expect(studentView.assignments).toHaveLength(1);
    expect(studentView.assignments[0].assignment.status).toBe('pending_acceptance');

    teacherView = await getTeacherLearningView(TEACHER);
    const pendingApps = teacherView.applications.filter((item) => item.status === 'pending');
    expect(pendingApps).toHaveLength(0);
  });

  it('supports lesson generation task lifecycle and classroom bind backfill', async () => {
    const {
      attachClassroomJobToLearningTask,
      bindLearningLessonClassroomFromGenerationTask,
      createLearningLessonGenerationTask,
      createLearningProgram,
      getLearningLessonGenerationTask,
      getLearningProgramDetail,
      syncLearningLessonGenerationTask,
    } = await import('@/lib/server/learning-store');

    const program = await createLearningProgram({
      teacherId: TEACHER.id,
      teacherUsername: TEACHER.username,
      title: '几何图形智能自学',
      description: '从基础图形到证明',
      targetAudience: '初一学生',
      source: 'ai_generated',
      chapters: [
        {
          title: '三角形基础',
          description: '认识分类与性质',
          lessons: [
            {
              title: '三角形分类',
              description: '按边和角分类',
              learningObjectives: ['理解三角形分类规则'],
              prerequisites: ['线段与角基础'],
              difficulty: 'basic',
              diagnosticTags: ['分类', '性质'],
            },
          ],
        },
      ],
    });

    const lesson = program.chapters[0].lessons[0];
    expect(lesson.learningObjectives).toEqual(['理解三角形分类规则']);
    expect(lesson.difficulty).toBe('basic');

    const task = await createLearningLessonGenerationTask({
      teacherId: TEACHER.id,
      programId: program.id,
      lessonId: lesson.id,
      requirementsText: '增加生活化案例',
    });
    expect(task.status).toBe('started');

    await attachClassroomJobToLearningTask({
      teacherId: TEACHER.id,
      generationTaskId: task.id,
      classroomJobId: 'job_abc123',
    });

    await syncLearningLessonGenerationTask({
      teacherId: TEACHER.id,
      generationTaskId: task.id,
      status: 'binding_pending',
      resultClassroomId: 'classroom_geo_001',
      resultPreviewUrl: '/classroom/classroom_geo_001',
    });

    const pendingTask = await getLearningLessonGenerationTask({
      teacherId: TEACHER.id,
      generationTaskId: task.id,
    });
    expect(pendingTask.status).toBe('binding_pending');
    expect(pendingTask.resultClassroomId).toBe('classroom_geo_001');

    const firstBind = await bindLearningLessonClassroomFromGenerationTask({
      teacherId: TEACHER.id,
      generationTaskId: task.id,
    });
    expect(firstBind.task.status).toBe('succeeded');
    expect(firstBind.task.resultClassroomId).toBe('classroom_geo_001');

    // Idempotent: bind again with the same task should keep success state.
    const secondBind = await bindLearningLessonClassroomFromGenerationTask({
      teacherId: TEACHER.id,
      generationTaskId: task.id,
    });
    expect(secondBind.task.status).toBe('succeeded');

    const refreshed = await getLearningProgramDetail({
      teacherId: TEACHER.id,
      programId: program.id,
    });
    const refreshedLesson = refreshed.chapters[0].lessons[0];
    expect(refreshedLesson.classroomId).toBe('classroom_geo_001');
    expect(refreshedLesson.generationStatus).toBe('succeeded');
  });

  it('aggregates lesson-level syllabus analytics', async () => {
    const {
      acceptLearningAssignment,
      assignLearningProgramToStudents,
      createLearningProgram,
      getLearningSyllabusAnalytics,
      publishLearningProgram,
      recordLearningLessonMetrics,
      reportLearningStuckPoint,
      submitLearningQuizResult,
      updateLearningLessonStatus,
    } = await import('@/lib/server/learning-store');

    const program = await createLearningProgram({
      teacherId: TEACHER.id,
      teacherUsername: TEACHER.username,
      title: '函数与图像',
      description: '线性函数与应用',
      chapters: [
        {
          title: '一次函数',
          lessons: [
            {
              title: '一次函数概念',
              diagnosticTags: ['斜率', '截距'],
              classroomId: 'classroom_func_001',
            },
            {
              title: '一次函数应用题',
              diagnosticTags: ['应用建模'],
              classroomId: 'classroom_func_002',
            },
          ],
        },
      ],
    });

    await publishLearningProgram({
      teacherId: TEACHER.id,
      programId: program.id,
      confirmPublish: true,
    });

    const assignments = await assignLearningProgramToStudents({
      teacherId: TEACHER.id,
      programId: program.id,
      studentIds: [STUDENT.id, STUDENT_2.id],
    });

    const assignmentA = assignments.find((item) => item.studentId === STUDENT.id)!;
    const assignmentB = assignments.find((item) => item.studentId === STUDENT_2.id)!;
    const lessonA = program.chapters[0].lessons[0].id;

    await acceptLearningAssignment({
      studentId: STUDENT.id,
      assignmentId: assignmentA.id,
    });
    await acceptLearningAssignment({
      studentId: STUDENT_2.id,
      assignmentId: assignmentB.id,
    });

    await updateLearningLessonStatus({
      studentId: STUDENT.id,
      assignmentId: assignmentA.id,
      lessonId: lessonA,
      status: 'completed',
    });
    await recordLearningLessonMetrics({
      studentId: STUDENT.id,
      assignmentId: assignmentA.id,
      lessonId: lessonA,
      studySecondsDelta: 1200,
    });
    await submitLearningQuizResult({
      studentId: STUDENT.id,
      assignmentId: assignmentA.id,
      lessonId: lessonA,
      attempts: 5,
      correct: 4,
    });

    await updateLearningLessonStatus({
      studentId: STUDENT_2.id,
      assignmentId: assignmentB.id,
      lessonId: lessonA,
      status: 'in_progress',
    });
    await recordLearningLessonMetrics({
      studentId: STUDENT_2.id,
      assignmentId: assignmentB.id,
      lessonId: lessonA,
      studySecondsDelta: 2400,
      replayCountDelta: 2,
      replaySecondsDelta: 500,
    });
    await submitLearningQuizResult({
      studentId: STUDENT_2.id,
      assignmentId: assignmentB.id,
      lessonId: lessonA,
      attempts: 6,
      correct: 2,
    });
    await reportLearningStuckPoint({
      studentId: STUDENT_2.id,
      assignmentId: assignmentB.id,
      lessonId: lessonA,
      note: '斜率变化不理解',
    });

    const analytics = await getLearningSyllabusAnalytics({
      teacherId: TEACHER.id,
      programId: program.id,
    });

    expect(analytics.summary.studentCount).toBe(2);
    expect(analytics.summary.completionRate).toBeGreaterThan(0);
    expect(analytics.lessons).toHaveLength(2);

    const lessonAnalytics = analytics.lessons.find((item) => item.lessonId === lessonA);
    expect(lessonAnalytics).toBeDefined();
    expect(lessonAnalytics?.completionRate).toBeGreaterThan(0);
    expect(lessonAnalytics?.averageTimeSpentSec).toBeGreaterThan(0);
    expect(lessonAnalytics?.strugglingStudentCount).toBeGreaterThan(0);
  });
});
