'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import {
  AlertTriangle,
  BarChart3,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  Layers3,
  LayoutDashboard,
  Loader2,
  PlusCircle,
  Radio,
  RefreshCw,
  Send,
  Settings,
  Siren,
  Sparkles,
  Trash2,
  Users,
  Wand2,
  Workflow,
} from 'lucide-react';
import { toast } from 'sonner';
import { LogoutButton } from '@/components/auth/logout-button';
import { SettingsDialog } from '@/components/settings';
import { ThumbnailSlide } from '@/components/slide-renderer/components/ThumbnailSlide';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { getCurrentModelConfig } from '@/lib/utils/model-config';
import { useSettingsStore } from '@/lib/store/settings';
import { getFirstSlideByStages } from '@/lib/utils/stage-storage';
import type {
  LearningCourseProgram,
  LearningLessonGenerationStatus,
  LearningProgramApplication,
  LearningSyllabusAnalytics,
  TeacherAssignmentSummary,
  TeacherInterventionItem,
  TeacherLearningView,
} from '@/lib/types/learning';
import type { Slide } from '@/lib/types/slides';

interface TeacherDashboardClientProps {
  username: string;
}

interface DraftLesson {
  id?: string;
  title: string;
  description: string;
  learningObjectivesText: string;
  prerequisitesText: string;
  difficulty: 'basic' | 'intermediate' | 'advanced';
  diagnosticTagsText: string;
  classroomId: string;
  generationStatus?: LearningLessonGenerationStatus;
  previewUrl?: string;
  lastGenerationTaskId?: string;
}

interface DraftChapter {
  id?: string;
  title: string;
  description: string;
  lessons: DraftLesson[];
}

interface ProgramDraft {
  title: string;
  description: string;
  targetAudience: string;
  source: 'manual' | 'ai_generated' | 'mixed';
  chapters: DraftChapter[];
}

const EMPTY_DRAFT: ProgramDraft = {
  title: '',
  description: '',
  targetAudience: '',
  source: 'manual',
  chapters: [
    {
      title: '章节 1',
      description: '',
      lessons: [createEmptyDraftLesson()],
    },
  ],
};

interface LessonGenerationForm {
  topic: string;
  targetAudience: string;
  requirements: string;
}

interface LessonGenerationProgressSnapshot {
  classroomJobId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  step: string;
  progress: number;
  message: string;
  scenesGenerated: number;
  totalScenes?: number;
  canResume?: boolean;
  done: boolean;
  updatedAt: number;
}

interface TeacherLessonRef {
  programId: string;
  chapterId: string;
  lessonId: string;
}

interface TeacherGenerationQueueItem {
  program: LearningCourseProgram;
  chapter: LearningCourseProgram['chapters'][number];
  lesson: LearningCourseProgram['chapters'][number]['lessons'][number];
  progress: LessonGenerationProgressSnapshot | undefined;
}

type TeacherPanel = 'operate' | 'design' | 'insights' | 'applications';

const EMPTY_LESSON_GENERATION_FORM: LessonGenerationForm = {
  topic: '',
  targetAudience: '',
  requirements: '',
};

function createEmptyDraftLesson(): DraftLesson {
  return {
    title: '',
    description: '',
    learningObjectivesText: '',
    prerequisitesText: '',
    difficulty: 'basic',
    diagnosticTagsText: '',
    classroomId: '',
  };
}

