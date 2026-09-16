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
import { createPropertiesBulkRouter } from './routes/properties-bulk.routes';
import { createPropertiesRouter } from './routes/properties.routes';
import type { BulkPropertyRegistrationService } from './services/property-resolver/bulk-property-registration.service';
import { createBulkPropertyRegistrationService } from './services/property-resolver/bulk-property-registration.service';
import type { PropertyIdentityService } from './services/property-resolver/property-identity.service';
import { createPropertyIdentityService } from './services/property-resolver/property-identity.service';
import type { PropertyResolverService } from './services/property-resolver/property-resolver.service';
import { createPropertyResolverService } from './services/property-resolver/property-resolver.service';

export type AppDependencies = {
  config?: Pick<AppConfig, 'apiBodyLimit'>;
  prisma?: PrismaClient;
  propertyResolver?: Pick<PropertyResolverService, 'resolveAddress' | 'resolveBbl'>;
  propertyIdentity?: Pick<PropertyIdentityService, 'findPropertyById'>;
  bulkRegistrationService?: BulkPropertyRegistrationService;
};

function resolveApiBodyLimit(dependencies: AppDependencies): string {
  if (dependencies.config?.apiBodyLimit !== undefined) {
    return dependencies.config.apiBodyLimit;
  }

  if (process.env.DATABASE_URL?.trim()) {
    return getConfig().apiBodyLimit;
  }

  return CONFIG_DEFAULTS.API_BODY_LIMIT;
}

function shouldWirePropertyRoutes(dependencies: AppDependencies): boolean {
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

  app.use(express.json({ limit: resolveApiBodyLimit(dependencies) }));

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  if (!shouldWirePropertyRoutes(dependencies)) {
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

  app.use(
    '/properties',
    createPropertiesRouter({
      propertyResolver,
      propertyIdentity,
    }),
  );
  app.use(
    '/properties',
    createPropertiesBulkRouter({
      bulkRegistrationService,
    }),
  );

  return app;
}
