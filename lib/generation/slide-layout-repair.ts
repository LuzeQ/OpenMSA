import type { MediaGenerationRequest } from '@/lib/media/types';
import type { GeneratedSlideData } from '@/lib/generation/pipeline-types';
import type { PdfImage } from '@/lib/types/generation';

type GeneratedElement = GeneratedSlideData['elements'][number];

export interface SlideLayoutRepairIssue {
  code:
    | 'OUT_OF_BOUNDS'
    | 'TEXT_HEIGHT_ADJUSTED'
    | 'IMAGE_RATIO_ADJUSTED'
    | 'LINE_STROKE_CLAMPED'
    | 'LINE_LENGTH_ADJUSTED'
    | 'ELEMENT_OVERLAP';
  severity: 'info' | 'warning' | 'error';
  message: string;
  elementIds: string[];
}

export interface SlideLayoutRepairResult {
  elements: GeneratedElement[];
  issues: SlideLayoutRepairIssue[];
  remainingIssues: SlideLayoutRepairIssue[];
  shouldRetry: boolean;
  retryInstruction?: string;
}

interface SlideLayoutRepairOptions {
  canvasWidth: number;
  canvasHeight: number;
  margin?: number;
  assignedImages?: PdfImage[];
  mediaGenerations?: MediaGenerationRequest[];
}

interface Box {
  id: string;
  type: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

const DEFAULT_MARGIN = 50;
const MIN_ARROW_LENGTH = 60;
const TEXT_HEIGHT_LOOKUP: Record<number, number[]> = {
  14: [43, 64, 85, 106, 127],
  16: [46, 70, 94, 118, 142],
  18: [49, 76, 103, 130, 157],
  20: [52, 82, 112, 142, 172],
  24: [58, 94, 130, 166, 202],
  28: [64, 106, 148, 190, 232],
  32: [70, 118, 166, 214, 262],
  36: [76, 130, 184, 238, 292],
};

function cloneElement(element: GeneratedElement): GeneratedElement {
  return { ...element };
}

function elementId(element: GeneratedElement): string {
  const id = element.id;
  return typeof id === 'string' ? id : `${element.type}_${Math.round(element.left)}_${Math.round(element.top)}`;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function nearestFontSize(size: number): number {
  return Object.keys(TEXT_HEIGHT_LOOKUP)
    .map(Number)
    .reduce((best, candidate) =>
      Math.abs(candidate - size) < Math.abs(best - size) ? candidate : best,
    );
}

function extractMaxFontSize(content: unknown): number {
  if (typeof content !== 'string') return 18;
  const sizes = [...content.matchAll(/font-size\s*:\s*(\d+)px/gi)]
    .map((match) => Number(match[1]))
    .filter((size) => Number.isFinite(size));
  if (sizes.length === 0) return 18;
  return clamp(Math.max(...sizes), 14, 36);
}

function stripHtml(content: string): string {
  return content.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
}

function countParagraphs(content: string): string[] {
  const paragraphMatches = [...content.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((match) =>
    stripHtml(match[1] || ''),
  );
  if (paragraphMatches.length > 0) return paragraphMatches.filter(Boolean);
  const stripped = stripHtml(content);
  return stripped ? [stripped] : [''];
}

function estimateTextHeight(element: GeneratedElement): number | null {
  if (element.type !== 'text') return null;
  const content = element.content;
  if (typeof content !== 'string') return null;

  const fontSize = nearestFontSize(extractMaxFontSize(content));
  const charsPerLine = Math.max(1, Math.floor((Math.max(element.width, 1) - 20) / fontSize));
  const estimatedLines = countParagraphs(content).reduce((sum, paragraph) => {
    const cjkCount = (paragraph.match(/[\u3400-\u9fff]/g) || []).length;
    const latinCount = Math.max(0, paragraph.length - cjkCount);
    const weightedLength = cjkCount + latinCount * 0.55;
    return sum + Math.max(1, Math.ceil(weightedLength / charsPerLine));
  }, 0);
  const lineCount = clamp(Math.ceil(estimatedLines + 0.8), 1, 5);
  return TEXT_HEIGHT_LOOKUP[fontSize][lineCount - 1];
}

function parseAspectRatio(value: string | undefined): number | null {
  if (!value) return null;
  const match = value.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || height <= 0) return null;
  return width / height;
}

function buildAspectRatioMap(options: SlideLayoutRepairOptions): Map<string, number> {
  const map = new Map<string, number>();
  for (const image of options.assignedImages || []) {
    if (image.width && image.height && image.height > 0) {
      map.set(image.id, image.width / image.height);
    }
  }
  for (const media of options.mediaGenerations || []) {
    const ratio = parseAspectRatio(media.aspectRatio) || 16 / 9;
    map.set(media.elementId, ratio);
  }
  return map;
}

function clampElementBounds(
  element: GeneratedElement,
  options: Required<Pick<SlideLayoutRepairOptions, 'canvasWidth' | 'canvasHeight' | 'margin'>>,
  issues: SlideLayoutRepairIssue[],
) {
  const before = {
    left: element.left,
    top: element.top,
    width: element.width,
    height: element.height,
  };

  element.width = clamp(element.width || 1, 1, options.canvasWidth - options.margin * 2);
  element.height = clamp(element.height || 1, 1, options.canvasHeight - options.margin * 2);
  element.left = clamp(element.left, options.margin, options.canvasWidth - options.margin - element.width);
  element.top = clamp(element.top, options.margin, options.canvasHeight - options.margin - element.height);

  if (
    before.left !== element.left ||
    before.top !== element.top ||
    before.width !== element.width ||
    before.height !== element.height
  ) {
    issues.push({
      code: 'OUT_OF_BOUNDS',
      severity: 'warning',
      message: 'Element was clamped back inside the slide safe area.',
      elementIds: [elementId(element)],
    });
  }
}

function getBox(element: GeneratedElement): Box | null {
  if (element.type === 'line' || element.type === 'shape') return null;
  return {
    id: elementId(element),
    type: element.type,
    left: element.left,
    top: element.top,
    width: element.width,
    height: element.height,
  };
}

function intersectionRatio(a: Box, b: Box): number {
  const x = Math.max(0, Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left));
  const y = Math.max(0, Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top));
  const area = x * y;
  if (area <= 0) return 0;
  return area / Math.max(1, Math.min(a.width * a.height, b.width * b.height));
}

