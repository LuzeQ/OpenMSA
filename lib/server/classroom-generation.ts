import { nanoid } from 'nanoid';
import { callLLM } from '@/lib/ai/llm';
import { createStageAPI } from '@/lib/api/stage-api';
import type { StageStore } from '@/lib/api/stage-api-types';
import {
  DEFAULT_LANGUAGE_DIRECTIVE,
  applyOutlineFallbacks,
  generateSceneOutlinesFromRequirements,
} from '@/lib/generation/outline-generator';
import {
  createSceneWithActions,
  generateSceneActions,
  generateSceneContent,
} from '@/lib/generation/scene-generator';
import type { AICallFn } from '@/lib/generation/pipeline-types';
import type { AgentInfo } from '@/lib/generation/pipeline-types';
import { formatTeacherPersonaForPrompt } from '@/lib/generation/prompt-formatters';
import { getDefaultAgents } from '@/lib/orchestration/registry/store';
import { createLogger } from '@/lib/logger';
import { isProviderKeyRequired } from '@/lib/ai/providers';
import { resolveWebSearchApiKey } from '@/lib/server/provider-config';
import { resolveModel } from '@/lib/server/resolve-model';
import { buildSearchQuery } from '@/lib/server/search-query-builder';
import { searchWithTavily, formatSearchResultsAsContext } from '@/lib/web-search/tavily';
import { persistClassroom } from '@/lib/server/classroom-storage';
import {
  generateMediaForClassroom,
  replaceMediaPlaceholders,
  generateTTSForClassroom,
  applyMediaFallbacksToScenes,
  type ClassroomMediaGenerationResult,
  type ClassroomMediaRuntimeConfig,
} from '@/lib/server/classroom-media-generation';
import type { Action } from '@/lib/types/action';
import type { GeneratedSlideContent, SceneOutline, UserRequirements } from '@/lib/types/generation';
import type { PPTImageElement, PPTTextElement, PPTVideoElement } from '@/lib/types/slides';
import type { Scene, Stage } from '@/lib/types/stage';
import { AGENT_COLOR_PALETTE, AGENT_DEFAULT_AVATARS } from '@/lib/constants/agent-defaults';

const log = createLogger('Classroom');

export interface GenerateClassroomInput {
  requirement: string;
  pdfContent?: { text: string; images: string[] };
  language?: string;
  modelString?: string;
  apiKey?: string;
  baseUrl?: string;
  providerType?: string;
  enableWebSearch?: boolean;
  enableImageGeneration?: boolean;
  enableVideoGeneration?: boolean;
  enableTTS?: boolean;
  agentMode?: 'default' | 'generate';
  mediaConfig?: ClassroomMediaRuntimeConfig;
  richnessPolicy?: {
    minImages?: number;
    minVideos?: number;
    minInteractive?: number;
    interactiveDepth?: 'light' | 'medium' | 'heavy';
  };
}

export type ClassroomGenerationStep =
  | 'initializing'
  | 'researching'
  | 'generating_outlines'
  | 'generating_scenes'
  | 'generating_media'
  | 'generating_tts'
  | 'persisting'
  | 'completed';

export interface ClassroomGenerationProgress {
  step: ClassroomGenerationStep;
  progress: number;
  message: string;
  scenesGenerated: number;
  totalScenes?: number;
}

export interface GenerateClassroomResult {
  id: string;
  url: string;
  stage: Stage;
  scenes: Scene[];
  scenesCount: number;
  createdAt: string;
}

export interface ClassroomGenerationCheckpointScene {
  index: number;
  scene: Scene;
}

export interface ClassroomGenerationCheckpoint {
  version: 1;
  stage: Stage;
  outlines: SceneOutline[];
  agents: AgentInfo[];
  agentMode: 'default' | 'generate';
  completedSceneIndexes: number[];
  scenesByIndex: ClassroomGenerationCheckpointScene[];
}

