'use client';

import { useState } from 'react';
import type { QuizContent } from '@/lib/types/stage';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface QuizRendererProps {
  readonly content: QuizContent;
  readonly mode: 'autonomous' | 'playback';
  readonly sceneId: string;
}

export function QuizRenderer({ content, mode, sceneId: _sceneId }: QuizRendererProps) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [attemptCount, setAttemptCount] = useState(0);

  const handleAnswerChange = (questionId: string, answer: string) => {
    setAnswers((prev) => ({ ...prev, [questionId]: answer }));
  };

  const handleSubmit = () => {
    setAttemptCount((prev) => prev + 1);
  };

  const handleSkipWithDebt = () => {
  };

  return (
    <div className="w-full h-full overflow-y-auto p-8">
      <div className="max-w-3xl mx-auto space-y-6">
        <h1 className="text-3xl font-bold">Quiz</h1>
        {content.questions.map((question) => (
          <Card key={question.id}>
            <CardHeader>
              <CardTitle>{question.question}</CardTitle>
            </CardHeader>
            <CardContent>
              {question.type === 'single' && question.options && (
                <div className="space-y-2">
                  {question.options.map((option, optIndex) => {
                    // Normalize: options may be QuizOption objects or plain strings from AI
                    const optionValue = typeof option === 'string' ? option : option.value;
                    const optionLabel = typeof option === 'string' ? option : option.label;
                    const letterPrefix = String.fromCharCode(65 + optIndex); // A, B, C, D...

                    return (
                      <label
                        key={`${question.id}-opt-${optIndex}`}
                        className={cn(
                          'flex items-center space-x-2 p-2 rounded cursor-pointer hover:bg-muted',
                          answers[question.id] === (optionValue || letterPrefix) && 'bg-muted',
                        )}
                      >
                        <input
                          type="radio"
                          name={question.id}
                          value={optionValue || letterPrefix}
                          checked={answers[question.id] === (optionValue || letterPrefix)}
                          onChange={(e) => handleAnswerChange(question.id, e.target.value)}
                          className="size-4"
                        />
                        <span>
                          {letterPrefix}. {optionLabel}
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
              {question.type === 'short_answer' && (
                <textarea
                  className="w-full min-h-24 p-2 border rounded"
                  placeholder="Enter your answer..."
                  value={answers[question.id] || ''}
                  onChange={(e) => handleAnswerChange(question.id, e.target.value)}
                />
              )}
            </CardContent>
          </Card>
        ))}
        {mode === 'autonomous' && (
          <div className="flex flex-col items-end gap-3 mt-4">
            <div className="flex gap-4">
              {attemptCount >= 2 && (
                <Button
                  variant="outline"
                  className="border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700"
                  onClick={handleSkipWithDebt}
                >
                  先跳过，但标记为未掌握
                </Button>
              )}
              <Button onClick={handleSubmit}>
                {attemptCount > 0 ? '再次提交 (继续尝试)' : '提交答案'}
              </Button>
            </div>
            {attemptCount >= 2 && (
              <p className="text-xs text-muted-foreground max-w-[300px] text-right">
                你已经尝试了 {attemptCount} 次。如果不确定，你可以向 AI 老师提问，或者选择先跳过（这会记录在老师看板中）。
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