function splitListInput(value: string): string[] {
  return value
    .split(/[\n,，;；]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function joinListOutput(values: string[] | undefined): string {
  if (!Array.isArray(values) || values.length === 0) return '';
  return values.join('；');
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatProgramDate(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const diffDays = Math.floor(Math.abs(now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return '今天';
  if (diffDays === 1) return '昨天';
  if (diffDays < 7) return `${diffDays} 天前`;
  return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}

function formatDuration(seconds: number): string {
  if (seconds <= 0) return '0m';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

function riskBadgeColor(level?: 'low' | 'medium' | 'high') {
  if (level === 'high') return 'destructive';
  if (level === 'medium') return 'secondary';
  return 'outline';
}

function lessonGenerationStatusText(status?: LearningLessonGenerationStatus) {
  switch (status) {
    case 'started':
    case 'processing':
      return '生成中';
    case 'binding_pending':
      return '待绑定';
    case 'succeeded':
      return '已生成';
    case 'failed':
      return '生成失败';
    default:
      return '未开始';
  }
}

function lessonGenerationStatusVariant(status?: LearningLessonGenerationStatus) {
  switch (status) {
    case 'succeeded':
      return 'default';
    case 'failed':
      return 'destructive';
    case 'binding_pending':
      return 'secondary';
    case 'started':
    case 'processing':
      return 'outline';
    default:
      return 'outline';
  }
}

function classroomJobStepText(step?: string) {
  switch (step) {
    case 'queued':
      return '排队中';
    case 'initializing':
      return '初始化';
    case 'researching':
      return '资料检索';
    case 'generating_outlines':
      return '生成大纲';
    case 'generating_scenes':
      return '生成场景';
    case 'generating_media':
      return '生成媒体';
    case 'generating_tts':
      return '生成配音';
    case 'persisting':
      return '写入数据';
    case 'completed':
      return '完成';
    case 'failed':
      return '失败';
    default:
      return '处理中';
  }
}

function lessonNodeTone(status?: LearningLessonGenerationStatus) {
  switch (status) {
    case 'succeeded':
      return 'border-emerald-300/70 bg-emerald-50/80 text-emerald-800 dark:border-emerald-700/60 dark:bg-emerald-950/30 dark:text-emerald-200';
    case 'failed':
      return 'border-rose-300/80 bg-rose-50/80 text-rose-800 dark:border-rose-800/70 dark:bg-rose-950/30 dark:text-rose-200';
    case 'started':
    case 'processing':
    case 'binding_pending':
      return 'border-sky-300/80 bg-sky-50/80 text-sky-800 dark:border-sky-700/70 dark:bg-sky-950/30 dark:text-sky-200';
    default:
      return 'border-slate-200/80 bg-white/70 text-slate-700 dark:border-slate-700/70 dark:bg-slate-900/50 dark:text-slate-300';
  }
}

function riskHeatTone(level?: 'low' | 'medium' | 'high') {
  if (level === 'high') return 'from-rose-500 to-orange-400';
  if (level === 'medium') return 'from-amber-400 to-yellow-300';
  return 'from-sky-400 to-cyan-300';
}

function ProgressRing({
  value,
  label,
  className,
}: {
  value: number;
  label?: string;
  className?: string;
}) {
  const safeValue = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div
      className={cn('grid size-16 place-items-center rounded-full', className)}
      style={{
        background: `conic-gradient(rgb(59 130 246) ${safeValue * 3.6}deg, rgb(226 232 240 / 0.75) 0deg)`,
      }}
    >
      <div className="grid size-12 place-items-center rounded-full bg-white/90 text-center text-xs font-semibold text-slate-900 dark:bg-slate-950/90 dark:text-white">
        {label || `${safeValue}%`}
      </div>
    </div>
  );
}

function findProgramPreviewClassroomId(program: LearningCourseProgram): string | undefined {
  for (const chapter of program.chapters) {
    for (const lesson of chapter.lessons) {
      if (lesson.classroomId) return lesson.classroomId;
    }
  }
  return undefined;
}

function escapePreviewHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function compactPreviewText(value: string | undefined, maxLength: number): string {
  const normalized = value?.replace(/\s+/g, ' ').trim() || '';
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function previewTextElement(
  id: string,
  content: string,
  geometry: { left: number; top: number; width: number; height: number },
  options: {
    color?: string;
    fill?: string;
    fontSize?: number;
    fontWeight?: number;
    align?: 'left' | 'center';
    lineHeight?: number;
  } = {},
): Slide['elements'][number] {
  const align = options.align || 'left';
  const fontSize = options.fontSize || 20;
  const fontWeight = options.fontWeight || 500;

  return {
    id,
    type: 'text',
    left: geometry.left,
    top: geometry.top,
    width: geometry.width,
    height: geometry.height,
    rotate: 0,
    content: `<p style="margin:0;text-align:${align};font-size:${fontSize}px;font-weight:${fontWeight};line-height:${options.lineHeight || 1.3};">${escapePreviewHtml(content)}</p>`,
    defaultFontName: 'Microsoft YaHei',
    defaultColor: options.color || '#0f172a',
    fill: options.fill,
    lineHeight: options.lineHeight || 1.3,
    paragraphSpace: 0,
  };
}

function previewRoundRectElement(
  id: string,
  geometry: { left: number; top: number; width: number; height: number },
  fill: string,
  outline?: { color: string; width: number },
): Slide['elements'][number] {
  return {
    id,
    type: 'shape',
    left: geometry.left,
    top: geometry.top,
    width: geometry.width,
    height: geometry.height,
    rotate: 0,
    viewBox: [240, 150],
    path: 'M 18 0 H 222 Q 240 0 240 18 V 132 Q 240 150 222 150 H 18 Q 0 150 0 132 V 18 Q 0 0 18 0 Z',
    fixedRatio: false,
    fill,
    outline: outline ? { style: 'solid', color: outline.color, width: outline.width } : undefined,
  };
}

function createProgramPreviewSlide(program: LearningCourseProgram): Slide {
  const chapters = program.chapters.slice(0, 3);
  const fallbackItems = [
    { title: '课程定位', detail: program.targetAudience || '核心概念与关键能力' },
    { title: '章节路径', detail: `${program.chapters.length || 1} 个章节逐步推进` },
    { title: '学习任务', detail: '讨论、练习与课堂生成内容' },
  ];
  const previewItems = chapters.length
    ? chapters.map((chapter) => ({
        title: chapter.title,
        detail:
          compactPreviewText(chapter.description, 34) ||
          `${chapter.lessons.length} 个课时 · ${chapter.lessons[0]?.title || '学习任务'}`,
      }))
    : fallbackItems;
  const paddedItems = [...previewItems, ...fallbackItems].slice(0, 3);
  const cardFills = ['#dbeafe', '#dcfce7', '#fee2e2'];
  const cardTitleColors = ['#1d4ed8', '#15803d', '#dc2626'];

  const elements: Slide['elements'] = [
    previewTextElement(
      `program-preview-${program.id}-title`,
      compactPreviewText(program.title, 34) || '课程体系',
      { left: 92, top: 42, width: 816, height: 46 },
      { align: 'center', fontSize: 30, fontWeight: 700, color: '#0f172a' },
    ),
    previewTextElement(
      `program-preview-${program.id}-subtitle`,
      '课程体系｜章节导览｜学习任务',
      { left: 210, top: 94, width: 580, height: 28 },
      { align: 'center', fontSize: 15, fontWeight: 500, color: '#64748b' },
    ),
  ];

  paddedItems.forEach((item, index) => {
    const left = 92 + index * 275;
    elements.push(
      previewRoundRectElement(
        `program-preview-${program.id}-card-${index}`,
        { left, top: 170, width: 240, height: 168 },
        cardFills[index],
        { color: '#e2e8f0', width: 1 },
      ),
      previewTextElement(
        `program-preview-${program.id}-card-title-${index}`,
        compactPreviewText(item.title, 14),
        { left: left + 20, top: 200, width: 200, height: 32 },
        { align: 'center', fontSize: 21, fontWeight: 700, color: cardTitleColors[index] },
      ),
      previewTextElement(
        `program-preview-${program.id}-card-detail-${index}`,
        compactPreviewText(item.detail, 42),
        { left: left + 28, top: 247, width: 184, height: 60 },
        { align: 'center', fontSize: 15, fontWeight: 500, color: '#475569', lineHeight: 1.45 },
      ),
    );
  });

  elements.push(
    previewRoundRectElement(
      `program-preview-${program.id}-summary`,
      { left: 165, top: 390, width: 670, height: 42 },
      '#e2e8f0',
    ),
    previewTextElement(
      `program-preview-${program.id}-summary-text`,
      compactPreviewText(program.description || program.targetAudience || '点击查看课程详情、章节与课时安排', 58),
      { left: 190, top: 400, width: 620, height: 25 },
      { align: 'center', fontSize: 14, fontWeight: 500, color: '#475569' },
    ),
  );

  return {
    id: `program-preview-${program.id}`,
    viewportSize: 1000,
    viewportRatio: 0.5625,
    theme: {
      backgroundColor: '#eef6ff',
      themeColors: ['#2563eb', '#16a34a', '#dc2626', '#64748b'],
      fontColor: '#0f172a',
      fontName: 'Microsoft YaHei',
    },
    background: {
      type: 'gradient',
      gradient: {
        type: 'linear',
        rotate: 135,
        colors: [
          { pos: 0, color: '#f8fbff' },
          { pos: 58, color: '#eaf3ff' },
          { pos: 100, color: '#f5f7fb' },
        ],
      },
    },
    elements,
    type: 'cover',
  };
}

function ProgramPreviewMedia({
  slide,
  program,
  className,
}: {
  slide?: Slide;
  program: LearningCourseProgram;
  className?: string;
}) {
  const thumbRef = useRef<HTMLDivElement>(null);
  const [thumbWidth, setThumbWidth] = useState(0);
  const previewSlide = useMemo(() => slide || createProgramPreviewSlide(program), [program, slide]);

  useEffect(() => {
    const el = thumbRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setThumbWidth(Math.round(entry.contentRect.width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      ref={thumbRef}
      className={cn(
        'relative aspect-[16/9] overflow-hidden rounded-2xl bg-slate-100 dark:bg-slate-800/80',
        className,
      )}
    >
      {thumbWidth > 0 ? (
        <ThumbnailSlide
          slide={previewSlide}
          size={thumbWidth}
          viewportSize={previewSlide.viewportSize ?? 1000}
          viewportRatio={previewSlide.viewportRatio ?? 0.5625}
        />
      ) : null}
    </div>
  );
}

function ProgramThumbnailCard({
  program,
  slide,
  totalLessonCount,
  generatedLessonCount,
  pendingApplicationCount,
  onOpen,
}: {
  program: LearningCourseProgram;
  slide?: Slide;
  totalLessonCount: number;
  generatedLessonCount: number;
  pendingApplicationCount: number;
  onOpen: () => void;
}) {
  return (
    <button type="button" onClick={onOpen} className="group block w-full text-left outline-none">
      <ProgramPreviewMedia
        slide={slide}
        program={program}
        className="transition-transform duration-200 group-hover:scale-[1.02] group-focus-visible:ring-2 group-focus-visible:ring-blue-500 group-focus-visible:ring-offset-2"
      />

      <div className="mt-2.5 flex min-w-0 items-center gap-2 px-1">
        <span className="shrink-0 rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-medium text-violet-600 dark:bg-violet-900/30 dark:text-violet-300">
          {totalLessonCount} 课时 · {formatProgramDate(program.updatedAt)}
        </span>
        <p className="min-w-0 truncate text-[15px] font-medium text-slate-900 dark:text-slate-100">
          {program.title}
        </p>
      </div>

      <div className="mt-1 flex min-w-0 items-center gap-2 px-1 text-[11px] text-slate-500">
        <span>{program.published ? '已发布' : '草稿'}</span>
        <span>·</span>
        <span>已生成 {generatedLessonCount}</span>
        {pendingApplicationCount > 0 && (
          <>
            <span>·</span>
            <span>申请 {pendingApplicationCount}</span>
          </>
        )}
      </div>
    </button>
  );
}

function ProgramExpandedHeader({
  item,
  slide,
  courseProgress,
  totalLessonCount,
  generatedLessonCount,
  isDeleting,
  onCollapse,
  onLoadDraft,
  onPublish,
  onAssign,
  onDelete,
}: {
  item: TeacherLearningView['programs'][number];
  slide?: Slide;
  courseProgress: number;
  totalLessonCount: number;
  generatedLessonCount: number;
  isDeleting: boolean;
  onCollapse: () => void;
  onLoadDraft: () => void;
  onPublish: () => void;
  onAssign: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="grid gap-4 md:grid-cols-[260px_minmax(0,1fr)]">
      <button
        type="button"
        onClick={onCollapse}
        className="group block w-full text-left outline-none"
        aria-label="收起课程详情"
      >
        <ProgramPreviewMedia
          slide={slide}
          program={item.program}
          className="transition-transform duration-200 group-hover:scale-[1.02] group-focus-visible:ring-2 group-focus-visible:ring-blue-500 group-focus-visible:ring-offset-2"
        />
      </button>

      <div className="flex min-w-0 flex-col justify-between gap-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-lg font-semibold">{item.program.title}</h2>
              <Badge variant={item.program.published ? 'default' : 'outline'}>
                {item.program.published ? '已发布' : '草稿'}
              </Badge>
              {item.pendingApplicationCount > 0 && (
                <Badge variant="secondary">申请 {item.pendingApplicationCount}</Badge>
              )}
            </div>
            <p className="mt-1 line-clamp-2 max-w-2xl text-sm text-slate-500">
              {item.program.description || item.program.targetAudience || '暂无课程简介'}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <ProgressRing value={courseProgress} className="size-14" />
            <div className="flex flex-wrap justify-end gap-2">
              <Button size="sm" variant="outline" onClick={onLoadDraft}>
                载入编辑
              </Button>
              {!item.program.published ? (
                <Button size="sm" onClick={onPublish}>
                  发布
                </Button>
              ) : (
                <Button size="sm" variant="outline" onClick={onAssign}>
                  派发
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                className="text-rose-600 hover:text-rose-700 dark:text-rose-300"
                onClick={onDelete}
                disabled={isDeleting}
              >
                {isDeleting ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Trash2 className="size-4" />
                )}
                删除
              </Button>
              <Button size="sm" variant="ghost" onClick={onCollapse}>
                收起
                <ChevronDown className="size-4 rotate-180" />
              </Button>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 text-xs text-slate-500">
          <span className="rounded-full bg-slate-100 px-3 py-1 dark:bg-slate-800">
            {item.program.chapters.length} 章节
          </span>
          <span className="rounded-full bg-slate-100 px-3 py-1 dark:bg-slate-800">
            {totalLessonCount} 课时
          </span>
          <span className="rounded-full bg-slate-100 px-3 py-1 dark:bg-slate-800">
            已生成 {generatedLessonCount}
          </span>
          <span className="rounded-full bg-slate-100 px-3 py-1 dark:bg-slate-800">
            已派发 {item.assignedCount}
          </span>
          <span className="rounded-full bg-slate-100 px-3 py-1 dark:bg-slate-800">
            学习中 {item.activeCount}
          </span>
          <span className="rounded-full bg-slate-100 px-3 py-1 dark:bg-slate-800">
            已完成 {item.completedCount}
          </span>
        </div>

        <div className="truncate text-xs text-slate-500">
          {item.publishWarnings.length > 0
            ? item.publishWarnings[0].message
            : '章节、课时与运营详情'}
        </div>
      </div>
    </div>
  );
}

function buildModelHeaders(options?: { forceRichMedia?: boolean }) {
  const modelConfig = getCurrentModelConfig();
  const settings = useSettingsStore.getState();
  const imageProviderConfig = settings.imageProvidersConfig?.[settings.imageProviderId];
  const videoProviderConfig = settings.videoProvidersConfig?.[settings.videoProviderId];
  const imageGenerationEnabled = options?.forceRichMedia
    ? true
    : (settings.imageGenerationEnabled ?? true);
  const videoGenerationEnabled = options?.forceRichMedia
    ? true
    : (settings.videoGenerationEnabled ?? true);

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-model': modelConfig.modelString,
    'x-api-key': modelConfig.apiKey,
    // Rich media switches
    'x-image-generation-enabled': String(imageGenerationEnabled),
    'x-video-generation-enabled': String(videoGenerationEnabled),
    // Richness policy defaults
    'x-richness-min-images': String(imageGenerationEnabled ? 1 : 0),
    'x-richness-min-videos': String(videoGenerationEnabled ? 1 : 0),
    'x-richness-min-interactive': '1',
    'x-richness-interactive-depth': 'light',
    // Image provider runtime config
    'x-image-provider': settings.imageProviderId || '',
    'x-image-model': settings.imageModelId || '',
    'x-image-api-key': imageProviderConfig?.apiKey || '',
    'x-image-base-url': imageProviderConfig?.baseUrl || '',
    // Video provider runtime config
    'x-video-provider': settings.videoProviderId || '',
    'x-video-model': settings.videoModelId || '',
    'x-video-api-key': videoProviderConfig?.apiKey || '',
    'x-video-base-url': videoProviderConfig?.baseUrl || '',
  };
  if (modelConfig.baseUrl) {
    headers['x-base-url'] = modelConfig.baseUrl;
  }
  if (modelConfig.providerType) {
    headers['x-provider-type'] = modelConfig.providerType;
  }
  return headers;
}

export function TeacherDashboardClient({ username }: TeacherDashboardClientProps) {
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [data, setData] = useState<TeacherLearningView | null>(null);
  const [draft, setDraft] = useState<ProgramDraft>(EMPTY_DRAFT);
  const [editingProgramId, setEditingProgramId] = useState<string | null>(null);
  const [selectedStudentIdsByProgram, setSelectedStudentIdsByProgram] = useState<
    Record<string, string[]>
  >({});
  const [classroomIdInputs, setClassroomIdInputs] = useState<Record<string, string>>({});
  const [interventionNotes, setInterventionNotes] = useState<Record<string, string>>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection] = useState<import('@/lib/types/settings').SettingsSection>('providers');
  const [isSyllabusDialogOpen, setIsSyllabusDialogOpen] = useState(false);
  const [syllabusForm, setSyllabusForm] = useState<LessonGenerationForm>(EMPTY_LESSON_GENERATION_FORM);
  const [isGeneratingSyllabus, setIsGeneratingSyllabus] = useState(false);
  const [lessonActionLoading, setLessonActionLoading] = useState<Record<string, boolean>>({});
  const [lessonGenerationProgressByTask, setLessonGenerationProgressByTask] = useState<
    Record<string, LessonGenerationProgressSnapshot>
  >({});
  const [analyticsByProgram, setAnalyticsByProgram] = useState<Record<string, LearningSyllabusAnalytics>>({});
  const [analyticsLoadingByProgram, setAnalyticsLoadingByProgram] = useState<Record<string, boolean>>({});
  const [activePanel, setActivePanel] = useState<TeacherPanel>('operate');
  const [selectedLessonRef, setSelectedLessonRef] = useState<TeacherLessonRef | null>(null);
  const [selectedAssignmentId, setSelectedAssignmentId] = useState<string | null>(null);
  const [assignProgramId, setAssignProgramId] = useState<string | null>(null);
  const [deletingProgramId, setDeletingProgramId] = useState<string | null>(null);
  const [expandedChapterKeys, setExpandedChapterKeys] = useState<Record<string, boolean>>({});
  const [expandedProgramId, setExpandedProgramId] = useState<string | null>(null);
  const [programPreviewSlides, setProgramPreviewSlides] = useState<Record<string, Slide>>({});
  const activePollingTaskIdsRef = useRef<Set<string>>(new Set());

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/learning?view=teacher', { cache: 'no-store' });
      const payload = (await res.json()) as { success: boolean; data?: TeacherLearningView; error?: string };
      if (!res.ok || !payload.success || !payload.data) {
        throw new Error(payload.error || '加载教师端数据失败');
      }
      setData(payload.data);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '加载教师端数据失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  useEffect(() => {
    if (!data?.programs.length) {
      setProgramPreviewSlides({});
      return;
    }

    const previewClassroomIdsByProgram = Object.fromEntries(
      data.programs.map((item) => [item.program.id, findProgramPreviewClassroomId(item.program)]),
    );
    const uniqueClassroomIds = [
      ...new Set(
        Object.values(previewClassroomIdsByProgram).filter(
          (value): value is string => typeof value === 'string' && value.length > 0,
        ),
      ),
    ];
    let cancelled = false;

    void (async () => {
      const slides = uniqueClassroomIds.length ? await getFirstSlideByStages(uniqueClassroomIds) : {};
      if (cancelled) return;

      const next: Record<string, Slide> = {};
      for (const [programId, classroomId] of Object.entries(previewClassroomIdsByProgram)) {
        if (classroomId && slides[classroomId]) {
          next[programId] = slides[classroomId];
        }
      }
      setProgramPreviewSlides(next);
    })();

    return () => {
      cancelled = true;
    };
  }, [data]);

  const pendingApplications = useMemo(
    () => data?.applications.filter((item) => item.status === 'pending') || [],
    [data],
  );

  const stats = useMemo(() => {
    const programs = data?.programs || [];
    const interventionInbox = data?.interventionInbox || [];

    return {
      totalPrograms: programs.length,
      publishedPrograms: programs.filter((item) => item.program.published).length,
      assignedCount: programs.reduce((sum, item) => sum + item.assignedCount, 0),
      openInterventions: interventionInbox.length,
    };
  }, [data]);

  const generationQueue = useMemo(() => {
    if (!data) return [];
    return data.programs.flatMap((programItem) =>
      programItem.program.chapters.flatMap((chapter) =>
        chapter.lessons
          .map((lesson) => {
            const progress = lesson.lastGenerationTaskId
              ? lessonGenerationProgressByTask[lesson.lastGenerationTaskId]
              : undefined;
            const isActive =
              lesson.generationStatus === 'started' ||
              lesson.generationStatus === 'processing' ||
              lesson.generationStatus === 'binding_pending' ||
              lesson.generationStatus === 'failed' ||
              Boolean(progress && !progress.done);
            if (!isActive) return null;
            return {
              program: programItem.program,
              chapter,
              lesson,
              progress,
            };
          })
          .filter((item): item is TeacherGenerationQueueItem => item !== null),
      ),
    );
  }, [data, lessonGenerationProgressByTask]);

  const selectedLessonContext = useMemo(() => {
    if (!data || !selectedLessonRef) return null;
    const programItem = data.programs.find((item) => item.program.id === selectedLessonRef.programId);
    const chapter = programItem?.program.chapters.find((item) => item.id === selectedLessonRef.chapterId);
    const lesson = chapter?.lessons.find((item) => item.id === selectedLessonRef.lessonId);
    if (!programItem || !chapter || !lesson) return null;
    const progress = lesson.lastGenerationTaskId
      ? lessonGenerationProgressByTask[lesson.lastGenerationTaskId]
      : undefined;
    return { programItem, chapter, lesson, progress };
  }, [data, lessonGenerationProgressByTask, selectedLessonRef]);

  const selectedAssignment = useMemo(
    () => data?.assignments.find((row) => row.assignment.id === selectedAssignmentId) || null,
    [data, selectedAssignmentId],
  );

  const assignProgram = useMemo(
    () => data?.programs.find((item) => item.program.id === assignProgramId) || null,
    [assignProgramId, data],
  );

  const unpublishedCount = useMemo(
    () => data?.programs.filter((item) => !item.program.published).length || 0,
    [data],
  );

  const unassignedPublishedCount = useMemo(
    () => data?.programs.filter((item) => item.program.published && item.assignedCount === 0).length || 0,
    [data],
  );

  const topRiskRows = useMemo(
    () =>
      (data?.assignments || [])
        .filter((row) => row.riskSignals.length > 0 || row.openStuckCount > 0)
        .slice()
        .sort((a, b) => {
          const score = (row: TeacherAssignmentSummary) =>
            row.riskSignals.some((risk) => risk.level === 'high')
              ? 3
              : row.riskSignals.some((risk) => risk.level === 'medium')
                ? 2
                : row.openStuckCount > 0
                  ? 1
                  : 0;
          return score(b) - score(a);
        })
        .slice(0, 8),
    [data],
  );

  const panelCounts = useMemo<Record<TeacherPanel, number>>(
    () => ({
      operate:
        generationQueue.length +
        (data?.interventionInbox.length || 0) +
        unpublishedCount +
        unassignedPublishedCount,
      design: stats.totalPrograms,
      insights: topRiskRows.length,
      applications: pendingApplications.length,
    }),
    [
      data,
      generationQueue.length,
      pendingApplications.length,
      stats.totalPrograms,
      topRiskRows.length,
      unpublishedCount,
      unassignedPublishedCount,
    ],
  );

  const updateDraft = <K extends keyof ProgramDraft>(key: K, value: ProgramDraft[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  const updateChapter = (chapterIndex: number, patch: Partial<DraftChapter>) => {
    setDraft((prev) => {
      const nextChapters = [...prev.chapters];
      nextChapters[chapterIndex] = { ...nextChapters[chapterIndex], ...patch };
      return { ...prev, chapters: nextChapters };
    });
  };

  const updateLesson = (chapterIndex: number, lessonIndex: number, patch: Partial<DraftLesson>) => {
    setDraft((prev) => {
      const nextChapters = [...prev.chapters];
      const nextLessons = [...nextChapters[chapterIndex].lessons];
      nextLessons[lessonIndex] = { ...nextLessons[lessonIndex], ...patch };
      nextChapters[chapterIndex] = { ...nextChapters[chapterIndex], lessons: nextLessons };
      return { ...prev, chapters: nextChapters };
    });
  };

  const addChapter = () => {
    setDraft((prev) => ({
      ...prev,
      chapters: [
        ...prev.chapters,
        {
          title: `章节 ${prev.chapters.length + 1}`,
          description: '',
          lessons: [createEmptyDraftLesson()],
        },
      ],
    }));
  };

  const removeChapter = (chapterIndex: number) => {
    setDraft((prev) => {
      if (prev.chapters.length === 1) return prev;
      return {
        ...prev,
        chapters: prev.chapters.filter((_, index) => index !== chapterIndex),
      };
    });
  };

  const addLesson = (chapterIndex: number) => {
    setDraft((prev) => {
      const nextChapters = [...prev.chapters];
      nextChapters[chapterIndex] = {
        ...nextChapters[chapterIndex],
        lessons: [
          ...nextChapters[chapterIndex].lessons,
          createEmptyDraftLesson(),
        ],
      };
      return { ...prev, chapters: nextChapters };
    });
  };

  const removeLesson = (chapterIndex: number, lessonIndex: number) => {
    setDraft((prev) => {
      const nextChapters = [...prev.chapters];
      const chapter = nextChapters[chapterIndex];
      if (chapter.lessons.length === 1) {
        nextChapters[chapterIndex] = {
          ...chapter,
          lessons: [createEmptyDraftLesson()],
        };
      } else {
        nextChapters[chapterIndex] = {
          ...chapter,
          lessons: chapter.lessons.filter((_, index) => index !== lessonIndex),
        };
      }
      return { ...prev, chapters: nextChapters };
    });
  };

  const loadProgramToDraft = (program: LearningCourseProgram) => {
    setEditingProgramId(program.id);
    setDraft({
      title: program.title,
      description: program.description,
      targetAudience: program.targetAudience || '',
      source: program.source || 'manual',
      chapters: program.chapters.map((chapter) => ({
        id: chapter.id,
        title: chapter.title,
        description: chapter.description,
        lessons: chapter.lessons.map((lesson) => ({
          id: lesson.id,
          title: lesson.title,
          description: lesson.description,
          learningObjectivesText: joinListOutput(lesson.learningObjectives),
          prerequisitesText: joinListOutput(lesson.prerequisites),
          difficulty: lesson.difficulty || 'basic',
          diagnosticTagsText: joinListOutput(lesson.diagnosticTags),
          classroomId: lesson.classroomId || '',
          generationStatus: lesson.generationStatus,
          previewUrl: lesson.previewUrl,
          lastGenerationTaskId: lesson.lastGenerationTaskId,
        })),
      })),
    });
    setActivePanel('design');
  };

  const resetDraft = () => {
    setEditingProgramId(null);
    setDraft(EMPTY_DRAFT);
  };

  const normalizeDraftChapters = () => {
    return draft.chapters
      .map((chapter) => ({
        id: chapter.id,
        title: chapter.title.trim(),
        description: chapter.description,
        lessons: chapter.lessons
          .map((lesson) => ({
            id: lesson.id,
            title: lesson.title.trim(),
            description: lesson.description,
            learningObjectives: splitListInput(lesson.learningObjectivesText),
            prerequisites: splitListInput(lesson.prerequisitesText),
            difficulty: lesson.difficulty,
            diagnosticTags: splitListInput(lesson.diagnosticTagsText),
            generationStatus: lesson.generationStatus,
            classroomId: lesson.classroomId.trim() || undefined,
            previewUrl: lesson.previewUrl,
            lastGenerationTaskId: lesson.lastGenerationTaskId,
          }))
          .filter((lesson) => lesson.title),
      }))
      .filter((chapter) => chapter.title);
  };

  const callAction = async (body: Record<string, unknown>) => {
    const res = await fetch('/api/learning', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    const payload = (await res.json()) as {
      success: boolean;
      error?: string;
      warnings?: Array<{ level: 'info' | 'warning'; message: string }>;
    };

    if (!res.ok || !payload.success) {
      const error = new Error(payload.error || '操作失败');
      (error as Error & { warnings?: Array<{ level: 'info' | 'warning'; message: string }> }).warnings =
        payload.warnings;
      throw error;
    }

    return payload;
  };

  const openGenerationProgress = useCallback((classroomJobId: string) => {
    const href = `/generation-preview?jobId=${encodeURIComponent(classroomJobId)}&from=teacher`;
    window.location.assign(href);
  }, []);

  const onGenerateSyllabusDraft = async () => {
    if (isGeneratingSyllabus) return;
    if (!syllabusForm.topic.trim()) {
      toast.error('请先输入课程主题');
      return;
    }

    setIsGeneratingSyllabus(true);
    let requestedModel = 'unknown';
    try {
      const modelHeaders = buildModelHeaders();
      requestedModel = modelHeaders['x-model'] || 'unknown';
      const res = await fetch('/api/learning/generate-syllabus', {
        method: 'POST',
        headers: modelHeaders,
        body: JSON.stringify({
          topic: syllabusForm.topic.trim(),
          targetAudience: syllabusForm.targetAudience.trim() || undefined,
          requirements: syllabusForm.requirements.trim() || undefined,
        }),
      });
      const payload = (await res.json()) as {
        success: boolean;
        error?: string;
        title?: string;
        description?: string;
        modelString?: string;
        providerId?: string;
        chapters?: Array<{
          title: string;
          description?: string;
          lessons: Array<{
            title: string;
            description?: string;
            learningObjectives?: string[];
            prerequisites?: string[];
            difficulty?: 'basic' | 'intermediate' | 'advanced';
            diagnosticTags?: string[];
          }>;
        }>;
      };
      if (!res.ok || !payload.success || !payload.chapters || !payload.title) {
        throw new Error(payload.error || 'AI 生成大纲失败');
      }

      setDraft({
        title: payload.title,
        description: payload.description || '',
        targetAudience: syllabusForm.targetAudience.trim(),
        source: 'ai_generated',
        chapters: payload.chapters.map((chapter) => ({
          title: chapter.title,
          description: chapter.description || '',
          lessons: chapter.lessons.map((lesson) => ({
            title: lesson.title,
            description: lesson.description || '',
            learningObjectivesText: joinListOutput(lesson.learningObjectives),
            prerequisitesText: joinListOutput(lesson.prerequisites),
            difficulty: lesson.difficulty || 'basic',
            diagnosticTagsText: joinListOutput(lesson.diagnosticTags),
            classroomId: '',
            generationStatus: 'not_started',
          })),
        })),
      });

      setIsSyllabusDialogOpen(false);
      setSyllabusForm(EMPTY_LESSON_GENERATION_FORM);
      toast.success(
        `AI 大纲已生成（模型：${payload.modelString || 'unknown'}），可继续编辑后保存`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'AI 大纲生成失败';
      toast.error(`${message}（请求模型：${requestedModel}）`);
    } finally {
      setIsGeneratingSyllabus(false);
    }
  };

  const fetchProgramAnalytics = async (programId: string) => {
    if (analyticsByProgram[programId] || analyticsLoadingByProgram[programId]) {
      return;
    }

    setAnalyticsLoadingByProgram((prev) => ({ ...prev, [programId]: true }));
    try {
      const res = await fetch(`/api/learning/syllabi/${programId}/analytics`, {
        cache: 'no-store',
      });
      const payload = (await res.json()) as {
        success: boolean;
        error?: string;
        summary?: LearningSyllabusAnalytics['summary'];
        lessons?: LearningSyllabusAnalytics['lessons'];
      };
      if (!res.ok || !payload.success || !payload.summary || !payload.lessons) {
        throw new Error(payload.error || '加载课时分析失败');
      }

      setAnalyticsByProgram((prev) => ({
        ...prev,
        [programId]: {
          summary: payload.summary!,
          lessons: payload.lessons!,
        },
      }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '加载课时分析失败');
    } finally {
      setAnalyticsLoadingByProgram((prev) => ({ ...prev, [programId]: false }));
    }
  };

  const bindLessonByGenerationTask = useCallback(async (
    lessonId: string,
    generationTaskId: string,
    classroomId?: string,
  ) => {
    const res = await fetch(`/api/learning/lessons/${lessonId}/bind-classroom`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        generationTaskId,
        classroomId,
      }),
    });
    const payload = (await res.json()) as { success: boolean; error?: string };
    if (!res.ok || !payload.success) {
      throw new Error(payload.error || '回填绑定失败');
    }
  }, []);

  const pollLessonGenerationTask = useCallback(async (lessonId: string, generationTaskId: string) => {
    if (activePollingTaskIdsRef.current.has(generationTaskId)) {
      return;
    }
    activePollingTaskIdsRef.current.add(generationTaskId);

    try {
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const res = await fetch(`/api/learning/lesson-generation-tasks/${generationTaskId}`, {
          cache: 'no-store',
        });
        const payload = (await res.json()) as {
          success: boolean;
          error?: string;
          status?: 'started' | 'processing' | 'binding_pending' | 'succeeded' | 'failed';
          classroomId?: string | null;
          classroomJob?: {
            id: string;
            status: 'queued' | 'running' | 'succeeded' | 'failed';
            step: string;
            progress: number;
            message: string;
            scenesGenerated: number;
            totalScenes: number | null;
            canResume?: boolean;
            resumedScenes?: number;
            done: boolean;
          } | null;
        };
        if (!res.ok || !payload.success || !payload.status) {
          throw new Error(payload.error || '获取生成状态失败');
        }

        if (payload.classroomJob?.id) {
          setLessonGenerationProgressByTask((prev) => ({
            ...prev,
            [generationTaskId]: {
              classroomJobId: payload.classroomJob!.id,
              status: payload.classroomJob!.status,
              step: payload.classroomJob!.step,
              progress: Math.max(0, Math.min(100, payload.classroomJob!.progress || 0)),
              message: payload.classroomJob!.message || '',
              scenesGenerated: payload.classroomJob!.scenesGenerated || 0,
              totalScenes: payload.classroomJob!.totalScenes || undefined,
              canResume: Boolean(payload.classroomJob!.canResume),
              done: payload.classroomJob!.done,
              updatedAt: Date.now(),
            },
          }));
        }

        if (payload.status === 'binding_pending') {
          if (payload.classroomId) {
            await bindLessonByGenerationTask(lessonId, generationTaskId, payload.classroomId);
            await fetchData();
            toast.success('课时内容生成完成并已自动绑定');
            return;
          }
          await fetchData();
          return;
        }

        if (payload.status === 'succeeded') {
          await fetchData();
          return;
        }

        if (payload.status === 'failed') {
          await fetchData();
          toast.error('课时内容生成失败，请重试');
          return;
        }

        await new Promise((resolve) => {
          setTimeout(resolve, 2500);
        });
      }
    } finally {
      activePollingTaskIdsRef.current.delete(generationTaskId);
    }
  }, [bindLessonByGenerationTask, fetchData]);

  const onGenerateLessonContent = async (
    programId: string,
    lessonId: string,
    options?: { forceRichMedia?: boolean },
  ) => {
    const key = `${programId}:${lessonId}`;
    if (lessonActionLoading[key]) return;

    const extraRequirements = window.prompt('可选：补充本课时生成要求（留空则按大纲默认）', '');
    if (extraRequirements === null) {
      return;
    }

    setLessonActionLoading((prev) => ({ ...prev, [key]: true }));
    let requestedModel = 'unknown';
    try {
      const modelHeaders = buildModelHeaders(options);
      requestedModel = modelHeaders['x-model'] || 'unknown';
      const res = await fetch(`/api/learning/lessons/${lessonId}/generate-content`, {
        method: 'POST',
        headers: modelHeaders,
        body: JSON.stringify({
          syllabusId: programId,
          requirements: extraRequirements.trim() || undefined,
        }),
      });
      const payload = (await res.json()) as {
        success: boolean;
        error?: string;
        generationTaskId?: string;
        classroomJobId?: string;
        progressViewUrl?: string;
        modelString?: string;
      };
      if (!res.ok || !payload.success || !payload.generationTaskId) {
        throw new Error(payload.error || '启动课时生成失败');
      }

      if (payload.classroomJobId) {
        setLessonGenerationProgressByTask((prev) => ({
          ...prev,
          [payload.generationTaskId!]: {
            classroomJobId: payload.classroomJobId!,
            status: 'queued',
            step: 'queued',
            progress: 0,
            message: '任务排队中',
            scenesGenerated: 0,
            totalScenes: undefined,
            canResume: false,
            done: false,
            updatedAt: Date.now(),
          },
        }));
      }

      toast.success(
        `${options?.forceRichMedia ? '已启动富媒体重生成' : '已启动课时生成'}（模型：${payload.modelString || 'unknown'}），正在处理中`,
        {
        action: payload.classroomJobId
          ? {
              label: '查看进度',
              onClick: () => openGenerationProgress(payload.classroomJobId!),
            }
          : undefined,
        },
      );
      await fetchData();
      await pollLessonGenerationTask(lessonId, payload.generationTaskId);
    } catch (error) {
      const message = error instanceof Error ? error.message : '启动生成失败';
      toast.error(`${message}（请求模型：${requestedModel}）`);
    } finally {
      setLessonActionLoading((prev) => ({ ...prev, [key]: false }));
    }
  };

  const onResumeLessonGeneration = async (
    programId: string,
    lessonId: string,
    generationTaskId: string,
    classroomJobId: string,
  ) => {
    const key = `${programId}:${lessonId}`;
    if (lessonActionLoading[key]) return;

    setLessonActionLoading((prev) => ({ ...prev, [key]: true }));
    let requestedModel = 'unknown';
    try {
      const modelHeaders = buildModelHeaders();
      requestedModel = modelHeaders['x-model'] || 'unknown';
      const res = await fetch(`/api/generate-classroom/${encodeURIComponent(classroomJobId)}/resume`, {
        method: 'POST',
        headers: modelHeaders,
      });
      const payload = (await res.json()) as {
        success: boolean;
        error?: string;
        resumedScenes?: number;
        totalScenes?: number;
      };
      if (!res.ok || !payload.success) {
        throw new Error(payload.error || '续跑失败');
      }

      setLessonGenerationProgressByTask((prev) => {
        const existing = prev[generationTaskId];
        return {
          ...prev,
          [generationTaskId]: {
            classroomJobId,
            status: 'queued',
            step: 'queued',
            progress: Math.max(existing?.progress || 0, 1),
            message:
              typeof payload.resumedScenes === 'number' && typeof payload.totalScenes === 'number'
                ? `续跑已排队（已完成 ${payload.resumedScenes}/${payload.totalScenes}）`
                : '续跑已排队',
            scenesGenerated:
              typeof payload.resumedScenes === 'number'
                ? payload.resumedScenes
                : existing?.scenesGenerated || 0,
            totalScenes:
              typeof payload.totalScenes === 'number'
                ? payload.totalScenes
                : existing?.totalScenes,
            canResume: false,
            done: false,
            updatedAt: Date.now(),
          },
        };
      });

      toast.success('已从断点续跑，正在继续生成', {
        action: {
          label: '查看进度',
          onClick: () => openGenerationProgress(classroomJobId),
        },
      });
      await fetchData();
      await pollLessonGenerationTask(lessonId, generationTaskId);
    } catch (error) {
      const message = error instanceof Error ? error.message : '续跑失败';
      toast.error(`${message}（请求模型：${requestedModel}）`);
    } finally {
      setLessonActionLoading((prev) => ({ ...prev, [key]: false }));
    }
  };

  useEffect(() => {
    if (!data) return;

    for (const item of data.programs) {
      for (const chapter of item.program.chapters) {
        for (const lesson of chapter.lessons) {
          if (
            (lesson.generationStatus === 'started' ||
              lesson.generationStatus === 'processing' ||
              lesson.generationStatus === 'binding_pending') &&
            lesson.lastGenerationTaskId
          ) {
            void pollLessonGenerationTask(lesson.id, lesson.lastGenerationTaskId);
          }
        }
      }
    }
  }, [data, pollLessonGenerationTask]);

  const onSaveProgramDraft = async () => {
    if (submitting) return;
    if (!draft.title.trim()) {
      toast.error('请先填写课程体系标题');
      return;
    }

    const chapters = normalizeDraftChapters();

    setSubmitting(true);
    try {
      if (editingProgramId) {
        const currentProgramStatus =
          data?.programs.find((item) => item.program.id === editingProgramId)?.program.status || 'draft';
        const res = await fetch(`/api/learning/syllabi/${editingProgramId}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            title: draft.title,
            description: draft.description,
            targetAudience: draft.targetAudience,
            source: draft.source,
            status: currentProgramStatus,
            chapters,
          }),
        });
        const payload = (await res.json()) as { success: boolean; error?: string };
        if (!res.ok || !payload.success) {
          throw new Error(payload.error || '更新课程体系失败');
        }
        toast.success('课程体系已更新');
      } else {
        const res = await fetch('/api/learning/syllabi', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            title: draft.title,
            description: draft.description,
            targetAudience: draft.targetAudience,
            source: draft.source,
            status: 'draft',
            chapters,
          }),
        });
        const payload = (await res.json()) as { success: boolean; error?: string };
        if (!res.ok || !payload.success) {
          throw new Error(payload.error || '创建课程体系失败');
        }
        toast.success('课程体系创建成功');
        resetDraft();
      }

      await fetchData();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存失败');
    } finally {
      setSubmitting(false);
    }
  };

  const onPrepublishAndPublish = async (programId: string) => {
    try {
      const checkResult = (await callAction({
        action: 'prepublish_check',
        programId,
      })) as { success: true; warnings?: Array<{ level: 'info' | 'warning'; message: string }> };

      const warnings = checkResult.warnings || [];
      let confirmPublish = false;
      if (warnings.length > 0) {
        const warningText = warnings
          .map((item, index) => `${index + 1}. [${item.level === 'warning' ? '警告' : '提示'}] ${item.message}`)
          .join('\n');

        confirmPublish = window.confirm(
          `发布前检查发现以下提示：\n\n${warningText}\n\n是否仍然发布？`,
        );

        if (!confirmPublish) {
          toast.message('已取消发布，可先补充内容后再发布');
          return;
        }
      }

      await callAction({
        action: 'publish_program',
        programId,
        confirmPublish,
      });

      toast.success('课程体系已发布，可开始派发或接受学生申请');
      await fetchData();
    } catch (error) {
      const warnings = (error as Error & { warnings?: Array<{ message: string }> }).warnings;
      if (warnings?.length) {
        toast.error(warnings[0].message);
      } else {
        toast.error(error instanceof Error ? error.message : '发布失败');
      }
    }
  };

  const toggleStudentSelection = (programId: string, studentId: string) => {
    setSelectedStudentIdsByProgram((prev) => {
      const current = prev[programId] || [];
      const next = current.includes(studentId)
        ? current.filter((item) => item !== studentId)
        : [...current, studentId];
      return { ...prev, [programId]: next };
    });
  };

  const onAssignProgram = async (programId: string) => {
    const studentIds = selectedStudentIdsByProgram[programId] || [];
    if (studentIds.length === 0) {
      toast.error('请先至少选择一位学生');
      return;
    }

    try {
      await callAction({
        action: 'assign_program_to_students',
        programId,
        studentIds,
      });
      toast.success('派发成功，学生端将显示待接收课程体系');
      await fetchData();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '派发失败');
    }
  };

  const onDeleteProgram = async (programItem: TeacherLearningView['programs'][number]) => {
    if (deletingProgramId === programItem.program.id) return;

    const confirmed = window.confirm(
      [
        `确认删除课程体系「${programItem.program.title}」吗？`,
        '',
        '这会同时删除：',
        `- 课程体系本身`,
        `- ${programItem.assignedCount} 条学生派发记录`,
        `- ${programItem.pendingApplicationCount} 条申请记录`,
        '- 相关课时生成任务记录',
        '',
        '已生成的课堂内容页面不会自动删除。',
      ].join('\n'),
    );

    if (!confirmed) return;

    setDeletingProgramId(programItem.program.id);
    try {
      const res = await fetch(`/api/learning/syllabi/${programItem.program.id}`, {
        method: 'DELETE',
      });
      const payload = (await res.json()) as { success: boolean; error?: string; title?: string };
      if (!res.ok || !payload.success) {
        throw new Error(payload.error || '删除课程体系失败');
      }

      if (editingProgramId === programItem.program.id) {
        resetDraft();
        setActivePanel('operate');
      }
      if (selectedLessonRef?.programId === programItem.program.id) {
        setSelectedLessonRef(null);
      }
      if (expandedProgramId === programItem.program.id) {
        setExpandedProgramId(null);
      }
      if (assignProgramId === programItem.program.id) {
        setAssignProgramId(null);
      }
      setSelectedAssignmentId(null);
      setSelectedStudentIdsByProgram((prev) => {
        const next = { ...prev };
        delete next[programItem.program.id];
        return next;
      });
      setAnalyticsByProgram((prev) => {
        const next = { ...prev };
        delete next[programItem.program.id];
        return next;
      });
      setExpandedChapterKeys((prev) => {
        const next = { ...prev };
        Object.keys(next).forEach((key) => {
          if (key.startsWith(`${programItem.program.id}:`)) {
            delete next[key];
          }
        });
        return next;
      });

      await fetchData();
      toast.success(`课程体系「${payload.title || programItem.program.title}」已删除`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '删除课程体系失败');
    } finally {
      setDeletingProgramId(null);
    }
  };

  const onBindLessonClassroom = async (
    programId: string,
    lessonId: string,
    fallbackValue?: string,
    generationTaskId?: string,
  ) => {
    const key = `${programId}:${lessonId}`;
    const classroomId = (classroomIdInputs[key] ?? fallbackValue ?? '').trim();

    try {
      const res = await fetch(`/api/learning/lessons/${lessonId}/bind-classroom`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          classroomId,
          generationTaskId,
        }),
      });
      const payload = (await res.json()) as { success: boolean; error?: string };
      if (!res.ok || !payload.success) {
        throw new Error(payload.error || '绑定失败');
      }
      toast.success(classroomId ? '课时已绑定课堂内容' : '已清除课时绑定');
      await fetchData();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '绑定失败');
    }
  };

  const onReviewApplication = async (
    application: LearningProgramApplication,
    decision: 'approved' | 'rejected',
  ) => {
    try {
      await callAction({
        action: 'review_application',
        applicationId: application.id,
        decision,
        reviewNote: interventionNotes[`application:${application.id}`] || '',
      });
      toast.success(decision === 'approved' ? '已批准申请并生成派发' : '已拒绝申请');
      await fetchData();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '审核失败');
    }
  };

  const onResolveIntervention = async (item: TeacherInterventionItem) => {
    try {
      if (item.type === 'stuck' && item.stuckId) {
        await callAction({
          action: 'resolve_stuck',
          assignmentId: item.assignmentId,
          stuckId: item.stuckId,
          note: interventionNotes[item.id] || '',
        });
      } else if (item.type === 'risk' && item.riskKey) {
        await callAction({
          action: 'resolve_risk',
          assignmentId: item.assignmentId,
          riskKey: item.riskKey,
          note: interventionNotes[item.id] || '',
        });
      }
      toast.success('已记录介入处理');
      await fetchData();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '处理失败');
    }
  };

  if (loading || !data) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-b from-slate-50 to-slate-100 dark:from-slate-950 dark:to-slate-900">
        <div className="rounded-2xl border border-white/60 bg-white/70 px-6 py-4 text-sm text-slate-500 shadow-xl shadow-black/[0.03] backdrop-blur-xl dark:border-slate-800/70 dark:bg-slate-900/70">
          正在加载教师工作台…
        </div>
      </div>
    );
  }

  const selectedLessonKey = selectedLessonContext
    ? `${selectedLessonContext.programItem.program.id}:${selectedLessonContext.lesson.id}`
    : '';
  const selectedLessonInputValue = selectedLessonContext
    ? classroomIdInputs[selectedLessonKey] !== undefined
      ? classroomIdInputs[selectedLessonKey]
      : selectedLessonContext.lesson.classroomId || ''
    : '';
  const selectedLessonIsGenerating = selectedLessonKey
    ? Boolean(lessonActionLoading[selectedLessonKey])
    : false;
  const selectedLessonCanResume =
    selectedLessonContext?.lesson.generationStatus === 'failed' &&
    Boolean(
      selectedLessonContext.lesson.lastGenerationTaskId &&
        selectedLessonContext.progress?.classroomJobId,
    ) &&
    selectedLessonContext.progress?.canResume !== false;
  const assignSelectedStudentIds = assignProgram
    ? selectedStudentIdsByProgram[assignProgram.program.id] || []
    : [];

  return (
    <div className="relative min-h-screen overflow-hidden bg-gradient-to-b from-slate-50 to-slate-100 p-4 text-slate-950 dark:from-slate-950 dark:to-slate-900 dark:text-white md:p-8">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-24 left-1/4 size-96 rounded-full bg-blue-500/10 blur-3xl animate-pulse [animation-duration:4s]" />
        <div className="absolute bottom-0 right-1/5 size-96 rounded-full bg-violet-500/10 blur-3xl animate-pulse [animation-duration:6s]" />
      </div>

      <div className="relative z-10 mx-auto flex max-w-7xl flex-col gap-6">
        <motion.header
          initial={{ opacity: 0, y: -12 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col gap-4 rounded-full border border-white/60 bg-white/70 px-4 py-3 shadow-sm backdrop-blur-xl dark:border-slate-800/70 dark:bg-slate-900/70 md:flex-row md:items-center md:justify-between"
        >
          <div className="flex items-center gap-3">
            <img src="/logo-horizontal.png" alt="OpenMAIC" className="h-8 w-auto" />
            <div className="hidden h-6 w-px bg-slate-200 dark:bg-slate-700 md:block" />
            <div>
              <div className="text-sm font-semibold">{username} 老师工作台</div>
              <div className="text-xs text-slate-500 dark:text-slate-400">
                只展示今天最该处理的课程、学生和生成任务
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Dialog open={isSyllabusDialogOpen} onOpenChange={setIsSyllabusDialogOpen}>
              <DialogTrigger asChild>
                <Button size="sm" className="rounded-full">
                  <Wand2 className="size-4" />
                  AI 生成体系
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-xl border-white/60 bg-white/90 backdrop-blur-xl dark:border-slate-800 dark:bg-slate-950/90">
                <DialogHeader>
                  <DialogTitle>AI 生成体系大纲</DialogTitle>
                  <DialogDescription>
                    输入主题后生成课程、章节和课时草稿，生成后可在“课程设计”中精修。
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-3">
                  <Input
                    value={syllabusForm.topic}
                    onChange={(e) => setSyllabusForm((prev) => ({ ...prev, topic: e.target.value }))}
                    placeholder="课程主题，例如：初二物理电学"
                  />
                  <Input
                    value={syllabusForm.targetAudience}
                    onChange={(e) =>
                      setSyllabusForm((prev) => ({ ...prev, targetAudience: e.target.value }))
                    }
                    placeholder="目标受众（可选）"
                  />
                  <Textarea
                    value={syllabusForm.requirements}
                    onChange={(e) =>
                      setSyllabusForm((prev) => ({ ...prev, requirements: e.target.value }))
                    }
                    placeholder="补充要求（可选）"
                    rows={4}
                  />
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setIsSyllabusDialogOpen(false)}>
                    取消
                  </Button>
                  <Button onClick={onGenerateSyllabusDraft} disabled={isGeneratingSyllabus}>
                    {isGeneratingSyllabus ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Sparkles className="size-4" />
                    )}
                    生成大纲
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
            <Button
              size="sm"
              variant="outline"
              className="rounded-full bg-white/60 dark:bg-slate-900/60"
              onClick={() => {
                resetDraft();
                setActivePanel('design');
              }}
            >
              <PlusCircle className="size-4" />
              新建课程
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="rounded-full"
              onClick={() => setSettingsOpen(true)}
            >
              <Settings className="size-4" />
              模型/API
            </Button>
            <LogoutButton />
          </div>
        </motion.header>

        <motion.section
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.08 }}
          className="rounded-[2rem] border border-white/60 bg-white/80 p-5 shadow-2xl shadow-black/[0.04] backdrop-blur-xl dark:border-slate-800/70 dark:bg-slate-900/80 md:p-7"
        >
          <div className="space-y-5">
            <div className="min-w-0 space-y-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="mb-2 inline-flex items-center gap-2 rounded-full bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700 dark:bg-blue-950/40 dark:text-blue-200">
                    <Radio className="size-3.5" />
                    今日运营台
                  </div>
                  <h1 className="text-2xl font-semibold tracking-tight md:text-4xl">
                    先处理会影响学习推进的事
                  </h1>
                  <p className="mt-2 max-w-2xl text-sm text-slate-500 dark:text-slate-400">
                    课程创建、内容生成、学生风险和申请审核都收敛到任务流里，详情按需打开。
                  </p>
                </div>
                <ProgressRing value={stats.totalPrograms ? Math.round((stats.publishedPrograms / stats.totalPrograms) * 100) : 0} />
              </div>

              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                {[
                  { label: '课程', value: stats.totalPrograms, icon: Layers3 },
                  { label: '已发布', value: stats.publishedPrograms, icon: CheckCircle2 },
                  { label: '生成队列', value: generationQueue.length, icon: Sparkles },
                  { label: '待介入', value: stats.openInterventions, icon: Siren },
                ].map((metric) => {
                  const Icon = metric.icon;
                  return (
                    <div
                      key={metric.label}
                      className="rounded-2xl border border-slate-200/70 bg-white/70 p-4 shadow-sm dark:border-slate-800/70 dark:bg-slate-950/40"
                    >
                      <Icon className="mb-3 size-4 text-slate-400" />
                      <div className="text-2xl font-semibold">{metric.value}</div>
                      <div className="text-xs text-slate-500">{metric.label}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </motion.section>

        <div className="flex gap-2 overflow-x-auto rounded-full border border-white/60 bg-white/60 p-1 backdrop-blur-xl dark:border-slate-800/70 dark:bg-slate-900/60">
          {[
            { id: 'operate' as TeacherPanel, label: '任务台', icon: LayoutDashboard },
            { id: 'design' as TeacherPanel, label: '课程设计', icon: Workflow },
            { id: 'insights' as TeacherPanel, label: '学生洞察', icon: BarChart3 },
            { id: 'applications' as TeacherPanel, label: '申请审核', icon: Users },
          ].map((item) => {
            const Icon = item.icon;
            const count = panelCounts[item.id];
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActivePanel(item.id)}
                className={cn(
                  'inline-flex shrink-0 items-center gap-2 rounded-full px-4 py-2 text-sm transition',
                  activePanel === item.id
                    ? 'bg-slate-950 text-white shadow-sm dark:bg-white dark:text-slate-950'
                    : 'text-slate-500 hover:bg-white/70 hover:text-slate-950 dark:hover:bg-slate-800 dark:hover:text-white',
                )}
              >
                <Icon className="size-4" />
                {item.label}
                {count > 0 && (
                  <span
                    className={cn(
                      'inline-flex min-w-5 items-center justify-center rounded-full px-1.5 py-0.5 text-[11px] font-semibold',
                      activePanel === item.id
                        ? 'bg-white/15 text-white dark:bg-slate-900/15 dark:text-slate-950'
                        : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-200',
                    )}
                  >
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {activePanel === 'operate' && (
          <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(320px,380px)]">
            <section className="min-w-0">
              {data.programs.length === 0 ? (
                <div className="rounded-[2rem] border border-dashed border-slate-300 bg-white/70 p-8 text-center text-sm text-slate-500 backdrop-blur-xl dark:border-slate-700 dark:bg-slate-900/70">
                  还没有课程体系。点击顶部“AI 生成体系”或“新建课程”开始。
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-x-5 gap-y-8 md:grid-cols-3 2xl:grid-cols-4">
                  {data.programs.map((item, programIndex) => {
                    const analyticsForProgram = analyticsByProgram[item.program.id];
                    const courseProgress = item.assignedCount
                      ? Math.round((item.completedCount / item.assignedCount) * 100)
                      : 0;
                    const totalLessonCount = item.program.chapters.reduce(
                      (sum, chapter) => sum + chapter.lessons.length,
                      0,
                    );
                    const generatedLessonCount = item.program.chapters.reduce(
                      (sum, chapter) =>
                        sum +
                        chapter.lessons.filter((lesson) => lesson.generationStatus === 'succeeded')
                          .length,
                      0,
                    );
                    const isProgramExpanded = expandedProgramId === item.program.id;

                    return (
                      <motion.article
                        key={item.program.id}
                        initial={{ opacity: 0, y: 16 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: programIndex * 0.04 }}
                        className={cn(
                          'min-w-0',
                          isProgramExpanded && 'col-span-2 md:col-span-3 2xl:col-span-4',
                        )}
                      >
                        {!isProgramExpanded ? (
                          <ProgramThumbnailCard
                            program={item.program}
                            slide={programPreviewSlides[item.program.id]}
                            totalLessonCount={totalLessonCount}
                            generatedLessonCount={generatedLessonCount}
                            pendingApplicationCount={item.pendingApplicationCount}
                            onOpen={() => setExpandedProgramId(item.program.id)}
                          />
                        ) : (
                          <div className="min-w-0 overflow-hidden rounded-[1.75rem] border border-white/60 bg-white/80 p-5 shadow-xl shadow-black/[0.03] backdrop-blur-xl dark:border-slate-800/70 dark:bg-slate-900/80">
                            <ProgramExpandedHeader
                              item={item}
                              slide={programPreviewSlides[item.program.id]}
                              courseProgress={courseProgress}
                              totalLessonCount={totalLessonCount}
                              generatedLessonCount={generatedLessonCount}
                              isDeleting={deletingProgramId === item.program.id}
                              onCollapse={() => setExpandedProgramId(null)}
                              onLoadDraft={() => loadProgramToDraft(item.program)}
                              onPublish={() => onPrepublishAndPublish(item.program.id)}
                              onAssign={() => setAssignProgramId(item.program.id)}
                              onDelete={() => onDeleteProgram(item)}
                            />

                            <div className="mt-5 space-y-3 border-t border-slate-200/70 pt-5 dark:border-slate-800/70">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <div className="text-sm font-medium text-slate-700 dark:text-slate-200">
                                  章节与课时
                                </div>
                                <div className="text-xs text-slate-500">
                                  {item.program.chapters.length} 章 · {totalLessonCount} 课时 · 已生成{' '}
                                  {generatedLessonCount}
                                </div>
                              </div>
                              <div className="space-y-2">
                                {item.program.chapters.map((chapter) => {
                                  const chapterKey = `${item.program.id}:${chapter.id}`;
                                  const isExpanded = Boolean(expandedChapterKeys[chapterKey]);
                                  const chapterGeneratedCount = chapter.lessons.filter(
                                    (lesson) => lesson.generationStatus === 'succeeded',
                                  ).length;

                                  return (
                                    <div
                                      key={chapter.id}
                                      className="rounded-2xl border border-slate-200/70 bg-slate-50/80 dark:border-slate-800/70 dark:bg-slate-950/40"
                                    >
                                      <button
                                        type="button"
                                        onClick={() =>
                                          setExpandedChapterKeys((prev) => ({
                                            ...prev,
                                            [chapterKey]: !prev[chapterKey],
                                          }))
                                        }
                                        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
                                      >
                                        <div className="min-w-0">
                                          <div className="flex items-center gap-2 text-sm font-medium">
                                            <BookOpen className="size-4 shrink-0 text-slate-400" />
                                            <span className="truncate">{chapter.title}</span>
                                          </div>
                                          <div className="mt-1 text-xs text-slate-500">
                                            {chapter.lessons.length} 个课时 · 已生成 {chapterGeneratedCount}
                                          </div>
                                        </div>
                                        <div className="flex items-center gap-2 text-xs text-slate-500">
                                          <span>{isExpanded ? '收起课时' : '展开课时'}</span>
                                          <ChevronDown
                                            className={cn(
                                              'size-4 shrink-0 transition-transform',
                                              isExpanded && 'rotate-180',
                                            )}
                                          />
                                        </div>
                                      </button>

                                      {isExpanded && (
                                        <div className="border-t border-slate-200/70 px-4 pb-4 pt-3 dark:border-slate-800/70">
                                          <div className="grid gap-2 lg:grid-cols-2">
                                            {chapter.lessons.map((lesson) => (
                                              <button
                                                key={lesson.id}
                                                type="button"
                                                onClick={() =>
                                                  setSelectedLessonRef({
                                                    programId: item.program.id,
                                                    chapterId: chapter.id,
                                                    lessonId: lesson.id,
                                                  })
                                                }
                                                className={cn(
                                                  'group flex items-center justify-between gap-2 rounded-xl border px-3 py-2 text-left text-xs transition hover:-translate-y-0.5 hover:shadow-sm',
                                                  lessonNodeTone(lesson.generationStatus),
                                                )}
                                              >
                                                <span className="line-clamp-1">{lesson.title}</span>
                                                <span className="shrink-0 text-[10px] opacity-70">
                                                  {lessonGenerationStatusText(lesson.generationStatus)}
                                                </span>
                                              </button>
                                            ))}
                                          </div>
                                        </div>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>

                              <div className="mt-4 flex flex-wrap gap-2">
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => fetchProgramAnalytics(item.program.id)}
                                  disabled={analyticsLoadingByProgram[item.program.id]}
                                >
                                  {analyticsLoadingByProgram[item.program.id] ? (
                                    <Loader2 className="size-4 animate-spin" />
                                  ) : (
                                    <RefreshCw className="size-4" />
                                  )}
                                  查看分析
                                </Button>
                              </div>

                              {analyticsForProgram && (
                                <div className="mt-4 grid gap-2 rounded-2xl border border-slate-200/70 bg-white/60 p-3 text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-950/30 md:grid-cols-3">
                                  <div>学生数 {analyticsForProgram.summary.studentCount}</div>
                                  <div>完成率 {Math.round(analyticsForProgram.summary.completionRate * 100)}%</div>
                                  <div>
                                    正确率{' '}
                                    {analyticsForProgram.summary.averageAccuracy === null
                                      ? 'N/A'
                                      : `${Math.round(analyticsForProgram.summary.averageAccuracy * 100)}%`}
                                  </div>
                                </div>
                              )}
                            </div>
                          </div>
                        )}
                      </motion.article>
                    );
                  })}
                </div>
              )}
            </section>

            <aside className="min-w-0 space-y-4 xl:sticky xl:top-6">
              <div className="min-w-0 rounded-[1.75rem] border border-white/60 bg-white/80 p-5 shadow-xl shadow-black/[0.03] backdrop-blur-xl dark:border-slate-800/70 dark:bg-slate-900/80">
                <div className="mb-4 flex items-center justify-between">
                  <div>
                    <h2 className="font-semibold">生成队列</h2>
                    <p className="text-xs text-slate-500">只看需要操作的课时</p>
                  </div>
                  <Sparkles className="size-5 text-blue-500" />
                </div>
                <div className="min-w-0 space-y-2">
                  {generationQueue.length === 0 ? (
                    <div className="rounded-2xl bg-slate-50 p-4 text-sm text-slate-500 dark:bg-slate-950/40">
                      暂无生成中或失败任务。
                    </div>
                  ) : (
                    generationQueue.slice(0, 6).map((item) => (
                      <button
                        key={`${item.program.id}:${item.lesson.id}`}
                        type="button"
                        onClick={() =>
                          setSelectedLessonRef({
                            programId: item.program.id,
                            chapterId: item.chapter.id,
                            lessonId: item.lesson.id,
                          })
                        }
                        className="w-full rounded-2xl border border-slate-200/70 bg-slate-50/80 p-3 text-left transition hover:bg-white dark:border-slate-800 dark:bg-slate-950/40 dark:hover:bg-slate-900"
                      >
                        <div className="flex items-center justify-between gap-2 text-sm font-medium">
                          <span className="line-clamp-1">{item.lesson.title}</span>
                          <Badge variant={lessonGenerationStatusVariant(item.lesson.generationStatus)}>
                            {lessonGenerationStatusText(item.lesson.generationStatus)}
                          </Badge>
                        </div>
                        {item.progress && (
                          <div className="mt-2">
                            <div className="mb-1 flex justify-between text-[11px] text-slate-500">
                              <span>{classroomJobStepText(item.progress.step)}</span>
                              <span>{item.progress.progress}%</span>
                            </div>
                            <div className="h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                              <div
                                className="h-full rounded-full bg-blue-500 transition-all"
                                style={{ width: `${item.progress.progress}%` }}
                              />
                            </div>
                          </div>
                        )}
                      </button>
                    ))
                  )}
                </div>
              </div>

              <div className="min-w-0 rounded-[1.75rem] border border-white/60 bg-white/80 p-5 shadow-xl shadow-black/[0.03] backdrop-blur-xl dark:border-slate-800/70 dark:bg-slate-900/80">
                <div className="mb-4 flex items-center justify-between">
                  <div>
                    <h2 className="font-semibold">干预收件箱</h2>
                    <p className="text-xs text-slate-500">风险和卡点优先处理</p>
                  </div>
                  <Siren className="size-5 text-rose-500" />
                </div>
                <div className="min-w-0 space-y-2">
                  {data.interventionInbox.length === 0 ? (
                    <div className="rounded-2xl bg-slate-50 p-4 text-sm text-slate-500 dark:bg-slate-950/40">
                      暂无待介入事项。
                    </div>
                  ) : (
                    data.interventionInbox.slice(0, 5).map((item) => (
                      <div key={item.id} className="rounded-2xl border border-rose-200/70 bg-rose-50/70 p-3 dark:border-rose-900/60 dark:bg-rose-950/20">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <div className="text-sm font-medium text-rose-700 dark:text-rose-200">
                              {item.studentUsername}
                            </div>
                            <div className="line-clamp-2 text-xs text-slate-600 dark:text-slate-300">
                              {item.note}
                            </div>
                            <div className="mt-1 text-[11px] text-slate-500">
                              {item.lessonTitle || item.programTitle} · {formatDateTime(item.createdAt)}
                            </div>
                          </div>
                          <Badge variant="outline">{item.type === 'stuck' ? '卡点' : '风险'}</Badge>
                        </div>
                        <details className="mt-2">
                          <summary className="cursor-pointer text-xs text-rose-600">处理</summary>
                          <div className="mt-2 flex flex-col gap-2">
                            <Input
                              value={interventionNotes[item.id] || ''}
                              onChange={(e) =>
                                setInterventionNotes((prev) => ({ ...prev, [item.id]: e.target.value }))
                              }
                              placeholder="介入备注（可选）"
                            />
                            <Button size="sm" variant="outline" onClick={() => onResolveIntervention(item)}>
                              <CheckCircle2 className="size-4" />
                              标记已介入
                            </Button>
                          </div>
                        </details>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </aside>
          </div>
        )}

        {activePanel === 'design' && (
          <section className="rounded-[2rem] border border-white/60 bg-white/80 p-5 shadow-2xl shadow-black/[0.04] backdrop-blur-xl dark:border-slate-800/70 dark:bg-slate-900/80 md:p-7">
            <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-xl font-semibold">课程设计</h2>
                <p className="text-sm text-slate-500">默认只露出关键字段，课时细节展开后再编辑。</p>
              </div>
              <div className="flex gap-2">
                <Button onClick={onSaveProgramDraft} disabled={submitting}>
                  <BookOpen className="size-4" />
                  {editingProgramId ? '更新课程体系' : '保存课程体系'}
                </Button>
                {editingProgramId && (
                  <Button variant="outline" onClick={resetDraft}>
                    取消编辑
                  </Button>
                )}
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-3">
              <Input value={draft.title} onChange={(e) => updateDraft('title', e.target.value)} placeholder="课程体系标题" />
              <Input value={draft.description} onChange={(e) => updateDraft('description', e.target.value)} placeholder="课程简介" />
              <Input value={draft.targetAudience} onChange={(e) => updateDraft('targetAudience', e.target.value)} placeholder="目标受众" />
            </div>

            <div className="mt-5 space-y-3">
              {draft.chapters.map((chapter, chapterIndex) => (
                <div key={`draft-chapter-${chapter.id || chapterIndex}`} className="rounded-3xl border border-slate-200/70 bg-slate-50/80 p-4 dark:border-slate-800 dark:bg-slate-950/30">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2 font-medium">
                      <Layers3 className="size-4 text-slate-400" />
                      章节 {chapterIndex + 1}
                    </div>
                    <Button size="sm" variant="ghost" onClick={() => removeChapter(chapterIndex)} disabled={draft.chapters.length === 1}>
                      删除章节
                    </Button>
                  </div>
                  <div className="mt-3 grid gap-2 md:grid-cols-2">
                    <Input value={chapter.title} onChange={(e) => updateChapter(chapterIndex, { title: e.target.value })} placeholder="章节标题" />
                    <Input value={chapter.description} onChange={(e) => updateChapter(chapterIndex, { description: e.target.value })} placeholder="章节描述（可选）" />
                  </div>
                  <div className="mt-3 grid gap-2">
                    {chapter.lessons.map((lesson, lessonIndex) => (
                      <details key={`draft-lesson-${lesson.id || lessonIndex}`} className="rounded-2xl border border-slate-200/70 bg-white/70 p-3 dark:border-slate-800 dark:bg-slate-900/50">
                        <summary className="cursor-pointer text-sm font-medium">
                          {lesson.title || `课时 ${lessonIndex + 1}`}
                        </summary>
                        <div className="mt-3 grid gap-2">
                          <div className="grid gap-2 md:grid-cols-12">
                            <Input className="md:col-span-4" value={lesson.title} onChange={(e) => updateLesson(chapterIndex, lessonIndex, { title: e.target.value })} placeholder="课时标题" />
                            <Input className="md:col-span-4" value={lesson.description} onChange={(e) => updateLesson(chapterIndex, lessonIndex, { description: e.target.value })} placeholder="课时说明（可选）" />
                            <select className="h-9 rounded-md border border-input bg-transparent px-3 text-sm md:col-span-2" value={lesson.difficulty} onChange={(e) => updateLesson(chapterIndex, lessonIndex, { difficulty: e.target.value as DraftLesson['difficulty'] })}>
                              <option value="basic">基础</option>
                              <option value="intermediate">进阶</option>
                              <option value="advanced">高级</option>
                            </select>
                            <Button className="md:col-span-2" size="sm" variant="outline" onClick={() => removeLesson(chapterIndex, lessonIndex)}>
                              删除课时
                            </Button>
                          </div>
                          <Input value={lesson.learningObjectivesText} onChange={(e) => updateLesson(chapterIndex, lessonIndex, { learningObjectivesText: e.target.value })} placeholder="学习目标（用；分隔）" />
                          <Input value={lesson.prerequisitesText} onChange={(e) => updateLesson(chapterIndex, lessonIndex, { prerequisitesText: e.target.value })} placeholder="先修知识（用；分隔）" />
                          <Input value={lesson.diagnosticTagsText} onChange={(e) => updateLesson(chapterIndex, lessonIndex, { diagnosticTagsText: e.target.value })} placeholder="诊断标签（用；分隔）" />
                          <Input value={lesson.classroomId} onChange={(e) => updateLesson(chapterIndex, lessonIndex, { classroomId: e.target.value })} placeholder="classroomId（可选）" />
                        </div>
                      </details>
                    ))}
                  </div>
                  <Button className="mt-3" size="sm" variant="outline" onClick={() => addLesson(chapterIndex)}>
                    <PlusCircle className="size-4" />
                    新增课时
                  </Button>
                </div>
              ))}
              <Button variant="outline" onClick={addChapter}>
                <PlusCircle className="size-4" />
                新增章节
              </Button>
            </div>
          </section>
        )}

        {activePanel === 'insights' && (
          <section className="grid gap-6 lg:grid-cols-[1fr_360px]">
            <div className="rounded-[2rem] border border-white/60 bg-white/80 p-5 shadow-xl shadow-black/[0.03] backdrop-blur-xl dark:border-slate-800/70 dark:bg-slate-900/80">
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <h2 className="text-xl font-semibold">风险雷达</h2>
                  <p className="text-sm text-slate-500">按风险优先级聚合学生，不再逐章铺开。</p>
                </div>
                <AlertTriangle className="size-5 text-amber-500" />
              </div>
              <div className="grid gap-3">
                {data.assignments.length === 0 ? (
                  <div className="rounded-2xl bg-slate-50 p-6 text-sm text-slate-500 dark:bg-slate-950/40">
                    暂无学习数据，先发布并派发课程体系。
                  </div>
                ) : (
                  data.assignments.map((row) => {
                    const topRisk = row.riskSignals[0];
                    return (
                      <button
                        key={row.assignment.id}
                        type="button"
                        onClick={() => setSelectedAssignmentId(row.assignment.id)}
                        className="flex items-center gap-4 rounded-2xl border border-slate-200/70 bg-slate-50/80 p-4 text-left transition hover:-translate-y-0.5 hover:bg-white hover:shadow-md dark:border-slate-800 dark:bg-slate-950/40 dark:hover:bg-slate-900"
                      >
                        <div className="grid size-11 place-items-center rounded-full bg-gradient-to-br from-blue-100 to-violet-100 text-sm font-semibold text-blue-700 dark:from-blue-950 dark:to-violet-950 dark:text-blue-200">
                          {row.assignment.studentUsername.slice(0, 1).toUpperCase()}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">{row.assignment.studentUsername}</span>
                            <span className="text-xs text-slate-500">· {row.program.title}</span>
                          </div>
                          <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                            <div
                              className={cn('h-full rounded-full bg-gradient-to-r', riskHeatTone(topRisk?.level))}
                              style={{ width: `${row.progressPercent}%` }}
                            />
                          </div>
                        </div>
                        <div className="text-right text-xs text-slate-500">
                          <div className="font-semibold text-slate-900 dark:text-white">{row.progressPercent}%</div>
                          <div>{row.openStuckCount} 卡点</div>
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
            <div className="rounded-[2rem] border border-white/60 bg-white/80 p-5 shadow-xl shadow-black/[0.03] backdrop-blur-xl dark:border-slate-800/70 dark:bg-slate-900/80">
              <h3 className="font-semibold">优先关注</h3>
              <div className="mt-4 space-y-2">
                {topRiskRows.length === 0 ? (
                  <div className="rounded-2xl bg-slate-50 p-4 text-sm text-slate-500 dark:bg-slate-950/40">
                    暂无高风险学生。
                  </div>
                ) : (
                  topRiskRows.map((row) => (
                    <button
                      key={row.assignment.id}
                      type="button"
                      onClick={() => setSelectedAssignmentId(row.assignment.id)}
                      className="w-full rounded-2xl bg-slate-50 p-3 text-left text-sm transition hover:bg-white dark:bg-slate-950/40 dark:hover:bg-slate-900"
                    >
                      <div className="font-medium">{row.assignment.studentUsername}</div>
                      <div className="text-xs text-slate-500">{row.riskSignals[0]?.message || `${row.openStuckCount} 个待处理卡点`}</div>
                    </button>
                  ))
                )}
              </div>
            </div>
          </section>
        )}

        {activePanel === 'applications' && (
          <section className="rounded-[2rem] border border-white/60 bg-white/80 p-5 shadow-xl shadow-black/[0.03] backdrop-blur-xl dark:border-slate-800/70 dark:bg-slate-900/80">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-xl font-semibold">申请审核</h2>
                <p className="text-sm text-slate-500">任务卡只保留判断所需信息，备注按需展开。</p>
              </div>
              <Users className="size-5 text-blue-500" />
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {pendingApplications.length === 0 ? (
                <div className="rounded-2xl bg-slate-50 p-6 text-sm text-slate-500 dark:bg-slate-950/40">
                  当前没有待审核申请。
                </div>
              ) : (
                pendingApplications.map((application) => {
                  const program = data.programs.find((item) => item.program.id === application.programId)?.program;
                  const noteKey = `application:${application.id}`;
                  return (
                    <div key={application.id} className="rounded-3xl border border-slate-200/70 bg-slate-50/80 p-4 dark:border-slate-800 dark:bg-slate-950/40">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="font-medium">{application.studentUsername}</div>
                          <div className="text-sm text-slate-500">申请《{program?.title || '未知课程'}》</div>
                          <div className="mt-1 text-xs text-slate-400">{formatDateTime(application.createdAt)}</div>
                        </div>
                        <Badge variant="outline">待审核</Badge>
                      </div>
                      {application.note && (
                        <div className="mt-3 rounded-2xl bg-white/70 p-3 text-xs text-slate-600 dark:bg-slate-900/70 dark:text-slate-300">
                          {application.note}
                        </div>
                      )}
                      <details className="mt-3">
                        <summary className="cursor-pointer text-xs text-blue-600">处理申请</summary>
                        <div className="mt-2 space-y-2">
                          <Textarea
                            value={interventionNotes[noteKey] || ''}
                            onChange={(e) => setInterventionNotes((prev) => ({ ...prev, [noteKey]: e.target.value }))}
                            placeholder="审核备注（可选）"
                          />
                          <div className="flex gap-2">
                            <Button size="sm" onClick={() => onReviewApplication(application, 'approved')}>
                              通过并派发
                            </Button>
                            <Button size="sm" variant="outline" onClick={() => onReviewApplication(application, 'rejected')}>
                              拒绝
                            </Button>
                          </div>
                        </div>
                      </details>
                    </div>
                  );
                })
              )}
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
                  {selectedLessonContext.programItem.program.title} · {selectedLessonContext.chapter.title}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={lessonGenerationStatusVariant(selectedLessonContext.lesson.generationStatus)}>
                    {lessonGenerationStatusText(selectedLessonContext.lesson.generationStatus)}
                  </Badge>
                  <Badge variant="outline">{selectedLessonContext.lesson.difficulty}</Badge>
                  {selectedLessonContext.lesson.classroomId && (
                    <Badge variant="secondary">classroomId: {selectedLessonContext.lesson.classroomId}</Badge>
                  )}
                </div>

                {selectedLessonContext.progress && (
                  <div className="rounded-2xl bg-slate-50 p-4 dark:bg-slate-900">
                    <div className="mb-2 flex items-center justify-between text-xs text-slate-500">
                      <span>{classroomJobStepText(selectedLessonContext.progress.step)}</span>
                      <span>{selectedLessonContext.progress.progress}%</span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                      <div
                        className="h-full rounded-full bg-blue-500 transition-all"
                        style={{ width: `${selectedLessonContext.progress.progress}%` }}
                      />
                    </div>
                    {selectedLessonContext.progress.message && (
                      <div className="mt-2 text-xs text-slate-500">{selectedLessonContext.progress.message}</div>
                    )}
                  </div>
                )}

                <Input
                  value={selectedLessonInputValue}
                  onChange={(e) =>
                    setClassroomIdInputs((prev) => ({
                      ...prev,
                      [selectedLessonKey]: e.target.value,
                    }))
                  }
                  placeholder="手动绑定 classroomId（可选）"
                />

                <div className="grid gap-2 sm:grid-cols-2">
                  <Button
                    variant="outline"
                    onClick={() =>
                      onGenerateLessonContent(
                        selectedLessonContext.programItem.program.id,
                        selectedLessonContext.lesson.id,
                      )
                    }
                    disabled={selectedLessonIsGenerating}
                  >
                    {selectedLessonIsGenerating ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Sparkles className="size-4" />
                    )}
                    {selectedLessonContext.lesson.generationStatus === 'failed'
                      ? '重试生成'
                      : selectedLessonContext.lesson.generationStatus === 'succeeded'
                        ? '重新生成'
                        : 'AI 生成内容'}
                  </Button>
                  {selectedLessonContext.lesson.classroomId && (
                    <Button
                      variant="outline"
                      onClick={() =>
                        onGenerateLessonContent(
                          selectedLessonContext.programItem.program.id,
                          selectedLessonContext.lesson.id,
                          { forceRichMedia: true },
                        )
                      }
                      disabled={selectedLessonIsGenerating}
                    >
                      <Sparkles className="size-4" />
                      富媒体重生成
                    </Button>
                  )}
                  {selectedLessonContext.progress?.classroomJobId && (
                    <Button
                      variant="outline"
                      onClick={() => openGenerationProgress(selectedLessonContext.progress!.classroomJobId)}
                    >
                      <Workflow className="size-4" />
                      查看进度
                    </Button>
                  )}
                  {selectedLessonCanResume &&
                    selectedLessonContext.lesson.lastGenerationTaskId &&
                    selectedLessonContext.progress?.classroomJobId && (
                      <Button
                        variant="outline"
                        onClick={() =>
                          onResumeLessonGeneration(
                            selectedLessonContext.programItem.program.id,
                            selectedLessonContext.lesson.id,
                            selectedLessonContext.lesson.lastGenerationTaskId!,
                            selectedLessonContext.progress!.classroomJobId,
                          )
                        }
                        disabled={selectedLessonIsGenerating}
                      >
                        <RefreshCw className="size-4" />
                        断点续跑
                      </Button>
                    )}
                  <Button
                    variant="outline"
                    onClick={() =>
                      onBindLessonClassroom(
                        selectedLessonContext.programItem.program.id,
                        selectedLessonContext.lesson.id,
                        selectedLessonContext.lesson.classroomId,
                      )
                    }
                  >
                    保存绑定
                  </Button>
                  {(selectedLessonContext.lesson.previewUrl || selectedLessonContext.lesson.classroomId) && (
                    <Button asChild>
                      <a
                        href={
                          selectedLessonContext.lesson.previewUrl ||
                          `/classroom/${selectedLessonContext.lesson.classroomId}`
                        }
                        target="_blank"
                        rel="noreferrer"
                      >
                        <ExternalLink className="size-4" />
                        预览课堂
                      </a>
                    </Button>
                  )}
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(assignProgram)} onOpenChange={(open) => !open && setAssignProgramId(null)}>
        <DialogContent className="max-w-xl border-white/60 bg-white/95 backdrop-blur-xl dark:border-slate-800 dark:bg-slate-950/95">
          {assignProgram && (
            <>
              <DialogHeader>
                <DialogTitle>派发《{assignProgram.program.title}》</DialogTitle>
                <DialogDescription>选择学生后确认派发，学生端会看到待接收课程。</DialogDescription>
              </DialogHeader>
              <div className="grid max-h-[360px] gap-2 overflow-y-auto sm:grid-cols-2">
                {data.students.map((student) => (
                  <label
                    key={student.id}
                    className="flex items-center gap-2 rounded-2xl border border-slate-200/70 bg-slate-50/70 px-3 py-2 text-sm dark:border-slate-800 dark:bg-slate-900/50"
                  >
                    <input
                      type="checkbox"
                      checked={assignSelectedStudentIds.includes(student.id)}
                      onChange={() => toggleStudentSelection(assignProgram.program.id, student.id)}
                    />
                    <span>{student.username}</span>
                  </label>
                ))}
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setAssignProgramId(null)}>
                  取消
                </Button>
                <Button onClick={() => onAssignProgram(assignProgram.program.id)}>
                  <Send className="size-4" />
                  确认派发
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(selectedAssignment)} onOpenChange={(open) => !open && setSelectedAssignmentId(null)}>
        <DialogContent className="max-w-3xl border-white/60 bg-white/95 backdrop-blur-xl dark:border-slate-800 dark:bg-slate-950/95">
          {selectedAssignment && (
            <>
              <DialogHeader>
                <DialogTitle>
                  {selectedAssignment.assignment.studentUsername} · {selectedAssignment.program.title}
                </DialogTitle>
                <DialogDescription>
                  最近活跃 {formatDateTime(selectedAssignment.assignment.lastActivityAt)}
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-3 md:grid-cols-4">
                <div className="rounded-2xl bg-slate-50 p-3 dark:bg-slate-900">
                  <div className="text-xs text-slate-500">进度</div>
                  <div className="text-2xl font-semibold">{selectedAssignment.progressPercent}%</div>
                </div>
                <div className="rounded-2xl bg-slate-50 p-3 dark:bg-slate-900">
                  <div className="text-xs text-slate-500">学习</div>
                  <div className="text-2xl font-semibold">
                    {formatDuration(selectedAssignment.behaviorSummary.studySeconds)}
                  </div>
                </div>
                <div className="rounded-2xl bg-slate-50 p-3 dark:bg-slate-900">
                  <div className="text-xs text-slate-500">小测</div>
                  <div className="text-2xl font-semibold">
                    {selectedAssignment.behaviorSummary.quizAccuracy === null
                      ? 'N/A'
                      : `${selectedAssignment.behaviorSummary.quizAccuracy}%`}
                  </div>
                </div>
                <div className="rounded-2xl bg-slate-50 p-3 dark:bg-slate-900">
                  <div className="text-xs text-slate-500">卡点</div>
                  <div className="text-2xl font-semibold">{selectedAssignment.openStuckCount}</div>
                </div>
              </div>
              <div className="space-y-2">
                {selectedAssignment.chapterSummaries.map((chapter) => (
                  <div key={chapter.chapterId} className="rounded-2xl border border-slate-200/70 p-3 dark:border-slate-800">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-sm font-medium">{chapter.chapterTitle}</div>
                      <div className="text-xs text-slate-500">{chapter.progressPercent}%</div>
                    </div>
                    <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                      <div className="h-full rounded-full bg-blue-500" style={{ width: `${chapter.progressPercent}%` }} />
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-slate-500 md:grid-cols-4">
                      <span>学习 {formatDuration(chapter.studySeconds)}</span>
                      <span>停顿 {formatDuration(chapter.pauseSeconds)}</span>
                      <span>复看 {formatDuration(chapter.replaySeconds)}</span>
                      <span>提问 {chapter.aiQuestionTotal}</span>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} initialSection={settingsSection} />
    </div>
  );
}