function createInMemoryStore(stage: Stage): StageStore {
  let state = {
    stage: stage as Stage | null,
    scenes: [] as Scene[],
    currentSceneId: null as string | null,
    mode: 'playback' as const,
  };

  const listeners: Array<(s: typeof state, prev: typeof state) => void> = [];

  return {
    getState: () => state,
    setState: (partial: Partial<typeof state>) => {
      const prev = state;
      state = { ...state, ...partial };
      listeners.forEach((fn) => fn(state, prev));
    },
    subscribe: (listener: (s: typeof state, prev: typeof state) => void) => {
      listeners.push(listener);
      return () => {
        const idx = listeners.indexOf(listener);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    },
  };
}

function normalizeLanguage(language?: string): 'zh-CN' | 'en-US' {
  return language === 'en-US' ? 'en-US' : 'zh-CN';
}

function resolveSceneGenerationConcurrency(totalScenes: number): number {
  const raw = Number(process.env.CLASSROOM_SCENE_CONCURRENCY || 2);
  const parsed = Number.isFinite(raw) ? Math.floor(raw) : 2;
  const bounded = Math.max(1, Math.min(6, parsed));
  return Math.min(bounded, Math.max(1, totalScenes));
}

function resolveClassroomMaxOutputTokens(modelOutputWindow?: number): number | undefined {
  const raw = Number(process.env.CLASSROOM_MAX_OUTPUT_TOKENS || 4096);
  const parsed = Number.isFinite(raw) ? Math.floor(raw) : 4096;
  const bounded = Math.max(512, Math.min(8192, parsed));
  if (typeof modelOutputWindow === 'number' && Number.isFinite(modelOutputWindow)) {
    return Math.min(modelOutputWindow, bounded);
  }
  return bounded;
}

interface NormalizedRichnessPolicy {
  minImages: number;
  minVideos: number;
  minInteractive: number;
  interactiveDepth: 'light' | 'medium' | 'heavy';
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function normalizeRichnessPolicy(
  policy: GenerateClassroomInput['richnessPolicy'],
  options: {
    enableImageGeneration?: boolean;
    enableVideoGeneration?: boolean;
  },
): NormalizedRichnessPolicy {
  const minInteractive = clampInteger(policy?.minInteractive ?? 1, 0, 3);
  return {
    minImages: options.enableImageGeneration ? clampInteger(policy?.minImages ?? 1, 0, 6) : 0,
    minVideos: options.enableVideoGeneration ? clampInteger(policy?.minVideos ?? 1, 0, 4) : 0,
    minInteractive,
    interactiveDepth:
      policy?.interactiveDepth === 'medium' || policy?.interactiveDepth === 'heavy'
        ? policy.interactiveDepth
        : 'light',
  };
}

function collectMediaElementIds(outlines: SceneOutline[]): Set<string> {
  const ids = new Set<string>();
  for (const outline of outlines) {
    for (const media of outline.mediaGenerations || []) {
      if (media.elementId) ids.add(media.elementId);
    }
  }
  return ids;
}

function nextMediaElementId(
  ids: Set<string>,
  kind: 'image' | 'video',
): string {
  while (true) {
    const id = `${kind === 'image' ? 'gen_img_' : 'gen_vid_'}${nanoid(8)}`;
    if (!ids.has(id)) {
      ids.add(id);
      return id;
    }
  }
}

function buildImagePrompt(outline: SceneOutline, language: 'zh-CN' | 'en-US'): string {
  const keyPoint = outline.keyPoints?.[0] || outline.description || outline.title;
  const labelLanguage = language === 'zh-CN' ? 'Chinese' : 'English';
  return `Educational infographic for "${outline.title}". Focus on "${keyPoint}". Clean classroom illustration, high contrast, 16:9 composition, all labels in ${labelLanguage}.`;
}

function buildVideoPrompt(outline: SceneOutline, language: 'zh-CN' | 'en-US'): string {
  const keyPoint = outline.keyPoints?.[0] || outline.description || outline.title;
  const narrationLanguage = language === 'zh-CN' ? 'Chinese' : 'English';
  return `Short educational explainer animation about "${outline.title}". Show "${keyPoint}" with step-by-step motion, clear visual progression, classroom-safe style, text labels in ${narrationLanguage}, 16:9.`;
}

function buildInteractiveConfig(
  outline: SceneOutline,
  policy: NormalizedRichnessPolicy,
  language: 'zh-CN' | 'en-US',
) {
  const depthHint =
    policy.interactiveDepth === 'medium'
      ? language === 'zh-CN'
        ? '包含状态变化与即时反馈，但保持课堂稳定性。'
        : 'Include state transitions and instant feedback while keeping classroom stability.'
      : policy.interactiveDepth === 'heavy'
        ? language === 'zh-CN'
          ? '强化交互流程与挑战机制，但避免游戏化失控。'
          : 'Use deeper interaction loops and challenge mechanics without turning it into a game.'
        : language === 'zh-CN'
          ? '采用轻交互：滑块、拖拽、点击切换与分步演示。'
          : 'Use light interactions: sliders, drag/drop, click toggles, and step-by-step demos.';
  return {
    conceptName: outline.title,
    conceptOverview: outline.description || outline.title,
    designIdea: `${depthHint} ${outline.keyPoints?.slice(0, 3).join('；') || ''}`.trim(),
    subject: language === 'zh-CN' ? '综合科学' : 'General STEM',
  };
}

function ensureInteractiveOutlines(
  outlines: SceneOutline[],
  language: 'zh-CN' | 'en-US',
  policy: NormalizedRichnessPolicy,
) {
  for (let index = 0; index < outlines.length; index += 1) {
    const outline = outlines[index];
    if (outline.type === 'interactive' && !outline.interactiveConfig) {
      outlines[index] = {
        ...outline,
        interactiveConfig: buildInteractiveConfig(outline, policy, language),
      };
    }
  }

  const currentInteractive = outlines.filter((o) => o.type === 'interactive').length;
  let missingInteractive = Math.max(0, policy.minInteractive - currentInteractive);
  if (missingInteractive === 0) return;

  const convertibleSlideIndexes = outlines
    .map((outline, index) => ({ outline, index }))
    .filter(({ outline }) => outline.type === 'slide');

  for (const { index } of convertibleSlideIndexes) {
    if (missingInteractive <= 0) break;
    const source = outlines[index];
    outlines[index] = {
      ...source,
      type: 'interactive',
      interactiveConfig: buildInteractiveConfig(source, policy, language),
      quizConfig: undefined,
      pblConfig: undefined,
      mediaGenerations: undefined,
      suggestedImageIds: undefined,
    };
    missingInteractive -= 1;
  }

  while (missingInteractive > 0) {
    const title = language === 'zh-CN' ? `互动探索 ${missingInteractive}` : `Interactive Exploration ${missingInteractive}`;
    const description =
      language === 'zh-CN'
        ? '通过轻交互模拟理解核心概念并即时验证理解。'
        : 'Use a lightweight simulation to explore and validate the core concept.';
    const fallbackOutline: SceneOutline = {
      id: `outline_${nanoid(8)}`,
      type: 'interactive',
      title,
      description,
      keyPoints:
        language === 'zh-CN'
          ? ['调整参数观察变化', '拖拽操作验证规律', '完成快速自检']
          : ['Tune parameters and observe changes', 'Validate rules with drag interactions', 'Complete a quick checkpoint'],
      order: outlines.length + 1,
      language,
      interactiveConfig: {
        conceptName: title,
        conceptOverview: description,
        designIdea:
          language === 'zh-CN'
            ? '提供滑块、拖拽、步骤提示和结果反馈，不做重型游戏化。'
            : 'Provide sliders, drag/drop, guided steps, and feedback without heavy gamification.',
        subject: language === 'zh-CN' ? '综合科学' : 'General STEM',
      },
    };
    outlines.push(fallbackOutline);
    missingInteractive -= 1;
  }
}

function ensureMediaRequests(
  outlines: SceneOutline[],
  language: 'zh-CN' | 'en-US',
  policy: NormalizedRichnessPolicy,
) {
  const existingIds = collectMediaElementIds(outlines);
  const counts = {
    image: outlines.reduce(
      (sum, outline) => sum + (outline.mediaGenerations || []).filter((m) => m.type === 'image').length,
      0,
    ),
    video: outlines.reduce(
      (sum, outline) => sum + (outline.mediaGenerations || []).filter((m) => m.type === 'video').length,
      0,
    ),
  };

  const addRequests = (kind: 'image' | 'video', targetCount: number) => {
    const missing = Math.max(0, targetCount - counts[kind]);
    if (missing <= 0) return;

    const candidateSlideIndexes = outlines
      .map((outline, index) => ({ outline, index }))
      .filter(({ outline }) => outline.type === 'slide')
      .map(({ index }) => index);

    const availableTargets = candidateSlideIndexes.filter((index) => {
      const media = outlines[index].mediaGenerations || [];
      return !media.some((item) => item.type === kind);
    });

    while (availableTargets.length < missing) {
      const autoSlide: SceneOutline = {
        id: `outline_${nanoid(8)}`,
        type: 'slide',
        title:
          kind === 'image'
            ? language === 'zh-CN'
              ? `图像讲解补充 ${availableTargets.length + 1}`
              : `Visual supplement ${availableTargets.length + 1}`
            : language === 'zh-CN'
              ? `视频讲解补充 ${availableTargets.length + 1}`
              : `Video supplement ${availableTargets.length + 1}`,
        description:
          language === 'zh-CN'
            ? '用于补充关键知识点的可视化讲解页面。'
            : 'A visual reinforcement slide for core lesson concepts.',
        keyPoints:
          language === 'zh-CN'
            ? ['提炼核心概念', '强化过程理解', '连接应用场景']
            : ['Highlight core concept', 'Reinforce process understanding', 'Connect to application context'],
        order: outlines.length + 1,
        language,
      };
      outlines.push(autoSlide);
      availableTargets.push(outlines.length - 1);
    }

    for (let i = 0; i < missing; i += 1) {
      const targetIndex = availableTargets[i];
      const outline = outlines[targetIndex];
      const elementId = nextMediaElementId(existingIds, kind);
      const request = {
        type: kind,
        elementId,
        aspectRatio: '16:9' as const,
        prompt:
          kind === 'image' ? buildImagePrompt(outline, language) : buildVideoPrompt(outline, language),
      };
      outline.mediaGenerations = [...(outline.mediaGenerations || []), request];
      counts[kind] += 1;
    }
  };

  addRequests('image', policy.minImages);
  addRequests('video', policy.minVideos);
}

function applyRichnessPolicyToOutlines(
  outlines: SceneOutline[],
  language: 'zh-CN' | 'en-US',
  policy: NormalizedRichnessPolicy,
): SceneOutline[] {
  const nextOutlines = outlines.map((outline) => ({ ...outline }));
  ensureInteractiveOutlines(nextOutlines, language, policy);
  ensureMediaRequests(nextOutlines, language, policy);
  return nextOutlines.map((outline, index) => ({ ...outline, order: index + 1 }));
}

function buildRichnessPrompt(policy: NormalizedRichnessPolicy, language: 'zh-CN' | 'en-US'): string {
  if (language === 'zh-CN') {
    return [
      'Rich Media Policy:',
      `- 至少 ${policy.minInteractive} 个 interactive 场景（轻交互优先）`,
      `- 至少 ${policy.minImages} 张 AI 图片（如图片开关启用）`,
      `- 至少 ${policy.minVideos} 段 AI 视频（如视频开关启用）`,
      '- interactive 仅使用滑块/拖拽/点击切换/步骤演示，不做重型游戏化',
    ].join('\n');
  }
  return [
    'Rich Media Policy:',
    `- At least ${policy.minInteractive} interactive scene(s) (light interactions preferred)`,
    `- At least ${policy.minImages} AI-generated image(s) when image generation is enabled`,
    `- At least ${policy.minVideos} AI-generated video(s) when video generation is enabled`,
    '- Interactive scenes should use sliders, drag/drop, click toggles, or step demos (no heavy gamification)',
  ].join('\n');
}

function ensureSceneMediaPlaceholders(scenes: Scene[], outlines: SceneOutline[]) {
  const outlineByOrder = new Map<number, SceneOutline>();
  for (const outline of outlines) {
    outlineByOrder.set(outline.order, outline);
  }

  for (const scene of scenes) {
    if (scene.type !== 'slide') continue;
    const outline = outlineByOrder.get(scene.order);
    if (!outline?.mediaGenerations?.length) continue;
    const elements = (scene.content as { canvas?: { elements?: Array<PPTImageElement | PPTVideoElement | PPTTextElement> } }).canvas
      ?.elements;
    if (!Array.isArray(elements)) continue;

    let inserted = 0;
    for (const media of outline.mediaGenerations) {
      const exists = elements.some(
        (element) => 'src' in element && typeof element.src === 'string' && element.src === media.elementId,
      );
      if (exists) continue;

      const slot = inserted % 2;
      const row = Math.floor(inserted / 2);
      const top = 300 + row * 120;

      if (media.type === 'image') {
        const imageElement: PPTImageElement = {
          id: `media_img_${nanoid(8)}`,
          type: 'image',
          left: slot === 0 ? 540 : 760,
          top,
          width: slot === 0 ? 200 : 200,
          height: 112,
          rotate: 0,
          fixedRatio: true,
          src: media.elementId,
        };
        elements.push(imageElement);
      } else {
        const videoElement: PPTVideoElement = {
          id: `media_vid_${nanoid(8)}`,
          type: 'video',
          left: slot === 0 ? 520 : 740,
          top: top - 12,
          width: 220,
          height: 124,
          rotate: 0,
          src: media.elementId,
          autoplay: false,
          ext: 'mp4',
        };
        elements.push(videoElement);
      }
      inserted += 1;
    }
  }
}

function splitRequirementIntoPoints(requirement: string, maxPoints = 5): string[] {
  return requirement
    .split(/[\n。！？!?；;]+/g)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, maxPoints);
}

function buildHeuristicFallbackOutlines(requirement: string, language: 'zh-CN' | 'en-US'): SceneOutline[] {
  const points = splitRequirementIntoPoints(requirement, 8);
  const corePoints = points.length > 0 ? points : ['梳理核心概念', '建立知识连接', '完成基础练习'];

  const templates =
    language === 'en-US'
      ? [
          ['Learning Goals', 'Clarify what to learn and why it matters.'],
          ['Core Concepts', 'Introduce key definitions and their relationships.'],
          ['Principles and Rules', 'Explain main rules with concise reasoning.'],
          ['Worked Examples', 'Use examples to connect concepts and practice.'],
          ['Common Mistakes', 'Highlight pitfalls and how to avoid them.'],
        ]
      : [
          ['学习目标与路径', '明确本节要解决的问题与学习路线。'],
          ['核心概念梳理', '建立关键概念之间的联系。'],
          ['关键规律与原理', '提炼重要规律并解释使用条件。'],
          ['典型例题讲解', '通过例题把概念落到具体解题步骤。'],
          ['常见误区与纠偏', '总结易错点并给出纠偏方法。'],
        ];

  const sceneOutlines: SceneOutline[] = templates.map(([title, description], index) => ({
    id: `fallback-outline-${nanoid(8)}`,
    type: 'slide',
    title,
    description,
    keyPoints: corePoints.slice(Math.max(0, index - 1), Math.max(0, index - 1) + 3),
    order: index,
    language,
  }));

  sceneOutlines.push({
    id: `fallback-outline-${nanoid(8)}`,
    type: 'quiz',
    title: language === 'en-US' ? 'Checkpoint Quiz' : '检查点小测',
    description:
      language === 'en-US'
        ? 'Quick check to confirm understanding of the key ideas.'
        : '快速检测关键知识点掌握情况。',
    keyPoints: corePoints.slice(0, 4),
    order: sceneOutlines.length,
    language,
    quizConfig: {
      questionCount: 3,
      difficulty: 'medium',
      questionTypes: ['single'],
    },
  });

  return sceneOutlines;
}

function buildFallbackSlideContent(outline: SceneOutline): GeneratedSlideContent {
  const title: PPTTextElement = {
    id: `el_${nanoid(8)}`,
    type: 'text',
    left: 48,
    top: 48,
    width: 900,
    height: 80,
    rotate: 0,
    content: `<p><strong>${outline.title}</strong></p>`,
    defaultFontName: 'Microsoft YaHei',
    defaultColor: '#111827',
    textType: 'title',
  };

  const body = (outline.keyPoints || [])
    .filter(Boolean)
    .slice(0, 5)
    .map((point) => `<p>• ${point}</p>`)
    .join('');
  const description = outline.description?.trim() || '本页由系统自动降级生成，可继续学习主线内容。';
  const bodyContent = body || `<p>${description}</p>`;

  const content: PPTTextElement = {
    id: `el_${nanoid(8)}`,
    type: 'text',
    left: 64,
    top: 160,
    width: 860,
    height: 360,
    rotate: 0,
    content: bodyContent,
    defaultFontName: 'Microsoft YaHei',
    defaultColor: '#374151',
    textType: 'content',
  };

  return { elements: [title, content] };
}

function createFallbackScene(
  outline: SceneOutline,
  api: ReturnType<typeof createStageAPI>,
  reason: string,
): string | null {
  const fallbackOutline: SceneOutline = {
    ...outline,
    id: `${outline.id}-fallback`,
    type: 'slide',
  };
  const fallbackActions: Action[] = [
    {
      id: `action_${nanoid(8)}`,
      type: 'speech',
      title: '自动降级说明',
      text: `该场景生成遇到网络/模型异常，已自动降级为稳态内容。主题：${outline.title}`,
    },
  ];
  const sceneId = createSceneWithActions(
    fallbackOutline,
    buildFallbackSlideContent(fallbackOutline),
    fallbackActions,
    api,
  );
  if (!sceneId) {
    log.warn(`Fallback scene creation failed for "${outline.title}" [reason=${reason}]`);
  }
  return sceneId;
}

function buildFallbackInteractiveHtml(outline: SceneOutline): string {
  const language = outline.language === 'en-US' ? 'en-US' : 'zh-CN';
  const title = outline.title || (language === 'zh-CN' ? '互动探索' : 'Interactive Exploration');
  const intro =
    language === 'zh-CN'
      ? '当前为稳定回退交互页，可通过滑块观察变量变化。'
      : 'This is a resilient fallback interactive page. Use the slider to observe variable changes.';
  const metricLabel = language === 'zh-CN' ? '理解度指数' : 'Understanding Index';
  const sliderLabel = language === 'zh-CN' ? '调节参数' : 'Adjust parameter';
  const stepHint =
    language === 'zh-CN'
      ? '建议步骤：1) 调整参数 2) 观察变化 3) 总结规律'
      : 'Suggested steps: 1) Adjust parameter 2) Observe change 3) Summarize the pattern';

  return `<!DOCTYPE html>
<html lang="${language}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="min-h-screen bg-slate-50 text-slate-900">
  <main class="max-w-3xl mx-auto px-6 py-8 space-y-6">
    <section class="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h1 class="text-2xl font-semibold">${title}</h1>
      <p class="mt-2 text-sm text-slate-600">${intro}</p>
      <p class="mt-1 text-xs text-slate-500">${stepHint}</p>
    </section>
    <section class="rounded-xl border border-slate-200 bg-white p-5 space-y-4 shadow-sm">
      <label class="block text-sm font-medium">${sliderLabel}: <span id="value">50</span></label>
      <input id="slider" type="range" min="0" max="100" value="50" class="w-full" />
      <div class="h-3 rounded-full bg-slate-200 overflow-hidden">
        <div id="bar" class="h-full bg-blue-500 transition-all duration-200" style="width:50%"></div>
      </div>
      <div class="text-sm text-slate-700">${metricLabel}: <strong id="metric">50</strong></div>
    </section>
  </main>
  <script>
    const slider = document.getElementById('slider');
    const value = document.getElementById('value');
    const metric = document.getElementById('metric');
    const bar = document.getElementById('bar');
    slider.addEventListener('input', (event) => {
      const v = Number(event.target.value || 0);
      value.textContent = String(v);
      metric.textContent = String(v);
      bar.style.width = v + '%';
    });
  </script>
</body>
</html>`;
}

function createFallbackInteractiveScene(
  outline: SceneOutline,
  api: ReturnType<typeof createStageAPI>,
  reason: string,
): string | null {
  const fallbackOutline: SceneOutline = {
    ...outline,
    id: `${outline.id}-interactive-fallback`,
    type: 'interactive',
    interactiveConfig:
      outline.interactiveConfig || {
        conceptName: outline.title,
        conceptOverview: outline.description || outline.title,
        designIdea:
          outline.language === 'en-US'
            ? 'Fallback slider-based interaction with immediate visual feedback.'
            : '回退到滑块交互，提供即时可视化反馈。',
        subject: outline.language === 'en-US' ? 'General STEM' : '综合科学',
      },
  };

  const fallbackActions: Action[] = [
    {
      id: `action_${nanoid(8)}`,
      type: 'speech',
      title: fallbackOutline.language === 'en-US' ? 'Fallback Notice' : '回退说明',
      text:
        fallbackOutline.language === 'en-US'
          ? `Interactive generation degraded due upstream instability. A stable fallback interaction is loaded for: ${fallbackOutline.title}.`
          : `该互动场景遇到上游波动，已切换为稳定回退交互。主题：${fallbackOutline.title}`,
    },
  ];

  const sceneId = createSceneWithActions(
    fallbackOutline,
    {
      html: buildFallbackInteractiveHtml(fallbackOutline),
    },
    fallbackActions,
    api,
  );
  if (!sceneId) {
    log.warn(`Fallback interactive scene creation failed for "${outline.title}" [reason=${reason}]`);
  }
  return sceneId;
}

function buildCheckpointSnapshot(
  stage: Stage,
  outlines: SceneOutline[],
  agents: AgentInfo[],
  agentMode: 'default' | 'generate',
  sceneMap: Map<number, Scene>,
  completedIndexes: Set<number>,
): ClassroomGenerationCheckpoint {
  return {
    version: 1,
    stage,
    outlines,
    agents,
    agentMode,
    completedSceneIndexes: [...completedIndexes].sort((a, b) => a - b),
    scenesByIndex: [...sceneMap.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, scene]) => ({ index, scene })),
  };
}