function detectOverlaps(elements: GeneratedElement[]): SlideLayoutRepairIssue[] {
  const boxes = elements
    .map((element) => getBox(element))
    .filter((box): box is Box => box !== null);
  const issues: SlideLayoutRepairIssue[] = [];

  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const ratio = intersectionRatio(boxes[i], boxes[j]);
      if (ratio < 0.08) continue;
      issues.push({
        code: 'ELEMENT_OVERLAP',
        severity: ratio > 0.18 ? 'error' : 'warning',
        message: `${boxes[i].type} overlaps with ${boxes[j].type}.`,
        elementIds: [boxes[i].id, boxes[j].id],
      });
    }
  }

  return issues;
}

function repairOverlaps(
  elements: GeneratedElement[],
  canvasWidth: number,
  canvasHeight: number,
  margin: number,
) {
  const ordered = [...elements]
    .map((element, index) => ({ element, index }))
    .filter(({ element }) => getBox(element))
    .sort((a, b) => a.element.top - b.element.top || a.element.left - b.element.left);

  const placed: GeneratedElement[] = [];
  for (const { element } of ordered) {
    for (const previous of placed) {
      const currentBox = getBox(element);
      const previousBox = getBox(previous);
      if (!currentBox || !previousBox || intersectionRatio(currentBox, previousBox) < 0.08) {
        continue;
      }

      const nextTop = previous.top + previous.height + 18;
      if (nextTop + element.height <= canvasHeight - margin) {
        element.top = nextTop;
        continue;
      }

      const rightSide = previous.left + previous.width + 30;
      if (rightSide + element.width <= canvasWidth - margin) {
        element.left = rightSide;
        element.top = previous.top;
        continue;
      }

      const leftSide = previous.left - element.width - 30;
      if (leftSide >= margin) {
        element.left = leftSide;
        element.top = previous.top;
      }
    }
    placed.push(element);
  }
}

