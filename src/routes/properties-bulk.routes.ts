import { Router, type Request, type Response, type NextFunction } from 'express';
import { ZodError } from 'zod';

import { AppError } from '../errors';
import {
  BULK_BBL_MAX_COUNT,
  bulkPropertyRegistrationRequestSchema,
} from '../schemas/property-bulk.schema';
import type { BulkPropertyRegistrationService } from '../services/property-resolver/bulk-property-registration.service';

export type PropertiesBulkRouterDependencies = {
  bulkRegistrationService: BulkPropertyRegistrationService;
};

function formatZodError(error: ZodError): { code: string; message: string } {
  const firstIssue = error.issues[0];
  if (firstIssue?.code === 'too_big' && firstIssue.path[0] === 'bbls') {
    return {
      code: 'BULK_BBL_LIMIT_EXCEEDED',
      message: `Maximum of ${BULK_BBL_MAX_COUNT} BBLs per request`,
    };
  }

  return {
    code: 'VALIDATION_ERROR',
    message: firstIssue?.message ?? 'Request validation failed',
  };
}

export function createPropertiesBulkRouter(
  dependencies: PropertiesBulkRouterDependencies,
): Router {
  const router = Router();

  router.post('/bulk', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = bulkPropertyRegistrationRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        const validationError = formatZodError(parsed.error);
        res.status(400).json({
          error: validationError,
        });
        return;
      }

      const response = await dependencies.bulkRegistrationService.registerBbls(parsed.data.bbls);
      res.status(200).json(response);
    } catch (error) {
      if (error instanceof AppError && error.statusCode !== undefined) {
        res.status(error.statusCode).json({
          error: {
            code: error.code,
            message: error.message,
          },
        });
        return;
      }

      next(error);
    }
  });

  return router;
}
