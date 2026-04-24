'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { motion } from 'motion/react';
import {
  AlertCircle,
  ArrowRight,
  BarChart3,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  Clock,
  HelpCircle,
  Layers3,
  PauseCircle,
  PlayCircle,
  Radio,
  Repeat,
  Send,
  Sparkles,
  Target,
} from 'lucide-react';
import { toast } from 'sonner';
import { LogoutButton } from '@/components/auth/logout-button';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import type {
  LearningLessonProgressStatus,
  LearningProgramApplication,
  StudentLearningView,
} from '@/lib/types/learning';

interface StudentDashboardClientProps {
  username: string;
}

interface StudentLessonRef {
  assignmentId: string;
  chapterId: string;
  lessonId: string;
}

type StudentTab = 'learn' | 'apply' | 'records';

function statusLabel(status: string): string {
  if (status === 'pending_acceptance') return '待接收';
  if (status === 'active') return '学习中';
  if (status === 'completed') return '已完成';
  return status;
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDuration(seconds: number): string {
  if (!seconds) return '0m';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (!h) return `${m}m`;
  return `${h}h ${m}m`;
}

function lessonStatusLabel(status: LearningLessonProgressStatus): string {
  if (status === 'not_started') return '未开始';
  if (status === 'in_progress') return '学习中';
  return '已完成';
}

function applicationStatusLabel(status: LearningProgramApplication['status']) {
  if (status === 'pending') return '审核中';
  if (status === 'approved') return '已通过';
  return '已拒绝';
}

function lessonNodeTone(status: LearningLessonProgressStatus) {
  if (status === 'completed') {
    return 'border-emerald-300/70 bg-emerald-50/80 text-emerald-800 dark:border-emerald-700/60 dark:bg-emerald-950/30 dark:text-emerald-200';
  }
  if (status === 'in_progress') {
    return 'border-sky-300/80 bg-sky-50/80 text-sky-800 dark:border-sky-700/70 dark:bg-sky-950/30 dark:text-sky-200';
  }
  return 'border-slate-200/80 bg-white/70 text-slate-700 dark:border-slate-700/70 dark:bg-slate-900/50 dark:text-slate-300';
}

function ProgressRing({ value, label }: { value: number; label?: string }) {
  const safeValue = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div
      className="grid size-20 place-items-center rounded-full"
      style={{
        background: `conic-gradient(rgb(59 130 246) ${safeValue * 3.6}deg, rgb(226 232 240 / 0.75) 0deg)`,
      }}
    >
      <div className="grid size-14 place-items-center rounded-full bg-white/90 text-center text-sm font-semibold text-slate-900 dark:bg-slate-950/90 dark:text-white">
        {label || `${safeValue}%`}
      </div>
    </div>
  );
}

