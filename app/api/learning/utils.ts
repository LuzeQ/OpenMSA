import { NextResponse } from 'next/server';
import { apiError } from '@/lib/server/api-response';
import { LearningDomainError } from '@/lib/server/learning-store';

export function mapLearningDomainError(error: unknown) {
  if (error instanceof LearningDomainError) {
    switch (error.code) {
      case 'FORBIDDEN':
        return apiError('INVALID_REQUEST', 403, 'Permission denied');
      case 'PROGRAM_NOT_FOUND':
      case 'COURSE_NOT_FOUND':
        return apiError('INVALID_REQUEST', 404, 'Program not found');
      case 'ASSIGNMENT_NOT_FOUND':
        return apiError('INVALID_REQUEST', 404, 'Assignment not found');
      case 'LESSON_NOT_FOUND':
        return apiError('INVALID_REQUEST', 404, 'Lesson not found');
      case 'GENERATION_TASK_NOT_FOUND':
        return apiError('INVALID_REQUEST', 404, 'Generation task not found');
      case 'STUCK_NOT_FOUND':
        return apiError('INVALID_REQUEST', 404, 'Stuck point not found');
      case 'APPLICATION_NOT_FOUND':
        return apiError('INVALID_REQUEST', 404, 'Application not found');
      case 'APPLICATION_ALREADY_REVIEWED':
        return apiError('INVALID_REQUEST', 409, 'Application has already been reviewed');
      case 'PROGRAM_NOT_PUBLISHED':
      case 'COURSE_NOT_PUBLISHED':
        return apiError('INVALID_REQUEST', 400, 'Program must be published first');
      case 'LESSONS_REQUIRED':
        return apiError('MISSING_REQUIRED_FIELD', 400, 'At least one lesson is required');
      case 'TITLE_REQUIRED':
        return apiError('MISSING_REQUIRED_FIELD', 400, 'Title is required');
      case 'STUDENTS_REQUIRED':
        return apiError('MISSING_REQUIRED_FIELD', 400, 'At least one student is required');
      case 'NOTE_REQUIRED':
        return apiError('MISSING_REQUIRED_FIELD', 400, 'Note is required');
      case 'MISSING_REQUIRED_FIELD':
        return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing required field');
      case 'ALREADY_ASSIGNED':
        return apiError('INVALID_REQUEST', 409, 'Program already assigned');
      case 'PUBLISH_CONFIRM_REQUIRED':
        return NextResponse.json(
          {
            success: false,
            errorCode: 'INVALID_REQUEST',
            error: 'Publish confirmation required',
            warnings: Array.isArray(error.details) ? error.details : [],
          },
          { status: 409 },
        );
      default:
        return apiError('INTERNAL_ERROR', 500, 'Unexpected server error');
    }
  }

  if (error instanceof Error) {
    return apiError('INTERNAL_ERROR', 500, error.message || 'Unexpected server error');
  }

  return apiError('INTERNAL_ERROR', 500, 'Unexpected server error');
}

export function ensureTeacherOrAdmin(role: string) {
  return role === 'teacher' || role === 'admin';
}