function stripCodeFences(text: string): string {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  return cleaned.trim();
}

async function generateAgentProfiles(
  requirement: string,
  language: string,
  aiCall: AICallFn,
): Promise<AgentInfo[]> {
  const systemPrompt =
    'You are an expert instructional designer. Generate agent profiles for a multi-agent classroom simulation. Return ONLY valid JSON, no markdown or explanation.';

  const userPrompt = `Generate agent profiles for a course with this requirement:
${requirement}

Requirements:
- Decide the appropriate number of agents based on the course content (typically 3-5)
- Exactly 1 agent must have role "teacher", the rest can be "assistant" or "student"
- Each agent needs: name, role, persona (2-3 sentences describing personality and teaching/learning style)
- Names and personas must be in language: ${language}

Return a JSON object with this exact structure:
{
  "agents": [
    {
      "name": "string",
      "role": "teacher" | "assistant" | "student",
      "persona": "string (2-3 sentences)"
    }
  ]
}`;

  const response = await aiCall(systemPrompt, userPrompt);
  const rawText = stripCodeFences(response);
  const parsed = JSON.parse(rawText) as {
    agents: Array<{ name: string; role: string; persona: string }>;
  };

  if (!parsed.agents || !Array.isArray(parsed.agents) || parsed.agents.length < 2) {
    throw new Error(`Expected at least 2 agents, got ${parsed.agents?.length ?? 0}`);
  }

  const teacherCount = parsed.agents.filter((a) => a.role === 'teacher').length;
  if (teacherCount !== 1) {
    throw new Error(`Expected exactly 1 teacher, got ${teacherCount}`);
  }

  return parsed.agents.map((a, i) => ({
    id: `gen-server-${i}`,
    name: a.name,
    role: a.role,
    persona: a.persona,
  }));
}