export function StudentDashboardClient({ username }: StudentDashboardClientProps) {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<StudentLearningView | null>(null);
  const [stuckInputByLessonKey, setStuckInputByLessonKey] = useState<Record<string, string>>({});
  const [applyNoteByProgramId, setApplyNoteByProgramId] = useState<Record<string, string>>({});
  const [questionInputByLessonKey, setQuestionInputByLessonKey] = useState<Record<string, string>>({});
  const [quizInputByLessonKey, setQuizInputByLessonKey] = useState<
    Record<string, { attempts: string; correct: string }>
  >({});
  const [activeTab, setActiveTab] = useState<StudentTab>('learn');
  const [selectedLessonRef, setSelectedLessonRef] = useState<StudentLessonRef | null>(null);
  const [applyProgramId, setApplyProgramId] = useState<string | null>(null);

  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/learning?view=student', { cache: 'no-store' });
      const payload = (await res.json()) as { success: boolean; data?: StudentLearningView; error?: string };
      if (!res.ok || !payload.success || !payload.data) {
        throw new Error(payload.error || '加载失败');
      }
      setData(payload.data);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '加载学生数据失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchData();
  }, []);

  const pendingCount = useMemo(
    () => data?.assignments.filter((item) => item.assignment.status === 'pending_acceptance').length || 0,
    [data],
  );
  const activeCount = useMemo(
    () => data?.assignments.filter((item) => item.assignment.status === 'active').length || 0,
    [data],
  );
  const completedCount = useMemo(
    () => data?.assignments.filter((item) => item.assignment.status === 'completed').length || 0,
    [data],
  );

  const nextLearningItem = useMemo(() => {
    if (!data) return null;
    for (const assignmentItem of data.assignments) {
      if (assignmentItem.assignment.status === 'pending_acceptance') {
        return {
          type: 'accept' as const,
          assignmentItem,
          chapter: assignmentItem.program.chapters[0],
          lesson: assignmentItem.program.chapters[0]?.lessons[0],
        };
      }
      if (assignmentItem.assignment.status !== 'active') continue;
      for (const chapter of assignmentItem.program.chapters) {
        for (const lesson of chapter.lessons) {
          const progress = assignmentItem.assignment.lessonProgress[lesson.id];
          if ((progress?.status || 'not_started') !== 'completed') {
            return {
              type: 'learn' as const,
              assignmentItem,
              chapter,
              lesson,
            };
          }
        }
      }
    }
    if (data.availablePrograms[0]) {
      return {
        type: 'apply' as const,
        program: data.availablePrograms[0],
      };
    }
    return null;
  }, [data]);

  const selectedLessonContext = useMemo(() => {
    if (!data || !selectedLessonRef) return null;
    const assignmentItem = data.assignments.find(
      (item) => item.assignment.id === selectedLessonRef.assignmentId,
    );
    const chapter = assignmentItem?.program.chapters.find((item) => item.id === selectedLessonRef.chapterId);
    const lesson = chapter?.lessons.find((item) => item.id === selectedLessonRef.lessonId);
    if (!assignmentItem || !chapter || !lesson) return null;
    const progress = assignmentItem.assignment.lessonProgress[lesson.id];
    const status = progress?.status || 'not_started';
    return { assignmentItem, chapter, lesson, progress, status };
  }, [data, selectedLessonRef]);

  const applyProgram = useMemo(
    () => data?.availablePrograms.find((program) => program.id === applyProgramId) || null,
    [applyProgramId, data],
  );

  const callAction = async (body: Record<string, unknown>, successMessage?: string) => {
    const res = await fetch('/api/learning', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    const payload = (await res.json()) as { success: boolean; error?: string };
    if (!res.ok || !payload.success) {
      throw new Error(payload.error || '操作失败');
    }

    if (successMessage) {
      toast.success(successMessage);
    }
    await fetchData();
  };

  const onAccept = async (assignmentId: string) => {
    try {
      await callAction({ action: 'accept_assignment', assignmentId }, '已接收课程体系，开始学习吧');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '接收失败');
    }
  };

  const onApplyProgram = async (programId: string) => {
    try {
      await callAction(
        {
          action: 'apply_program',
          programId,
          note: applyNoteByProgramId[programId] || '',
        },
        '已提交申请，等待老师审核',
      );
      setApplyNoteByProgramId((prev) => ({ ...prev, [programId]: '' }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '申请失败');
    }
  };

  const onUpdateLessonStatus = async (
    assignmentId: string,
    lessonId: string,
    status: LearningLessonProgressStatus,
  ) => {
    try {
      const label = status === 'completed' ? '已标记课时完成' : '课时状态已更新';
      await callAction({ action: 'update_lesson_status', assignmentId, lessonId, status }, label);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '更新失败');
    }
  };

  const onRecordMetrics = async (
    assignmentId: string,
    lessonId: string,
    body: {
      studySecondsDelta?: number;
      pauseSecondsDelta?: number;
      replaySecondsDelta?: number;
      replayCountDelta?: number;
      aiQuestion?: string;
    },
    successText: string,
  ) => {
    try {
      await callAction(
        {
          action: 'record_lesson_metrics',
          assignmentId,
          lessonId,
          ...body,
        },
        successText,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '记录失败');
    }
  };

  const onSubmitQuiz = async (assignmentId: string, lessonId: string) => {
    const key = `${assignmentId}:${lessonId}`;
    const quiz = quizInputByLessonKey[key] || { attempts: '', correct: '' };
    const attempts = Number.parseInt(quiz.attempts || '0', 10);
    const correct = Number.parseInt(quiz.correct || '0', 10);

    if (!Number.isFinite(attempts) || attempts <= 0) {
      toast.error('请输入有效的小测尝试次数');
      return;
    }

    if (!Number.isFinite(correct) || correct < 0 || correct > attempts) {
      toast.error('正确数需要在 0 到尝试次数之间');
      return;
    }

    try {
      await callAction(
        {
          action: 'submit_quiz_result',
          assignmentId,
          lessonId,
          attempts,
          correct,
        },
        '小测结果已记录',
      );
      setQuizInputByLessonKey((prev) => ({
        ...prev,
        [key]: { attempts: '', correct: '' },
      }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '提交小测失败');
    }
  };

  const onAskQuestion = async (assignmentId: string, lessonId: string) => {
    const key = `${assignmentId}:${lessonId}`;
    const question = (questionInputByLessonKey[key] || '').trim();
    if (!question) {
      toast.error('请先输入问题再提交');
      return;
    }

    await onRecordMetrics(
      assignmentId,
      lessonId,
      { aiQuestion: question },
      '已记录 AI 提问行为',
    );

    setQuestionInputByLessonKey((prev) => ({
      ...prev,
      [key]: '',
    }));
  };

  const onReportStuck = async (assignmentId: string, lessonId: string) => {
    const key = `${assignmentId}:${lessonId}`;
    const note = (stuckInputByLessonKey[key] || '').trim();
    if (!note) {
      toast.error('请先输入卡点描述');
      return;
    }

    try {
      await callAction({ action: 'report_stuck', assignmentId, lessonId, note }, '已上报卡点给老师');
      setStuckInputByLessonKey((prev) => ({ ...prev, [key]: '' }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '上报失败');
    }
  };

  if (loading || !data) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-b from-slate-50 to-slate-100 dark:from-slate-950 dark:to-slate-900">
        <div className="rounded-2xl border border-white/60 bg-white/70 px-6 py-4 text-sm text-slate-500 shadow-xl shadow-black/[0.03] backdrop-blur-xl dark:border-slate-800/70 dark:bg-slate-900/70">
          正在加载学习面板…
        </div>
      </div>
    );
  }

  const selectedLessonKey = selectedLessonContext
    ? `${selectedLessonContext.assignmentItem.assignment.id}:${selectedLessonContext.lesson.id}`
    : '';
  const selectedQuizValue = selectedLessonKey
    ? quizInputByLessonKey[selectedLessonKey] || { attempts: '', correct: '' }
    : { attempts: '', correct: '' };

  return (
    <div className="relative min-h-screen overflow-hidden bg-gradient-to-b from-slate-50 to-slate-100 p-4 text-slate-950 dark:from-slate-950 dark:to-slate-900 dark:text-white md:p-8">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-24 left-1/4 size-96 rounded-full bg-blue-500/10 blur-3xl animate-pulse [animation-duration:4s]" />
        <div className="absolute bottom-0 right-1/5 size-96 rounded-full bg-violet-500/10 blur-3xl animate-pulse [animation-duration:6s]" />
      </div>

      <div className="relative z-10 mx-auto flex max-w-6xl flex-col gap-6">
        <motion.header
          initial={{ opacity: 0, y: -12 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col gap-4 rounded-full border border-white/60 bg-white/70 px-4 py-3 shadow-sm backdrop-blur-xl dark:border-slate-800/70 dark:bg-slate-900/70 md:flex-row md:items-center md:justify-between"
        >
          <div className="flex items-center gap-3">
            <img src="/logo-horizontal.png" alt="OpenMAIC" className="h-8 w-auto" />
            <div className="hidden h-6 w-px bg-slate-200 dark:bg-slate-700 md:block" />
            <div>
              <div className="text-sm font-semibold">你好，{username}</div>
              <div className="text-xs text-slate-500 dark:text-slate-400">
                先完成下一节课，其他信息按需查看
              </div>
            </div>
          </div>
          <LogoutButton />
        </motion.header>

        <motion.section
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.08 }}
          className="rounded-[2rem] border border-white/60 bg-white/80 p-5 shadow-2xl shadow-black/[0.04] backdrop-blur-xl dark:border-slate-800/70 dark:bg-slate-900/80 md:p-7"
        >
          <div className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
            <div className="space-y-5">
              <div className="inline-flex items-center gap-2 rounded-full bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700 dark:bg-blue-950/40 dark:text-blue-200">
                <Radio className="size-3.5" />
                下一步学习
              </div>

              {nextLearningItem?.type === 'learn' && nextLearningItem.lesson ? (
                <div>
                  <h1 className="text-2xl font-semibold tracking-tight md:text-4xl">
                    {nextLearningItem.lesson.title}
                  </h1>
                  <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                    {nextLearningItem.assignmentItem.program.title} · {nextLearningItem.chapter?.title}
                  </p>
                  <div className="mt-5 flex flex-wrap gap-3">
                    {nextLearningItem.lesson.classroomId ? (
                      <Button asChild size="lg" className="rounded-full">
                        <Link href={`/classroom/${nextLearningItem.lesson.classroomId}`}>
                          <PlayCircle className="size-4" />
                          继续学习
                        </Link>
                      </Button>
                    ) : (
                      <Button
                        size="lg"
                        className="rounded-full"
                        onClick={() =>
                          setSelectedLessonRef({
                            assignmentId: nextLearningItem.assignmentItem.assignment.id,
                            chapterId: nextLearningItem.chapter!.id,
                            lessonId: nextLearningItem.lesson!.id,
                          })
                        }
                      >
                        <Target className="size-4" />
                        查看课时
                      </Button>
                    )}
                    <Button
                      size="lg"
                      variant="outline"
                      className="rounded-full bg-white/60 dark:bg-slate-900/60"
                      onClick={() =>
                        onUpdateLessonStatus(
                          nextLearningItem.assignmentItem.assignment.id,
                          nextLearningItem.lesson!.id,
                          'completed',
                        )
                      }
                    >
                      <CheckCircle2 className="size-4" />
                      标记完成
                    </Button>
                  </div>
                </div>
              ) : nextLearningItem?.type === 'accept' ? (
                <div>
                  <h1 className="text-2xl font-semibold tracking-tight md:text-4xl">
                    有一门课程待接收
                  </h1>
                  <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                    {nextLearningItem.assignmentItem.program.title}
                  </p>
                  <Button
                    size="lg"
                    className="mt-5 rounded-full"
                    onClick={() => onAccept(nextLearningItem.assignmentItem.assignment.id)}
                  >
                    <CheckCircle2 className="size-4" />
                    接受这门课程
                  </Button>
                </div>
              ) : nextLearningItem?.type === 'apply' ? (
                <div>
                  <h1 className="text-2xl font-semibold tracking-tight md:text-4xl">
                    可以申请新的课程
                  </h1>
                  <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                    {nextLearningItem.program.title}
                  </p>
                  <Button
                    size="lg"
                    className="mt-5 rounded-full"
                    onClick={() => setApplyProgramId(nextLearningItem.program.id)}
                  >
                    <Send className="size-4" />
                    申请加入
                  </Button>
                </div>
              ) : (
                <div>
                  <h1 className="text-2xl font-semibold tracking-tight md:text-4xl">
                    现在没有待办学习任务
                  </h1>
                  <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                    有新课程或老师派发后会出现在这里。
                  </p>
                </div>
              )}
            </div>

            <div className="grid gap-3">
              <div className="flex items-center justify-between rounded-3xl border border-slate-200/70 bg-slate-50/80 p-5 dark:border-slate-800 dark:bg-slate-950/40">
                <div>
                  <div className="text-sm font-medium">整体进度</div>
                  <div className="text-xs text-slate-500">学习中课程的完成比例</div>
                </div>
                <ProgressRing
                  value={
                    data.assignments.length
                      ? Math.round(
                          data.assignments.reduce((sum, item) => sum + item.progressPercent, 0) /
                            data.assignments.length,
                        )
                      : 0
                  }
                />
              </div>
              <div className="grid grid-cols-3 gap-3">
                {[
                  { label: '待接收', value: pendingCount },
                  { label: '学习中', value: activeCount },
                  { label: '已完成', value: completedCount },
                ].map((metric) => (
                  <div key={metric.label} className="rounded-2xl border border-slate-200/70 bg-white/70 p-4 text-center shadow-sm dark:border-slate-800 dark:bg-slate-950/40">
                    <div className="text-2xl font-semibold">{metric.value}</div>
                    <div className="text-xs text-slate-500">{metric.label}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </motion.section>

        <div className="flex gap-2 overflow-x-auto rounded-full border border-white/60 bg-white/60 p-1 backdrop-blur-xl dark:border-slate-800/70 dark:bg-slate-900/60">
          {[
            { id: 'learn' as StudentTab, label: '我的学习', icon: BookOpen },
            { id: 'apply' as StudentTab, label: '申请课程', icon: Sparkles },
            { id: 'records' as StudentTab, label: '学习记录', icon: BarChart3 },
          ].map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={cn(
                  'inline-flex shrink-0 items-center gap-2 rounded-full px-4 py-2 text-sm transition',
                  activeTab === item.id
                    ? 'bg-slate-950 text-white shadow-sm dark:bg-white dark:text-slate-950'
                    : 'text-slate-500 hover:bg-white/70 hover:text-slate-950 dark:hover:bg-slate-800 dark:hover:text-white',
                )}
              >
                <Icon className="size-4" />
                {item.label}
              </button>
            );
          })}
        </div>

        {activeTab === 'learn' && (
          <section className="space-y-4">
            {data.assignments.length === 0 ? (
              <div className="rounded-[2rem] border border-dashed border-slate-300 bg-white/70 p-8 text-center text-sm text-slate-500 backdrop-blur-xl dark:border-slate-700 dark:bg-slate-900/70">
                你还没有可学习的课程。可以去“申请课程”看看。
              </div>
            ) : (
              data.assignments.map((item, assignmentIndex) => (
                <motion.article
                  key={item.assignment.id}
                  initial={{ opacity: 0, y: 16 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: assignmentIndex * 0.04 }}
                  className="overflow-hidden rounded-[1.75rem] border border-white/60 bg-white/80 p-5 shadow-xl shadow-black/[0.03] backdrop-blur-xl dark:border-slate-800/70 dark:bg-slate-900/80"
                >
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-lg font-semibold">{item.program.title}</h2>
                        <Badge variant={item.assignment.status === 'completed' ? 'default' : 'outline'}>
                          {statusLabel(item.assignment.status)}
                        </Badge>
                        {item.pendingStuckCount > 0 && (
                          <Badge variant="secondary">卡点 {item.pendingStuckCount}</Badge>
                        )}
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs text-slate-500">
                        {item.program.description || '暂无课程简介'}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <ProgressRing value={item.progressPercent} />
                      {item.assignment.status === 'pending_acceptance' && (
                        <Button onClick={() => onAccept(item.assignment.id)}>接受课程</Button>
                      )}
                    </div>
                  </div>

                  {item.riskSignals.length > 0 && (
                    <div className="mt-4 rounded-2xl border border-amber-200/70 bg-amber-50/80 p-3 text-xs text-amber-800 dark:border-amber-800/70 dark:bg-amber-950/20 dark:text-amber-200">
                      {item.riskSignals[0].message}
                    </div>
                  )}

                  <div className="mt-5 flex gap-4 overflow-x-auto pb-1">
                    {item.program.chapters.map((chapter) => {
                      const chapterSummary = item.chapterSummaries.find(
                        (summary) => summary.chapterId === chapter.id,
                      );
                      return (
                        <div key={chapter.id} className="min-w-[240px] flex-1 rounded-2xl bg-slate-50/80 p-3 dark:bg-slate-950/40">
                          <div className="mb-3 flex items-center justify-between gap-2">
                            <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
                              <Layers3 className="size-4 text-slate-400" />
                              <span className="line-clamp-1">{chapter.title}</span>
                            </div>
                            {chapterSummary && (
                              <span className="text-xs text-slate-500">{chapterSummary.progressPercent}%</span>
                            )}
                          </div>
                          <div className="grid gap-2">
                            {chapter.lessons.map((lesson) => {
                              const lessonProgress = item.assignment.lessonProgress[lesson.id];
                              const lessonStatus = lessonProgress?.status || 'not_started';
                              return (
                                <button
                                  key={lesson.id}
                                  type="button"
                                  onClick={() =>
                                    setSelectedLessonRef({
                                      assignmentId: item.assignment.id,
                                      chapterId: chapter.id,
                                      lessonId: lesson.id,
                                    })
                                  }
                                  className={cn(
                                    'group flex items-center justify-between gap-2 rounded-xl border px-3 py-2 text-left text-xs transition hover:-translate-y-0.5 hover:shadow-sm',
                                    lessonNodeTone(lessonStatus),
                                  )}
                                >
                                  <span className="line-clamp-1">{lesson.title}</span>
                                  <span className="shrink-0 text-[10px] opacity-70">
                                    {lessonStatusLabel(lessonStatus)}
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <div className="mt-4 text-xs text-slate-500">
                    派发时间：{formatDateTime(item.assignment.assignedAt)}
                  </div>
                </motion.article>
              ))
            )}
          </section>
        )}

        {activeTab === 'apply' && (
          <section className="grid gap-4 md:grid-cols-2">
            {data.availablePrograms.length === 0 ? (
              <div className="rounded-[2rem] border border-white/60 bg-white/80 p-6 text-sm text-slate-500 shadow-xl shadow-black/[0.03] backdrop-blur-xl dark:border-slate-800/70 dark:bg-slate-900/80">
                当前没有可申请的课程体系。
              </div>
            ) : (
              data.availablePrograms.map((program) => (
                <button
                  key={program.id}
                  type="button"
                  onClick={() => setApplyProgramId(program.id)}
                  className="rounded-[1.75rem] border border-white/60 bg-white/80 p-5 text-left shadow-xl shadow-black/[0.03] backdrop-blur-xl transition hover:-translate-y-0.5 hover:shadow-2xl dark:border-slate-800/70 dark:bg-slate-900/80"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h2 className="font-semibold">{program.title}</h2>
                      <p className="mt-1 line-clamp-2 text-sm text-slate-500">{program.description || '暂无简介'}</p>
                      <div className="mt-3 text-xs text-slate-400">{program.chapters.length} 个章节</div>
                    </div>
                    <ArrowRight className="size-4 text-slate-400" />
                  </div>
                </button>
              ))
            )}
          </section>
        )}

        {activeTab === 'records' && (
          <section className="grid gap-4 lg:grid-cols-[1fr_0.85fr]">
            <div className="rounded-[1.75rem] border border-white/60 bg-white/80 p-5 shadow-xl shadow-black/[0.03] backdrop-blur-xl dark:border-slate-800/70 dark:bg-slate-900/80">
              <h2 className="font-semibold">学习记录</h2>
              <div className="mt-4 grid gap-3">
                {data.assignments.map((item) => (
                  <div key={item.assignment.id} className="rounded-2xl bg-slate-50/80 p-4 dark:bg-slate-950/40">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="font-medium">{item.program.title}</div>
                        <div className="text-xs text-slate-500">
                          学习 {formatDuration(item.behaviorSummary.studySeconds)} · 复看{' '}
                          {formatDuration(item.behaviorSummary.replaySeconds)}
                        </div>
                      </div>
                      <Badge variant="outline">{item.progressPercent}%</Badge>
                    </div>
                  </div>
                ))}
                {data.assignments.length === 0 && (
                  <div className="text-sm text-slate-500">暂无学习记录。</div>
                )}
              </div>
            </div>
            <div className="rounded-[1.75rem] border border-white/60 bg-white/80 p-5 shadow-xl shadow-black/[0.03] backdrop-blur-xl dark:border-slate-800/70 dark:bg-slate-900/80">
              <h2 className="font-semibold">申请记录</h2>
              <div className="mt-4 space-y-2">
                {data.applications.length === 0 ? (
                  <div className="rounded-2xl bg-slate-50 p-4 text-sm text-slate-500 dark:bg-slate-950/40">
                    暂未提交申请。
                  </div>
                ) : (
                  data.applications.map((application) => {
                    const relatedProgram =
                      data.availablePrograms.find((program) => program.id === application.programId) ||
                      data.assignments.find((item) => item.program.id === application.programId)?.program;
                    return (
                      <div key={application.id} className="rounded-2xl bg-slate-50/80 p-3 dark:bg-slate-950/40">
                        <div className="flex items-center justify-between gap-2">
                          <div>
                            <div className="text-sm font-medium">
                              {relatedProgram?.title || `课程 ${application.programId}`}
                            </div>
                            <div className="text-xs text-slate-500">{formatDateTime(application.createdAt)}</div>
                          </div>
                          <Badge variant="outline">{applicationStatusLabel(application.status)}</Badge>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </section>
        )}
      </div>

      <Dialog open={Boolean(selectedLessonContext)} onOpenChange={(open) => !open && setSelectedLessonRef(null)}>
        <DialogContent className="max-w-2xl border-white/60 bg-white/95 backdrop-blur-xl dark:border-slate-800 dark:bg-slate-950/95">
          {selectedLessonContext && (
            <>
              <DialogHeader>
                <DialogTitle>{selectedLessonContext.lesson.title}</DialogTitle>
                <DialogDescription>
                  {selectedLessonContext.assignmentItem.program.title} · {selectedLessonContext.chapter.title}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={selectedLessonContext.status === 'completed' ? 'default' : 'outline'}>
                    {lessonStatusLabel(selectedLessonContext.status)}
                  </Badge>
                  <Badge variant="outline">{selectedLessonContext.lesson.difficulty}</Badge>
                </div>
                <p className="text-sm text-slate-500">
                  {selectedLessonContext.lesson.description || '进入课堂后按提示完成学习。'}
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {selectedLessonContext.lesson.classroomId && (
                    <Button asChild>
                      <Link href={`/classroom/${selectedLessonContext.lesson.classroomId}`}>
                        <PlayCircle className="size-4" />
                        进入课堂
                      </Link>
                    </Button>
                  )}
                  {selectedLessonContext.status !== 'in_progress' && (
                    <Button
                      variant="outline"
                      onClick={() =>
                        onUpdateLessonStatus(
                          selectedLessonContext.assignmentItem.assignment.id,
                          selectedLessonContext.lesson.id,
                          'in_progress',
                        )
                      }
                    >
                      <Clock className="size-4" />
                      开始学习
                    </Button>
                  )}
                  {selectedLessonContext.status !== 'completed' && (
                    <Button
                      onClick={() =>
                        onUpdateLessonStatus(
                          selectedLessonContext.assignmentItem.assignment.id,
                          selectedLessonContext.lesson.id,
                          'completed',
                        )
                      }
                    >
                      <CheckCircle2 className="size-4" />
                      标记完成
                    </Button>
                  )}
                </div>

                {selectedLessonContext.status !== 'completed' && (
                  <div className="rounded-2xl border border-rose-200/70 bg-rose-50/70 p-3 dark:border-rose-900/60 dark:bg-rose-950/20">
                    <div className="mb-2 text-sm font-medium text-rose-700 dark:text-rose-200">
                      遇到困难
                    </div>
                    <div className="flex flex-col gap-2 md:flex-row">
                      <Input
                        value={stuckInputByLessonKey[selectedLessonKey] || ''}
                        onChange={(e) =>
                          setStuckInputByLessonKey((prev) => ({
                            ...prev,
                            [selectedLessonKey]: e.target.value,
                          }))
                        }
                        placeholder="一句话描述卡点"
                      />
                      <Button
                        variant="outline"
                        onClick={() =>
                          onReportStuck(
                            selectedLessonContext.assignmentItem.assignment.id,
                            selectedLessonContext.lesson.id,
                          )
                        }
                      >
                        <AlertCircle className="size-4" />
                        上报
                      </Button>
                    </div>
                  </div>
                )}

                <details className="rounded-2xl border border-slate-200/70 bg-slate-50/80 p-3 dark:border-slate-800 dark:bg-slate-900/50">
                  <summary className="flex cursor-pointer items-center justify-between text-sm font-medium">
                    学习记录/调试记录
                    <ChevronDown className="size-4" />
                  </summary>
                  <div className="mt-3 space-y-3">
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          onRecordMetrics(
                            selectedLessonContext.assignmentItem.assignment.id,
                            selectedLessonContext.lesson.id,
                            { studySecondsDelta: 600 },
                            '已记录学习 10 分钟',
                          )
                        }
                      >
                        <Clock className="size-4" />
                        +10分钟学习
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          onRecordMetrics(
                            selectedLessonContext.assignmentItem.assignment.id,
                            selectedLessonContext.lesson.id,
                            { pauseSecondsDelta: 120 },
                            '已记录停顿 2 分钟',
                          )
                        }
                      >
                        <PauseCircle className="size-4" />
                        +2分钟停顿
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          onRecordMetrics(
                            selectedLessonContext.assignmentItem.assignment.id,
                            selectedLessonContext.lesson.id,
                            { replaySecondsDelta: 180, replayCountDelta: 1 },
                            '已记录复看行为',
                          )
                        }
                      >
                        <Repeat className="size-4" />
                        +3分钟复看
                      </Button>
                    </div>
                    <div className="flex flex-col gap-2 md:flex-row">
                      <Input
                        value={questionInputByLessonKey[selectedLessonKey] || ''}
                        onChange={(e) =>
                          setQuestionInputByLessonKey((prev) => ({
                            ...prev,
                            [selectedLessonKey]: e.target.value,
                          }))
                        }
                        placeholder="记录你问 AI 的问题"
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          onAskQuestion(
                            selectedLessonContext.assignmentItem.assignment.id,
                            selectedLessonContext.lesson.id,
                          )
                        }
                      >
                        <HelpCircle className="size-4" />
                        记录提问
                      </Button>
                    </div>
                    <div className="grid gap-2 md:grid-cols-6">
                      <Input
                        className="md:col-span-2"
                        placeholder="小测尝试次数"
                        value={selectedQuizValue.attempts}
                        onChange={(e) =>
                          setQuizInputByLessonKey((prev) => ({
                            ...prev,
                            [selectedLessonKey]: {
                              ...selectedQuizValue,
                              attempts: e.target.value,
                            },
                          }))
                        }
                      />
                      <Input
                        className="md:col-span-2"
                        placeholder="正确题数"
                        value={selectedQuizValue.correct}
                        onChange={(e) =>
                          setQuizInputByLessonKey((prev) => ({
                            ...prev,
                            [selectedLessonKey]: {
                              ...selectedQuizValue,
                              correct: e.target.value,
                            },
                          }))
                        }
                      />
                      <Button
                        className="md:col-span-2"
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          onSubmitQuiz(
                            selectedLessonContext.assignmentItem.assignment.id,
                            selectedLessonContext.lesson.id,
                          )
                        }
                      >
                        提交小测
                      </Button>
                    </div>
                  </div>
                </details>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(applyProgram)} onOpenChange={(open) => !open && setApplyProgramId(null)}>
        <DialogContent className="max-w-xl border-white/60 bg-white/95 backdrop-blur-xl dark:border-slate-800 dark:bg-slate-950/95">
          {applyProgram && (
            <>
              <DialogHeader>
                <DialogTitle>申请加入《{applyProgram.title}》</DialogTitle>
                <DialogDescription>{applyProgram.description || '提交后等待老师审核。'}</DialogDescription>
              </DialogHeader>
              <Textarea
                value={applyNoteByProgramId[applyProgram.id] || ''}
                onChange={(e) =>
                  setApplyNoteByProgramId((prev) => ({
                    ...prev,
                    [applyProgram.id]: e.target.value,
                  }))
                }
                placeholder="申请说明（可选）"
              />
              <DialogFooter>
                <Button variant="outline" onClick={() => setApplyProgramId(null)}>
                  取消
                </Button>
                <Button onClick={() => onApplyProgram(applyProgram.id)}>
                  <Send className="size-4" />
                  提交申请
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
