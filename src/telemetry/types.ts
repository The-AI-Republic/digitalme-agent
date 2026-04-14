import type { Tracer, Meter } from '@opentelemetry/api';

export interface TelemetryProviders {
  tracer: Tracer;
  meter: Meter;
}

export interface TelemetryConfig {
  serviceName: string;
  serviceVersion: string;
  agentIdentityHash: string;
  deploymentHost?: string;
}
