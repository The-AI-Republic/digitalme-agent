import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  trace,
  metrics,
  type SpanContext,
} from '@opentelemetry/api';
import { BasicTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import type { TelemetryProviders, TelemetryConfig } from './types.js';

const OTEL_ENDPOINT = 'https://otel.airepublic.com/v1';
const METRIC_EXPORT_INTERVAL_MS = 60_000;

let tracerProvider: BasicTracerProvider | undefined;
let meterProvider: MeterProvider | undefined;

/** Per-interaction span context for propagation across async boundaries. */
export const interactionContext = new AsyncLocalStorage<SpanContext>();

export function deriveAgentIdentity(apiKey: string): string {
  return crypto.createHash('sha256').update(apiKey).digest('hex');
}

export function initTelemetry(config: TelemetryConfig): TelemetryProviders {
  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: config.serviceName,
    [ATTR_SERVICE_VERSION]: config.serviceVersion,
    'agent.identity': config.agentIdentityHash,
    'deployment.host': config.deploymentHost ?? 'unknown',
  });

  // Trace provider with OTLP HTTP exporter
  const traceExporter = new OTLPTraceExporter({
    url: `${OTEL_ENDPOINT}/traces`,
  });

  tracerProvider = new BasicTracerProvider({
    resource,
    spanProcessors: [new SimpleSpanProcessor(traceExporter)],
  });

  // Meter provider with periodic OTLP exporter
  const metricExporter = new OTLPMetricExporter({
    url: `${OTEL_ENDPOINT}/metrics`,
  });

  const metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: METRIC_EXPORT_INTERVAL_MS,
  });

  meterProvider = new MeterProvider({
    resource,
    readers: [metricReader],
  });
  metrics.setGlobalMeterProvider(meterProvider);

  const tracer = trace.getTracer(config.serviceName, config.serviceVersion);
  const meter = metrics.getMeter(config.serviceName, config.serviceVersion);

  return { tracer, meter };
}

export async function shutdownTelemetry(): Promise<void> {
  const shutdowns: Promise<void>[] = [];
  if (tracerProvider) {
    shutdowns.push(tracerProvider.shutdown().catch(() => {}));
  }
  if (meterProvider) {
    shutdowns.push(meterProvider.shutdown().catch(() => {}));
  }
  await Promise.all(shutdowns);
  tracerProvider = undefined;
  meterProvider = undefined;
}
