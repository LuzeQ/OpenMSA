import { describe, expect, it } from 'vitest';
import { validateAndRepairSlideLayout } from '@/lib/generation/slide-layout-repair';
import type { GeneratedSlideData } from '@/lib/generation/pipeline-types';

describe('validateAndRepairSlideLayout', () => {
  it('repairs text overflow risk, media ratio, line stroke misuse, and overlap', () => {
    const elements: GeneratedSlideData['elements'] = [
      {
        id: 'text-a',
        type: 'text',
        left: 20,
        top: 40,
        width: 300,
        height: 40,
        content:
          '<p style="font-size: 18px;">这是一段较长的中文说明文字，需要更高的文本框避免溢出。</p>',
      },
      {
        id: 'image-a',
        type: 'image',
        left: 80,
        top: 80,
        width: 400,
        height: 400,
        src: 'img_1',
      },
      {
        id: 'line-a',
        type: 'line',
        left: 320,
        top: 200,
        width: 60,
        height: 1,
        start: [0, 0],
        end: [20, 0],
        points: ['', 'arrow'],
      },
    ];

    const result = validateAndRepairSlideLayout(elements, {
      canvasWidth: 1000,
      canvasHeight: 562.5,
      assignedImages: [{ id: 'img_1', src: '', pageNumber: 1, width: 1600, height: 900 }],
    });

    const text = result.elements.find((element) => element.id === 'text-a')!;
    const image = result.elements.find((element) => element.id === 'image-a')!;
    const line = result.elements.find((element) => element.id === 'line-a') as Record<string, unknown>;

    expect(text.left).toBeGreaterThanOrEqual(50);
    expect(text.top).toBeGreaterThanOrEqual(50);
    expect(text.height).toBeGreaterThan(40);
    expect(Math.round(image.width / image.height * 100) / 100).toBeCloseTo(16 / 9, 1);
    expect(line.width).toBeLessThanOrEqual(6);
    expect(line.end).toEqual([60, 0]);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        'TEXT_HEIGHT_ADJUSTED',
        'IMAGE_RATIO_ADJUSTED',
        'LINE_STROKE_CLAMPED',
        'LINE_LENGTH_ADJUSTED',
      ]),
    );
  });
});