export async function generateClassroom(
  input: GenerateClassroomInput,
  options: {
    baseUrl: string;
    onProgress?: (progress: ClassroomGenerationProgress) => Promise<void> | void;
    onCheckpoint?: (checkpoint: ClassroomGenerationCheckpoint) => Promise<void> | void;
    resumeCheckpoint?: ClassroomGenerationCheckpoint;
  },
): Promise<GenerateClassroomResult> {
  const { requirement, pdfContent } = input;

  const reportProgress = async (progress: ClassroomGenerationProgress) => {
    if (!options.onProgress) return;
    try {
      await options.onProgress(progress);
    } catch (error) {
      log.warn('Failed to report classroom generation progress, continuing:', error);
    }
  };

  const reportCheckpoint = async (checkpoint: ClassroomGenerationCheckpoint) => {
    if (!options.onCheckpoint) return;
    try {
      await options.onCheckpoint(checkpoint);
    } catch (error) {
      log.warn('Failed to persist classroom generation checkpoint, continuing:', error);
    }
  };

  await reportProgress({
    step: 'initializing',
    progress: 5,
    message: 'Initializing classroom generation',
    scenesGenerated: 0,
  });

  const {
    model: languageModel,
    modelInfo,
    modelString,
    providerId,
    apiKey,
  } = await resolveModel({
    modelString: input.modelString,
    apiKey: input.apiKey,
    baseUrl: input.baseUrl,
    providerType: input.providerType,
  });
  log.info(
    `Using model for classroom generation [model=${modelString}, provider=${providerId}, hasInputModel=${Boolean(input.modelString)}]`,
  );

  // Fail fast if the resolved provider has no API key configured
  if (isProviderKeyRequired(providerId) && !apiKey) {
    throw new Error(
      `No API key configured for provider "${providerId}". ` +
        `Set the appropriate key in .env.local or server-providers.yml (e.g. ${providerId.toUpperCase()}_API_KEY).`,
    );
  }

  const maxOutputTokens = resolveClassroomMaxOutputTokens(modelInfo?.outputWindow);
  const aiCall: AICallFn = async (systemPrompt, userPrompt, _images) => {
    const result = await callLLM(
      {
        model: languageModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        maxOutputTokens,
      },
      'generate-classroom',
    );
    return result.text;
  };

  const searchQueryAiCall: AICallFn = async (systemPrompt, userPrompt, _images) => {
    const result = await callLLM(
      {
        model: languageModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        maxOutputTokens: 256,
      },
      'web-search-query-rewrite',
    );
    return result.text;
  };

  const lang = normalizeLanguage(input.language);
  const fallbackLanguageDirective =
    lang === 'en-US'
      ? 'Teach in English. Keep terminology and examples consistent with English instruction.'
      : DEFAULT_LANGUAGE_DIRECTIVE;
  const richnessPolicy = normalizeRichnessPolicy(input.richnessPolicy, {
    enableImageGeneration: input.enableImageGeneration,
    enableVideoGeneration: input.enableVideoGeneration,
  });
  const requirements: UserRequirements = {
    requirement,
    language: lang,
  };
  const pdfText = pdfContent?.text || undefined;

  const resumeCheckpoint =
    options.resumeCheckpoint &&
    options.resumeCheckpoint.version === 1 &&
    options.resumeCheckpoint.stage &&
    Array.isArray(options.resumeCheckpoint.outlines) &&
    options.resumeCheckpoint.outlines.length > 0
      ? options.resumeCheckpoint
      : undefined;

  // Resolve agents based on agentMode (or checkpoint)
  let agents: AgentInfo[];
  let agentMode: 'default' | 'generate' = input.agentMode || 'default';
  let stage: Stage;
  let stageId: string;
  let outlines: SceneOutline[];
  let languageDirective = fallbackLanguageDirective;

  if (resumeCheckpoint) {
    agents = Array.isArray(resumeCheckpoint.agents) && resumeCheckpoint.agents.length > 0
      ? resumeCheckpoint.agents
      : getDefaultAgents();
    agentMode = resumeCheckpoint.agentMode === 'generate' ? 'generate' : 'default';
    stage = resumeCheckpoint.stage;
    stageId = stage.id;
    outlines = resumeCheckpoint.outlines;
    languageDirective = stage.languageDirective || fallbackLanguageDirective;
    log.info(
      `Resuming classroom generation from checkpoint [stageId=${stageId}, scenesDone=${resumeCheckpoint.completedSceneIndexes.length}/${outlines.length}]`,
    );
    await reportProgress({
      step: 'generating_outlines',
      progress: 30,
      message: `Resumed from checkpoint (${resumeCheckpoint.completedSceneIndexes.length}/${outlines.length})`,
      scenesGenerated: resumeCheckpoint.completedSceneIndexes.length,
      totalScenes: outlines.length,
    });
  } else {
    if (agentMode === 'generate') {
      log.info('Generating custom agent profiles via LLM...');
      try {
        agents = await generateAgentProfiles(requirement, lang, aiCall);
        log.info(`Generated ${agents.length} agent profiles`);
      } catch (e) {
        log.warn('Agent profile generation failed, falling back to defaults:', e);
        agents = getDefaultAgents();
        agentMode = 'default';
      }
    } else {
      agents = getDefaultAgents();
    }

    const teacherContext = [
      formatTeacherPersonaForPrompt(agents),
      buildRichnessPrompt(richnessPolicy, lang),
    ]
      .filter(Boolean)
      .join('\n\n');

    await reportProgress({
      step: 'researching',
      progress: 10,
      message: 'Researching topic',
      scenesGenerated: 0,
    });

    // Web search (optional, graceful degradation)
    let researchContext: string | undefined;
    if (input.enableWebSearch) {
      const tavilyKey = resolveWebSearchApiKey();
      if (tavilyKey) {
        try {
          const searchQuery = await buildSearchQuery(requirement, pdfText, searchQueryAiCall);

          log.info('Running web search for classroom generation', {
            hasPdfContext: searchQuery.hasPdfContext,
            rawRequirementLength: searchQuery.rawRequirementLength,
            rewriteAttempted: searchQuery.rewriteAttempted,
            finalQueryLength: searchQuery.finalQueryLength,
          });

          const searchResult = await searchWithTavily({
            query: searchQuery.query,
            apiKey: tavilyKey,
          });
          researchContext = formatSearchResultsAsContext(searchResult);
          if (researchContext) {
            log.info(`Web search returned ${searchResult.sources.length} sources`);
          }
        } catch (e) {
          log.warn('Web search failed, continuing without search context:', e);
        }
      } else {
        log.warn('enableWebSearch is true but no Tavily API key configured, skipping web search');
      }
    }
    await reportProgress({
      step: 'generating_outlines',
      progress: 15,
      message: 'Generating scene outlines',
      scenesGenerated: 0,
    });

    const outlinesResult = await generateSceneOutlinesFromRequirements(
      requirements,
      pdfText,
      undefined,
      aiCall,
      undefined,
      {
        imageGenerationEnabled: input.enableImageGeneration,
        videoGenerationEnabled: input.enableVideoGeneration,
        researchContext,
        teacherContext,
      },
    );

    if (!outlinesResult.success || !outlinesResult.data || outlinesResult.data.outlines.length === 0) {
      log.error('Failed to generate outlines, switching to heuristic fallback:', outlinesResult.error);
      outlines = buildHeuristicFallbackOutlines(requirement, lang);
    } else {
      languageDirective = outlinesResult.data.languageDirective || fallbackLanguageDirective;
      outlines = outlinesResult.data.outlines;
      log.info(
        `Generated ${outlines.length} scene outlines (languageDirective: ${languageDirective})`,
      );
    }

    outlines = applyRichnessPolicyToOutlines(outlines, lang, richnessPolicy);
    log.info(
      `Applied richness policy [minImages=${richnessPolicy.minImages}, minVideos=${richnessPolicy.minVideos}, minInteractive=${richnessPolicy.minInteractive}] -> outlines=${outlines.length}`,
    );

    await reportProgress({
      step: 'generating_outlines',
      progress: 30,
      message: `Generated ${outlines.length} scene outlines`,
      scenesGenerated: 0,
      totalScenes: outlines.length,
    });

    stageId = nanoid(10);
    stage = {
      id: stageId,
      name: outlines[0]?.title || requirement.slice(0, 50),
      description: undefined,
      languageDirective,
      style: 'interactive',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      // For LLM-generated agents, embed full configs so the client can
      // hydrate the agent registry without prior IndexedDB data.
      // For default agents, just record IDs — the client already has them.
      ...(agentMode === 'generate'
        ? {
            generatedAgentConfigs: agents.map((a, i) => ({
              id: a.id,
              name: a.name,
              role: a.role,
              persona: a.persona || '',
              avatar: AGENT_DEFAULT_AVATARS[i % AGENT_DEFAULT_AVATARS.length],
              color: AGENT_COLOR_PALETTE[i % AGENT_COLOR_PALETTE.length],
              priority: a.role === 'teacher' ? 10 : a.role === 'assistant' ? 7 : 5,
            })),
          }
        : {
            agentIds: agents.map((a) => a.id),
          }),
    };
  }

  if (!stage.languageDirective) {
    stage = {
      ...stage,
      languageDirective,
    };
  }

  const store = createInMemoryStore(stage);
  const api = createStageAPI(store);

  const sceneMap = new Map<number, Scene>();
  const completedSceneIndexes = new Set<number>();
  if (resumeCheckpoint) {
    for (const item of resumeCheckpoint.scenesByIndex || []) {
      if (!item || typeof item.index !== 'number' || !item.scene) continue;
      sceneMap.set(item.index, item.scene);
      completedSceneIndexes.add(item.index);
    }
    for (const index of resumeCheckpoint.completedSceneIndexes || []) {
      if (typeof index === 'number') completedSceneIndexes.add(index);
    }

    const restoredScenes = [...sceneMap.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, scene]) => scene);
    if (restoredScenes.length > 0) {
      store.setState({
        scenes: restoredScenes,
        currentSceneId: restoredScenes[0]?.id || null,
      });
    }
  }

  let generatedScenes = completedSceneIndexes.size;
  let processedScenes = completedSceneIndexes.size;
  const pendingSceneIndices = outlines
    .map((_, index) => index)
    .filter((index) => !completedSceneIndexes.has(index));
  const sceneConcurrency = resolveSceneGenerationConcurrency(pendingSceneIndices.length || outlines.length);

  const persistCheckpoint = async () => {
    await reportCheckpoint(
      buildCheckpointSnapshot(stage, outlines, agents, agentMode, sceneMap, completedSceneIndexes),
    );
  };

  await persistCheckpoint();

  log.info(
    `Stage 2: Generating scene content and actions [total=${outlines.length}, pending=${pendingSceneIndices.length}, concurrency=${sceneConcurrency}]`,
  );
  await reportProgress({
    step: 'generating_scenes',
    progress: 31,
    message:
      pendingSceneIndices.length === outlines.length
        ? `Generating ${outlines.length} scenes (parallel x${sceneConcurrency})`
        : `Resuming scenes ${generatedScenes}/${outlines.length} completed`,
    scenesGenerated: generatedScenes,
    totalScenes: outlines.length,
  });

  const registerScene = async (index: number, sceneId: string | null): Promise<boolean> => {
    if (!sceneId) return false;
    const createdScene = store.getState().scenes.find((candidate) => candidate.id === sceneId);
    if (!createdScene) return false;

    sceneMap.set(index, createdScene);
    completedSceneIndexes.add(index);
    generatedScenes = completedSceneIndexes.size;

    const orderedScenes = [...sceneMap.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, scene]) => scene);
    store.setState({
      scenes: orderedScenes,
      currentSceneId: orderedScenes[0]?.id || null,
    });

    await persistCheckpoint();
    return true;
  };

  const processSingleScene = async (index: number) => {
    const safeOutline = applyOutlineFallbacks(outlines[index], Boolean(languageModel));

    try {
      const content = await generateSceneContent(safeOutline, aiCall, {
        languageModel: safeOutline.type === 'pbl' ? languageModel : undefined,
        agents,
        languageDirective,
      });
      if (!content) {
        if (safeOutline.type === 'pbl') {
          log.warn(
            `PBL scene "${safeOutline.title}" generated no content [pbl_fallback_reason=pbl_generation_failed]`,
          );
        }
        const fallbackSceneId =
          safeOutline.type === 'interactive'
            ? createFallbackInteractiveScene(safeOutline, api, 'empty-content')
            : createFallbackScene(safeOutline, api, 'empty-content');
        await registerScene(index, fallbackSceneId);
        return;
      }

      const actions = await generateSceneActions(safeOutline, content, aiCall, {
        agents,
        languageDirective,
      });
      log.info(`Scene "${safeOutline.title}": ${actions.length} actions`);

      const sceneId = createSceneWithActions(safeOutline, content, actions, api);
      if (!sceneId) {
        const fallbackSceneId =
          safeOutline.type === 'interactive'
            ? createFallbackInteractiveScene(safeOutline, api, 'scene-create-failed')
            : createFallbackScene(safeOutline, api, 'scene-create-failed');
        await registerScene(index, fallbackSceneId);
        return;
      }

      await registerScene(index, sceneId);
    } catch (err) {
      log.warn(`Scene "${safeOutline.title}" generation failed, using fallback:`, err);
      const fallbackReason = err instanceof Error ? err.message : 'scene-generation-exception';
      if (safeOutline.type === 'pbl') {
        log.warn(
          `PBL scene "${safeOutline.title}" failed [pbl_fallback_reason=pbl_generation_failed, detail=${fallbackReason}]`,
        );
      }
      const fallbackSceneId =
        safeOutline.type === 'interactive'
          ? createFallbackInteractiveScene(safeOutline, api, fallbackReason)
          : createFallbackScene(safeOutline, api, fallbackReason);
      await registerScene(index, fallbackSceneId);
    } finally {
      processedScenes += 1;
      const progressNow = 30 + Math.floor((processedScenes / Math.max(outlines.length, 1)) * 60);
      await reportProgress({
        step: 'generating_scenes',
        progress: Math.min(progressNow, 90),
        message: `Generated ${generatedScenes}/${outlines.length} scenes (processed ${processedScenes}/${outlines.length})`,
        scenesGenerated: generatedScenes,
        totalScenes: outlines.length,
      });
    }
  };

  let pendingCursor = 0;
  const sceneWorkers = Array.from({ length: Math.max(1, sceneConcurrency) }, async () => {
    while (true) {
      const cursor = pendingCursor;
      pendingCursor += 1;
      const index = pendingSceneIndices[cursor];
      if (index === undefined) {
        return;
      }
      await processSingleScene(index);
    }
  });
  await Promise.all(sceneWorkers);

  const scenes = store.getState().scenes;
  log.info(`Pipeline complete: ${scenes.length} scenes generated`);

  if (scenes.length === 0) {
    throw new Error('No scenes were generated');
  }

  // Phase: Media generation (after all scenes generated)
  if (input.enableImageGeneration || input.enableVideoGeneration) {
    ensureSceneMediaPlaceholders(scenes, outlines);
    await reportProgress({
      step: 'generating_media',
      progress: 90,
      message: 'Generating media files',
      scenesGenerated: scenes.length,
      totalScenes: outlines.length,
    });

    try {
      const mediaResult: ClassroomMediaGenerationResult = await generateMediaForClassroom(
        outlines,
        stageId,
        options.baseUrl,
        {
          language: lang,
          mediaConfig: input.mediaConfig,
        },
      );
      replaceMediaPlaceholders(scenes, mediaResult.mediaMap);
      applyMediaFallbacksToScenes(scenes, mediaResult, lang);
      log.info(
        `Media generation complete: ${Object.keys(mediaResult.mediaMap).length} files, videoFallbacks=${mediaResult.videoFallbacks.length}`,
      );
    } catch (err) {
      log.warn('Media generation phase failed, continuing:', err);
    }
  }

  // Phase: TTS generation
  if (input.enableTTS) {
    await reportProgress({
      step: 'generating_tts',
      progress: 94,
      message: 'Generating TTS audio',
      scenesGenerated: scenes.length,
      totalScenes: outlines.length,
    });

    try {
      await generateTTSForClassroom(scenes, stageId, options.baseUrl);
      log.info('TTS generation complete');
    } catch (err) {
      log.warn('TTS generation phase failed, continuing:', err);
    }
  }

  await reportProgress({
    step: 'persisting',
    progress: 98,
    message: 'Persisting classroom data',
    scenesGenerated: scenes.length,
    totalScenes: outlines.length,
  });

  const persisted = await persistClassroom(
    {
      id: stageId,
      stage,
      scenes,
    },
    options.baseUrl,
  );

  log.info(`Classroom persisted: ${persisted.id}, URL: ${persisted.url}`);

  await reportProgress({
    step: 'completed',
    progress: 100,
    message: 'Classroom generation completed',
    scenesGenerated: scenes.length,
    totalScenes: outlines.length,
  });

  return {
    id: persisted.id,
    url: persisted.url,
    stage,
    scenes,
    scenesCount: scenes.length,
    createdAt: persisted.createdAt,
  };
}
