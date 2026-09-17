import express from 'express';
import type { PrismaClient } from '@prisma/client';

import { BuildingFootprintsClient } from './clients/building-footprints.client';
import { CondoUnitsClient } from './clients/condo-units.client';
import { CondominiumsClient } from './clients/condominiums.client';
import { createGeoSearchClient } from './clients/geosearch.client';
import { PlutoClient } from './clients/pluto.client';
import { CONFIG_DEFAULTS } from './config/defaults';
import { getConfig, type AppConfig } from './config';
import { getPrismaClient } from './db/prisma';
import { createErrorMiddleware } from './middleware/error.middleware';
import {
  createHttpSecurityMiddleware,
  type HttpSecurityConfig,
} from './middleware/security.middleware';
import { createPropertiesBulkRouter } from './routes/properties-bulk.routes';
import { createPropertiesRouter } from './routes/properties.routes';
import { createViolationsRouter } from './routes/violations.routes';
import type { BulkPropertyRegistrationService } from './services/property-resolver/bulk-property-registration.service';
import { createBulkPropertyRegistrationService } from './services/property-resolver/bulk-property-registration.service';
import type { PropertyIdentityService } from './services/property-resolver/property-identity.service';
import { createPropertyIdentityService } from './services/property-resolver/property-identity.service';
import type { PropertyResolverService } from './services/property-resolver/property-resolver.service';
import { createPropertyResolverService } from './services/property-resolver/property-resolver.service';
import { createPortfolioViolationsQueryService } from './services/ecb/portfolio-violations-query.service';
import { createPropertyViolationsQueryService } from './services/ecb/property-violations-query.service';

const DEFAULT_API_RATE_LIMIT = '100';

export type AppDependencies = {
  config?: Partial<Pick<AppConfig, 'apiBodyLimit' | 'apiRateLimit'>>;
  prisma?: PrismaClient;
  propertyResolver?: Pick<PropertyResolverService, 'resolveAddress' | 'resolveBbl'>;
  propertyIdentity?: Pick<PropertyIdentityService, 'findPropertyById'>;
  bulkRegistrationService?: BulkPropertyRegistrationService;
};

function resolveHttpSecurityConfig(dependencies: AppDependencies): HttpSecurityConfig {
  if (dependencies.config !== undefined) {
    return {
      apiBodyLimit: dependencies.config.apiBodyLimit ?? CONFIG_DEFAULTS.API_BODY_LIMIT,
      apiRateLimit: dependencies.config.apiRateLimit ?? DEFAULT_API_RATE_LIMIT,
    };
  }

  if (process.env.DATABASE_URL?.trim()) {
    const config = getConfig();
    return {
      apiBodyLimit: config.apiBodyLimit,
      apiRateLimit: config.apiRateLimit ?? DEFAULT_API_RATE_LIMIT,
    };
  }

  return {
    apiBodyLimit: CONFIG_DEFAULTS.API_BODY_LIMIT,
    apiRateLimit: DEFAULT_API_RATE_LIMIT,
  };
}

function shouldWireApplicationRoutes(dependencies: AppDependencies): boolean {
  if (
    dependencies.propertyResolver !== undefined ||
    dependencies.propertyIdentity !== undefined ||
    dependencies.bulkRegistrationService !== undefined
  ) {
    return true;
  }

  return Boolean(process.env.DATABASE_URL?.trim());
}

function createProductionResolverClients(config: AppConfig) {
  return {
    geoSearch: createGeoSearchClient(),
    pluto: new PlutoClient({ socrataAppToken: config.socrataAppToken }),
    buildingFootprints: new BuildingFootprintsClient({
      socrataAppToken: config.socrataAppToken,
    }),
    condoUnits: new CondoUnitsClient({ config }),
    condominiums: new CondominiumsClient({ config }),
  };
}

export function createApp(dependencies: AppDependencies = {}): express.Application {
  const app = express();

  app.use(...createHttpSecurityMiddleware(resolveHttpSecurityConfig(dependencies)));

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  if (!shouldWireApplicationRoutes(dependencies)) {
    app.use(createErrorMiddleware());
    return app;
  }

  const prisma = dependencies.prisma ?? getPrismaClient();
  const config = getConfig();
  const propertyIdentity =
    dependencies.propertyIdentity ?? createPropertyIdentityService(prisma);
  const propertyResolver =
    dependencies.propertyResolver ??
    createPropertyResolverService({
      prisma,
      clients: createProductionResolverClients(config),
    });
  const bulkRegistrationService =
    dependencies.bulkRegistrationService ??
    createBulkPropertyRegistrationService({
      prisma,
      clients: createProductionResolverClients(config),
    });
  const propertyViolationsQuery = createPropertyViolationsQueryService(prisma);
  const portfolioViolationsQuery = createPortfolioViolationsQueryService(prisma);

  app.use(
    '/properties',
    createPropertiesRouter({
      propertyResolver,
      propertyIdentity,
      propertyViolationsQuery,
    }),
  );
  app.use(
    '/properties',
    createPropertiesBulkRouter({
      bulkRegistrationService,
    }),
  );
  app.use(
    createViolationsRouter({
      portfolioViolationsQuery,
    }),
  );

  app.use(createErrorMiddleware());

  return app;
}
