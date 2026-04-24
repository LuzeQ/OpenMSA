/**
 * Server-side media and TTS generation for classrooms.
 *
 * Generates image/video files and TTS audio for a classroom,
 * writes them to disk, and returns serving URL mappings.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { nanoid } from 'nanoid';
import { createLogger } from '@/lib/logger';
import { CLASSROOMS_DIR } from '@/lib/server/classroom-storage';
import { generateImage } from '@/lib/media/image-providers';
import { generateVideo, normalizeVideoOptions } from '@/lib/media/video-providers';
import { generateTTS } from '@/lib/audio/tts-providers';
import { DEFAULT_TTS_VOICES, DEFAULT_TTS_MODELS, TTS_PROVIDERS } from '@/lib/audio/constants';
import { IMAGE_PROVIDERS } from '@/lib/media/image-providers';
import { VIDEO_PROVIDERS } from '@/lib/media/video-providers';
import { isMediaPlaceholder } from '@/lib/store/media-generation';
import {
  getServerImageProviders,
  getServerVideoProviders,
  getServerTTSProviders,
  resolveImageApiKey,
  resolveImageBaseUrl,
  resolveVideoApiKey,
  resolveVideoBaseUrl,
  resolveTTSApiKey,
  resolveTTSBaseUrl,
  resolveWebSearchApiKey,
} from '@/lib/server/provider-config';
import type { SceneOutline } from '@/lib/types/generation';
import type { Scene } from '@/lib/types/stage';
import type { SpeechAction } from '@/lib/types/action';
import type { ImageProviderId } from '@/lib/media/types';
import type { VideoProviderId } from '@/lib/media/types';
import type { TTSProviderId } from '@/lib/audio/types';
import { splitLongSpeechActions } from '@/lib/audio/tts-utils';
import { searchWithTavily } from '@/lib/web-search/tavily';

const log = createLogger('ClassroomMedia');

export interface ClassroomMediaRuntimeConfig {
  image?: {
    providerId?: ImageProviderId;
    model?: string;
    baseUrl?: string;
    apiKey?: string;
  };
  video?: {
    providerId?: VideoProviderId;
    model?: string;
    baseUrl?: string;
    apiKey?: string;
  };
}

export interface VideoFallbackResource {
  elementId: string;
  prompt: string;
  mode: 'search_link' | 'storyboard';
  linkTitle?: string;
  linkUrl?: string;
  summary: string;
  timepoints: string[];
  citations: Array<{ title: string; url: string }>;
}

export interface ClassroomMediaGenerationResult {
  mediaMap: Record<string, string>;
  unresolvedImageElementIds: string[];
  videoFallbacks: VideoFallbackResource[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

const DOWNLOAD_TIMEOUT_MS = 120_000; // 2 minutes
const DOWNLOAD_MAX_SIZE = 100 * 1024 * 1024; // 100 MB

async function downloadToBuffer(url: string): Promise<Buffer> {
  const resp = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!resp.ok) throw new Error(`Download failed: ${resp.status} ${resp.statusText}`);
  const contentLength = Number(resp.headers.get('content-length') || 0);
  if (contentLength > DOWNLOAD_MAX_SIZE) {
    throw new Error(`File too large: ${contentLength} bytes (max ${DOWNLOAD_MAX_SIZE})`);
  }
  return Buffer.from(await resp.arrayBuffer());
}

function mediaServingUrl(baseUrl: string, classroomId: string, subPath: string): string {
  return `${baseUrl}/api/classroom-media/${classroomId}/${subPath}`;
}

// ---------------------------------------------------------------------------
// Image / Video generation
// ---------------------------------------------------------------------------

export async function generateMediaForClassroom(
  outlines: SceneOutline[],
  classroomId: string,
  baseUrl: string,
  options?: {
    language?: 'zh-CN' | 'en-US';
    mediaConfig?: ClassroomMediaRuntimeConfig;
  },
): Promise<ClassroomMediaGenerationResult> {
  const mediaDir = path.join(CLASSROOMS_DIR, classroomId, 'media');
  await ensureDir(mediaDir);

  // Collect all media generation requests from outlines
  const requests = outlines.flatMap((o) => o.mediaGenerations ?? []);
  if (requests.length === 0) {
    return { mediaMap: {}, unresolvedImageElementIds: [], videoFallbacks: [] };
  }

  const language = options?.language === 'en-US' ? 'en-US' : 'zh-CN';

  const serverImageProviderIds = Object.keys(getServerImageProviders()) as ImageProviderId[];
  const serverVideoProviderIds = Object.keys(getServerVideoProviders()) as VideoProviderId[];

  const orderedImageProviderIds = [
    ...(options?.mediaConfig?.image?.providerId ? [options.mediaConfig.image.providerId] : []),
    ...serverImageProviderIds,
  ].filter((id, index, arr): id is ImageProviderId => !!id && arr.indexOf(id) === index);

  const orderedVideoProviderIds = [
    ...(options?.mediaConfig?.video?.providerId ? [options.mediaConfig.video.providerId] : []),
    ...serverVideoProviderIds,
  ].filter((id, index, arr): id is VideoProviderId => !!id && arr.indexOf(id) === index);

  const mediaMap: Record<string, string> = {};
  const unresolvedImageElementIds: string[] = [];
  const failedVideoRequests = [] as Array<{ elementId: string; prompt: string }>;

  // Separate image and video requests, generate each type sequentially
  // but run the two types in parallel (providers often have limited concurrency).
  const imageRequests = requests.filter((r) => r.type === 'image');
  const videoRequests = requests.filter((r) => r.type === 'video');

  const generateImages = async () => {
    for (const req of imageRequests) {
      let generated = false;
      if (orderedImageProviderIds.length === 0) {
        unresolvedImageElementIds.push(req.elementId);
        continue;
      }

      for (const providerId of orderedImageProviderIds) {
        const runtimeImage = options?.mediaConfig?.image;
        const useRuntime = runtimeImage?.providerId === providerId;
        const apiKey =
          (useRuntime ? runtimeImage?.apiKey : undefined) || resolveImageApiKey(providerId);
        if (!apiKey) {
          continue;
        }
        const providerConfig = IMAGE_PROVIDERS[providerId];
        const model = (useRuntime ? runtimeImage?.model : undefined) || providerConfig?.models?.[0]?.id;
        const baseUrlResolved =
          (useRuntime ? runtimeImage?.baseUrl : undefined) || resolveImageBaseUrl(providerId);

        try {
          const result = await generateImage(
            { providerId, apiKey, baseUrl: baseUrlResolved, model },
            { prompt: req.prompt, aspectRatio: req.aspectRatio || '16:9' },
          );

          let buf: Buffer;
          let ext: string;
          if (result.base64) {
            buf = Buffer.from(result.base64, 'base64');
            ext = 'png';
          } else if (result.url) {
            buf = await downloadToBuffer(result.url);
            const urlExt = path.extname(new URL(result.url).pathname).replace('.', '');
            ext = ['png', 'jpg', 'jpeg', 'webp'].includes(urlExt) ? urlExt : 'png';
          } else {
            log.warn(`Image generation returned no data for ${req.elementId}`);
            continue;
          }

          const filename = `${req.elementId}.${ext}`;
          await fs.writeFile(path.join(mediaDir, filename), buf);
          mediaMap[req.elementId] = mediaServingUrl(baseUrl, classroomId, `media/${filename}`);
          log.info(`Generated image: ${filename} [provider=${providerId}]`);
          generated = true;
          break;
        } catch (err) {
          log.warn(`Image generation failed for ${req.elementId} via ${providerId}:`, err);
        }
      }

      if (!generated) {
        unresolvedImageElementIds.push(req.elementId);
      }
    }
  };

  const buildVideoFallback = async (request: { elementId: string; prompt: string }) => {
    const timepoints =
      language === 'zh-CN'
        ? ['00:00-00:30 观察现象', '00:30-01:20 解释关键过程', '01:20-02:00 小结与应用']
        : ['00:00-00:30 Observe the phenomenon', '00:30-01:20 Explain key process', '01:20-02:00 Summary and application'];
    const tavilyKey = resolveWebSearchApiKey();
    if (tavilyKey) {
      try {
        const query =
          language === 'zh-CN'
            ? `${request.prompt} 教学演示 视频`
            : `${request.prompt} educational explainer video`;
        const searchResult = await searchWithTavily({ query, apiKey: tavilyKey, maxResults: 3 });
        if (searchResult.sources.length > 0) {
          const primary = searchResult.sources[0];
          return {
            elementId: request.elementId,
            prompt: request.prompt,
            mode: 'search_link' as const,
            linkTitle: primary.title,
            linkUrl: primary.url,
            summary:
              language === 'zh-CN'
                ? `视频生成失败，已回退到外部可播放资源：${primary.title}`
                : `Video generation failed. Falling back to an external playable resource: ${primary.title}`,
            timepoints,
            citations: searchResult.sources.slice(0, 3).map((source) => ({
              title: source.title,
              url: source.url,
            })),
          };
        }
      } catch (err) {
        log.warn(`Video fallback search failed for ${request.elementId}:`, err);
      }
    }

    return {
      elementId: request.elementId,
      prompt: request.prompt,
      mode: 'storyboard' as const,
      summary:
        language === 'zh-CN'
          ? '视频生成失败，已回退为分镜脚本，请按步骤播放或讲解。'
          : 'Video generation failed. Falling back to a storyboard script for instructor playback.',
      timepoints,
      citations: [],
    };
  };

  const generateVideos = async () => {
    for (const req of videoRequests) {
      let generated = false;
      if (orderedVideoProviderIds.length === 0) {
        failedVideoRequests.push({ elementId: req.elementId, prompt: req.prompt });
        continue;
      }

      for (const providerId of orderedVideoProviderIds) {
        const runtimeVideo = options?.mediaConfig?.video;
        const useRuntime = runtimeVideo?.providerId === providerId;
        const apiKey =
          (useRuntime ? runtimeVideo?.apiKey : undefined) || resolveVideoApiKey(providerId);
        if (!apiKey) continue;
        const providerConfig = VIDEO_PROVIDERS[providerId];
        const model = (useRuntime ? runtimeVideo?.model : undefined) || providerConfig?.models?.[0]?.id;
        const baseUrlResolved =
          (useRuntime ? runtimeVideo?.baseUrl : undefined) || resolveVideoBaseUrl(providerId);

        try {
          const normalized = normalizeVideoOptions(providerId, {
            prompt: req.prompt,
            aspectRatio: (req.aspectRatio as '16:9' | '4:3' | '1:1' | '9:16') || '16:9',
          });

          const result = await generateVideo(
            { providerId, apiKey, baseUrl: baseUrlResolved, model },
            normalized,
          );

          const buf = await downloadToBuffer(result.url);
          const filename = `${req.elementId}.mp4`;
          await fs.writeFile(path.join(mediaDir, filename), buf);
          mediaMap[req.elementId] = mediaServingUrl(baseUrl, classroomId, `media/${filename}`);
          log.info(`Generated video: ${filename} [provider=${providerId}]`);
          generated = true;
          break;
        } catch (err) {
          log.warn(`Video generation failed for ${req.elementId} via ${providerId}:`, err);
        }
      }

      if (!generated) {
        failedVideoRequests.push({ elementId: req.elementId, prompt: req.prompt });
      }
    }
  };

  await Promise.all([generateImages(), generateVideos()]);
  const videoFallbacks = await Promise.all(failedVideoRequests.map((request) => buildVideoFallback(request)));

  return {
    mediaMap,
    unresolvedImageElementIds,
    videoFallbacks,
  };
}

// ---------------------------------------------------------------------------
// Placeholder replacement in scene content
// ---------------------------------------------------------------------------

export function replaceMediaPlaceholders(scenes: Scene[], mediaMap: Record<string, string>): void {
  if (Object.keys(mediaMap).length === 0) return;

  for (const scene of scenes) {
    if (scene.type !== 'slide') continue;
    const canvas = (
      scene.content as {
        canvas?: { elements?: Array<{ id: string; src?: string; type?: string }> };
      }
    )?.canvas;
    if (!canvas?.elements) continue;

    for (const el of canvas.elements) {
      if (
        (el.type === 'image' || el.type === 'video') &&
        typeof el.src === 'string' &&
        isMediaPlaceholder(el.src) &&
        mediaMap[el.src]
      ) {
        el.src = mediaMap[el.src];
      }
    }
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildImageFallbackDataUrl(language: 'zh-CN' | 'en-US'): string {
  const title = language === 'zh-CN' ? '图片生成失败' : 'Image Generation Failed';
  const subtitle =
    language === 'zh-CN'
      ? '已使用稳定占位图，课程仍可继续。'
      : 'Using a stable placeholder image so learning can continue.';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
  <rect width="1280" height="720" fill="#F8FAFC"/>
  <rect x="80" y="80" width="1120" height="560" rx="24" fill="#FFFFFF" stroke="#CBD5E1" stroke-width="4"/>
  <text x="640" y="320" text-anchor="middle" fill="#0F172A" font-size="46" font-family="Arial, 'Microsoft YaHei', sans-serif">${escapeHtml(title)}</text>
  <text x="640" y="380" text-anchor="middle" fill="#334155" font-size="28" font-family="Arial, 'Microsoft YaHei', sans-serif">${escapeHtml(subtitle)}</text>
</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function buildVideoFallbackHtml(
  fallback: VideoFallbackResource,
  language: 'zh-CN' | 'en-US',
): string {
  const header = language === 'zh-CN' ? '视频回退资源' : 'Video Fallback Resource';
  const summary = escapeHtml(fallback.summary);
  const points = fallback.timepoints.map((point) => `<li>${escapeHtml(point)}</li>`).join('');
  const citations =
    fallback.citations.length > 0
      ? fallback.citations
          .map((source) => `<li>${escapeHtml(source.title)}：${escapeHtml(source.url)}</li>`)
          .join('')
      : `<li>${language === 'zh-CN' ? '无外部来源，使用分镜脚本讲解。' : 'No external source available; using storyboard script.'}</li>`;

  const link =
    fallback.linkUrl && fallback.linkTitle
      ? `<p>${language === 'zh-CN' ? '可播放链接' : 'Playable link'}：<a href="${escapeHtml(fallback.linkUrl)}" target="_blank" rel="noreferrer">${escapeHtml(fallback.linkTitle)}</a></p>`
      : `<p>${language === 'zh-CN' ? '当前无外部视频链接，建议按时间点脚本讲解。' : 'No external video link available. Follow the storyboard timepoints below.'}</p>`;

  return [
    `<p><strong>${header}</strong></p>`,
    `<p>${summary}</p>`,
    link,
    `<p><strong>${language === 'zh-CN' ? '时间点摘要' : 'Timepoint Summary'}</strong></p>`,
    `<ul>${points}</ul>`,
    `<p><strong>${language === 'zh-CN' ? '来源引用' : 'Citations'}</strong></p>`,
    `<ul>${citations}</ul>`,
  ].join('');
}

export function applyMediaFallbacksToScenes(
  scenes: Scene[],
  mediaResult: ClassroomMediaGenerationResult,
  language: 'zh-CN' | 'en-US',
): void {
  const unresolvedImageIds = new Set(mediaResult.unresolvedImageElementIds);
  const videoFallbackByElementId = new Map(
    mediaResult.videoFallbacks.map((fallback) => [fallback.elementId, fallback]),
  );
  const imageFallbackDataUrl = buildImageFallbackDataUrl(language);

  for (const scene of scenes) {
    if (scene.type !== 'slide') continue;

    const canvas = (
      scene.content as {
        canvas?: {
          elements?: Array<{
            id: string;
            type?: string;
            src?: string;
            content?: string;
            defaultFontName?: string;
            defaultColor?: string;
            textType?: string;
            left?: number;
            top?: number;
            width?: number;
            height?: number;
            rotate?: number;
          }>;
        };
      }
    )?.canvas;
    if (!canvas?.elements) continue;

    const nextElements = [] as typeof canvas.elements;
    const removedVideoElementIds = new Set<string>();
    const fallbackSpeechTexts: string[] = [];

    for (const element of canvas.elements) {
      if (element.type === 'image' && typeof element.src === 'string' && unresolvedImageIds.has(element.src)) {
        nextElements.push({
          ...element,
          src: imageFallbackDataUrl,
        });
        continue;
      }

      if (element.type === 'video' && typeof element.src === 'string') {
        const fallback = videoFallbackByElementId.get(element.src);
        if (fallback) {
          removedVideoElementIds.add(element.id);
          nextElements.push({
            id: `video_fallback_${nanoid(8)}`,
            type: 'text',
            left: element.left ?? 540,
            top: element.top ?? 300,
            width: element.width ?? 380,
            height: Math.max(160, element.height ?? 200),
            rotate: element.rotate ?? 0,
            content: buildVideoFallbackHtml(fallback, language),
            defaultFontName: language === 'zh-CN' ? 'Microsoft YaHei' : 'Arial',
            defaultColor: '#1F2937',
            textType: 'content',
          });
          fallbackSpeechTexts.push(
            language === 'zh-CN'
              ? `视频生成失败，已切换到回退资源。请查看页面中的链接与时间点摘要。`
              : `Video generation failed. A fallback resource is now available on this slide with link and timepoint summary.`,
          );
          continue;
        }
      }

      nextElements.push(element);
    }

    canvas.elements = nextElements;

    if (removedVideoElementIds.size > 0 && Array.isArray(scene.actions)) {
      scene.actions = scene.actions.filter(
        (action) => !(action.type === 'play_video' && removedVideoElementIds.has(action.elementId)),
      );
    }

    if (fallbackSpeechTexts.length > 0) {
      scene.actions = [
        ...(scene.actions || []),
        ...fallbackSpeechTexts.map((text) => ({
          id: `action_${nanoid(8)}`,
          type: 'speech' as const,
          title: language === 'zh-CN' ? '视频回退说明' : 'Video fallback notice',
          text,
        })),
      ];
    }
  }
}

// ---------------------------------------------------------------------------
// TTS generation
// ---------------------------------------------------------------------------

export async function generateTTSForClassroom(
  scenes: Scene[],
  classroomId: string,
  baseUrl: string,
): Promise<void> {
  const audioDir = path.join(CLASSROOMS_DIR, classroomId, 'audio');
  await ensureDir(audioDir);

  // Resolve TTS provider (exclude browser-native-tts)
  const ttsProviderIds = Object.keys(getServerTTSProviders()).filter(
    (id) => id !== 'browser-native-tts',
  );
  if (ttsProviderIds.length === 0) {
    log.warn('No server TTS provider configured, skipping TTS generation');
    return;
  }

  const providerId = ttsProviderIds[0] as TTSProviderId;
  const apiKey = resolveTTSApiKey(providerId);
  if (!apiKey) {
    log.warn(`No API key for TTS provider "${providerId}", skipping TTS generation`);
    return;
  }
  const ttsBaseUrl =
    resolveTTSBaseUrl(providerId) ||
    TTS_PROVIDERS[providerId as keyof typeof TTS_PROVIDERS]?.defaultBaseUrl;
  const voice = DEFAULT_TTS_VOICES[providerId as keyof typeof DEFAULT_TTS_VOICES] || 'default';
  const format =
    TTS_PROVIDERS[providerId as keyof typeof TTS_PROVIDERS]?.supportedFormats?.[0] || 'mp3';

  for (const scene of scenes) {
    if (!scene.actions) continue;

    // Split long speech actions into multiple shorter ones before TTS generation,
    // mirroring the client-side approach. Each sub-action gets its own audio file.
    scene.actions = splitLongSpeechActions(scene.actions, providerId);

    // Use scene order to make audio IDs unique across scenes
    const sceneOrder = scene.order;

    for (const action of scene.actions) {
      if (action.type !== 'speech' || !(action as SpeechAction).text) continue;
      const speechAction = action as SpeechAction;
      // Include scene order in audioId to prevent collision across scenes
      const audioId = `tts_s${sceneOrder}_${action.id}`;

      try {
        const result = await generateTTS(
          {
            providerId,
            modelId: DEFAULT_TTS_MODELS[providerId as keyof typeof DEFAULT_TTS_MODELS] || '',
            apiKey,
            baseUrl: ttsBaseUrl,
            voice,
            speed: speechAction.speed,
          },
          speechAction.text,
        );

        const filename = `${audioId}.${format}`;
        await fs.writeFile(path.join(audioDir, filename), result.audio);

        speechAction.audioId = audioId;
        speechAction.audioUrl = mediaServingUrl(baseUrl, classroomId, `audio/${filename}`);
        log.info(`Generated TTS: ${filename} (${result.audio.length} bytes)`);
      } catch (err) {
        log.warn(`TTS generation failed for action ${action.id}:`, err);
      }
    }
  }
}