export function validateAndRepairSlideLayout(
  inputElements: GeneratedElement[],
  options: SlideLayoutRepairOptions,
): SlideLayoutRepairResult {
  const canvasWidth = options.canvasWidth;
  const canvasHeight = options.canvasHeight;
  const margin = options.margin ?? DEFAULT_MARGIN;
  const issues: SlideLayoutRepairIssue[] = [];
  const aspectRatios = buildAspectRatioMap(options);
  const elements = inputElements.map(cloneElement);

  for (const element of elements) {
    if (element.type === 'text') {
      const estimatedHeight = estimateTextHeight(element);
      if (estimatedHeight && element.height < estimatedHeight) {
        element.height = estimatedHeight;
        issues.push({
          code: 'TEXT_HEIGHT_ADJUSTED',
          severity: 'info',
          message: 'Text box height was increased to reduce overflow risk.',
          elementIds: [elementId(element)],
        });
      }
    }

    if ((element.type === 'image' || element.type === 'video') && typeof element.src === 'string') {
      const ratio = aspectRatios.get(element.src) || (element.type === 'video' ? 16 / 9 : null);
      if (ratio) {
        const currentRatio = element.width / Math.max(1, element.height);
        if (Math.abs(currentRatio - ratio) / ratio > 0.12) {
          const nextHeight = Math.round(element.width / ratio);
          if (nextHeight <= canvasHeight - margin * 2) {
            element.height = nextHeight;
          } else {
            element.height = canvasHeight - margin * 2;
            element.width = Math.round(element.height * ratio);
          }
          issues.push({
            code: 'IMAGE_RATIO_ADJUSTED',
            severity: 'info',
            message: 'Media element size was adjusted to preserve aspect ratio.',
            elementIds: [elementId(element)],
          });
        }
      }
    }

    if (element.type === 'line') {
      const line = element as Record<string, unknown>;
      const stroke = typeof line.width === 'number' ? line.width : element.width;
      const nextStroke = clamp(stroke, 2, 6);
      if (nextStroke !== stroke) {
        line.width = nextStroke;
        issues.push({
          code: 'LINE_STROKE_CLAMPED',
          severity: 'warning',
          message: 'Line stroke was clamped to 2-6px; line length must use start/end.',
          elementIds: [elementId(element)],
        });
      }

      const start = Array.isArray(line.start) ? (line.start as number[]) : undefined;
      const end = Array.isArray(line.end) ? (line.end as number[]) : undefined;
      if (start && end && start.length >= 2 && end.length >= 2) {
        const dx = Number(end[0]) - Number(start[0]);
        const dy = Number(end[1]) - Number(start[1]);
        const length = Math.sqrt(dx * dx + dy * dy);
        if (length > 0 && length < MIN_ARROW_LENGTH) {
          const scale = MIN_ARROW_LENGTH / length;
          line.end = [Math.round(Number(start[0]) + dx * scale), Math.round(Number(start[1]) + dy * scale)];
          issues.push({
            code: 'LINE_LENGTH_ADJUSTED',
            severity: 'info',
            message: 'Short connector line was extended to the minimum readable length.',
            elementIds: [elementId(element)],
          });
        }
      }
    }

    clampElementBounds(element, { canvasWidth, canvasHeight, margin }, issues);
  }

  issues.push(...detectOverlaps(elements));
  repairOverlaps(elements, canvasWidth, canvasHeight, margin);
  for (const element of elements) {
    clampElementBounds(element, { canvasWidth, canvasHeight, margin }, issues);
  }

  const remainingIssues = detectOverlaps(elements).filter((issue) => issue.severity === 'error');
  const retryInstruction =
    remainingIssues.length > 0
      ? `Regenerate the slide using a fixed layout template. Avoid these overlaps: ${remainingIssues
          .map((issue) => issue.elementIds.join(' + '))
          .join('; ')}. Keep connector line width as stroke 2-6 and use start/end for length.`
      : undefined;

  return {
    elements,
    issues,
    remainingIssues,
    shouldRetry: remainingIssues.length > 0,
    retryInstruction,
  };
}
