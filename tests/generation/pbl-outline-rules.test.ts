import { describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { applyOutlineFallbacks } from '@/lib/generation/outline-generator';
import type { SceneOutline } from '@/lib/types/generation';

describe('PBL outline rules', () => {
  it('keeps valid PBL outlines when a language model is available', () => {
    const outline: SceneOutline = {
      id: 'pbl-1',
      type: 'pbl',
      title: '真实任务挑战',
      description: '学生分角色完成真实任务。',
      keyPoints: ['定义问题', '分工协作', '产出方案'],
      order: 1,
      language: 'zh-CN',
      pblConfig: {
        projectTopic: '校园节能改造',
        projectDescription: '围绕校园能源使用提出改造方案。',
        targetSkills: ['问题定义', '协作', '方案设计'],
        issueCount: 3,
        language: 'zh-CN',
      },
    };

    expect(applyOutlineFallbacks(outline, true).type).toBe('pbl');
  });

  it('falls back PBL outlines that cannot be generated safely', () => {
    const outline: SceneOutline = {
      id: 'pbl-2',
      type: 'pbl',
      title: '项目式学习',
      description: '缺少配置。',
      keyPoints: ['任务'],
      order: 1,
      language: 'zh-CN',
    };

    expect(applyOutlineFallbacks(outline, true).type).toBe('slide');
    expect(
      applyOutlineFallbacks(
        {
          ...outline,
          pblConfig: {
            projectTopic: '研究任务',
            projectDescription: '完成研究。',
            targetSkills: ['研究'],
            issueCount: 2,
            language: 'zh-CN',
          },
        },
        false,
      ).type,
    ).toBe('slide');
  });

  it('documents PBL trigger requirements in the outline prompt', async () => {
    const prompt = await fs.readFile(
      path.join(process.cwd(), 'lib/generation/prompts/templates/requirements-to-outlines/user.md'),
      'utf-8',
    );

    expect(prompt).toContain('"type": "slide" or "quiz" or "interactive" or "pbl"');
    expect(prompt).toContain('generate exactly one `"type": "pbl"` scene');
    expect(prompt).toContain('"pblConfig"');
  });
});
