import { NestFactory, Reflector, HttpAdapterHost } from '@nestjs/core';
import { WinstonModule } from 'nest-winston';
import * as winston from 'winston';
import helmet from 'helmet';
import { ClassSerializerInterceptor, ValidationPipe, RequestMethod } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { readTelemetryConfig, shutdownTelemetry, startTelemetry } from './telemetry/telemetry';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { VersioningInterceptor } from './common/interceptors/versioning.interceptor';
import { AllExceptionsFilter } from './core/filters/all-exceptions.filter';
import { SentryService } from './sentry/sentry.service';
import { getCorrelationId } from './common/correlation-id.context';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { version } = require('../package.json') as { version: string };

/**
 * Parse the `TRUST_PROXY` env var into a value Express's `trust proxy` setting
 * understands. Defaults to `false` (trust nothing) so that `req.ip` and any
 * `X-Forwarded-For`-derived value cannot be spoofed by external clients. Set it
 * explicitly to match your deployment, e.g. `loopback`, a hop count like `1`,
 * or a comma-separated list of trusted proxy IPs/subnets.
 */
function parseTrustProxy(raw: string | undefined): boolean | number | string | string[] {
  const value = (raw ?? '').trim();
  if (value === '' || value.toLowerCase() === 'false') return false;
  if (value.toLowerCase() === 'true') return true;
  if (/^\d+$/.test(value)) return parseInt(value, 10);
  if (value.includes(',')) return value.split(',').map((s) => s.trim()).filter(Boolean);
  return value;
}

async function bootstrap(): Promise<void> {
  startTelemetry(readTelemetryConfig());

  const correlationIdFormat = winston.format((info) => {
    const correlationId = getCorrelationId();
    if (typeof info.correlationId === 'undefined') {
      info.correlationId = correlationId ?? 'N/A';
    }
    return info;
  });

  const app = await NestFactory.create(AppModule, { rawBody: true, logger: WinstonModule.createLogger({
    level: 'silly',
    transports: [
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.timestamp(),
          correlationIdFormat(),
          winston.format.json(),
        ),
      }),
      new winston.transports.File({
        filename: 'logs/app.log',
        format: winston.format.combine(
          winston.format.timestamp(),
          correlationIdFormat(),
          winston.format.json(),
        ),
      }),
    ],
  }) });

  // Security headers — helmet must be applied before routes are registered
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"], // allow Swagger UI
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'validator.swagger.io'],
          connectSrc: ["'self'"],
        },
      },
      hsts: { maxAge: 31536000, includeSubDomains: true },
    }),
  );

  // Initialize Sentry before other middleware so it can capture bootstrap errors
  const sentryService = app.get(SentryService);
  sentryService.init();

  const config = app.get(ConfigService);

  // Trust proxy must be set explicitly: it controls whether Express derives
  // `req.ip` from `X-Forwarded-For`. Left at the safe default (`false`),
  // untrusted clients cannot spoof their source IP past IpAllowlistGuard.
  app
    .getHttpAdapter()
    .getInstance()
    .set('trust proxy', parseTrustProxy(config.get<string>('TRUST_PROXY')));

  const port = parseInt(String(config.get('PORT', 3000)), 10);
  const apiPrefix = String(config.get('API_PREFIX', 'api/v1'));

  const isDevelopment = process.env.NODE_ENV !== 'production';
  const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
    : [];

  app.enableCors({
    origin: isDevelopment
      ? true
      : (origin, callback) => {
          if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
          } else {
            callback(new Error(`CORS: origin '${origin}' not allowed`));
          }
        },
    credentials: true,
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'x-correlation-id'],
    exposedHeaders: ['X-Correlation-ID'],
  });

  app.setGlobalPrefix(apiPrefix, {
    exclude: [
      { path: 'health', method: RequestMethod.ALL },
      { path: 'health/ready', method: RequestMethod.ALL },
      { path: 'docs', method: RequestMethod.ALL },
      { path: 'docs/(.*)', method: RequestMethod.ALL },
      { path: 'docs-json', method: RequestMethod.GET },
    ],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: false,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter(app.get(HttpAdapterHost), config));
  app.useGlobalInterceptors(
    new VersioningInterceptor(),
    new LoggingInterceptor(),
    new ClassSerializerInterceptor(app.get(Reflector)),
  );
  // DeprecationInterceptor is intentionally NOT registered globally: it runs a
  // reflector lookup on every request for the `deprecated` metadata key, and no
  // handler is annotated with @Deprecated() yet. Register it with
  // `app.useGlobalInterceptors(new DeprecationInterceptor(app.get(Reflector)))`
  // (or `@UseInterceptors(DeprecationInterceptor)`) in the same commit that adds
  // the first @Deprecated() endpoint.

  const swaggerConfig = new DocumentBuilder()
    .setTitle('DupDub API')
    .setDescription(
      'Crypto-to-Fiat settlement platform. Use **Authorize** for JWT Bearer and/or **X-API-Key** for API key auth. ' +
        `HTTP API routes are under \`/${apiPrefix}\`; Swagger UI is at \`/docs\`.`,
    )
    .setVersion(version)
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'JWT from POST /auth/login or /auth/register',
      },
      'bearer',
    )
    .addApiKey(
      {
        type: 'apiKey',
        in: 'header',
        name: 'X-API-Key',
        description: 'Merchant API key (when using API key auth instead of Bearer)',
      },
      'api-key',
    )
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document, {
    customSiteTitle: 'DupDub API',
    swaggerOptions: {
      persistAuthorization: true,
      docExpansion: 'list',
      filter: true,
      tryItOutEnabled: true,
      displayRequestDuration: true,
    },
  });

  process.once('SIGTERM', () => {
    void shutdownTelemetry();
  });
  process.once('SIGINT', () => {
    void shutdownTelemetry();
  });

  await app.listen(port);
}

void bootstrap();
