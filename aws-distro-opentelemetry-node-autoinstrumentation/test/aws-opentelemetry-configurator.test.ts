// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Span, TraceFlags, Tracer } from '@opentelemetry/api';
import { OTLPMetricExporter as OTLPGrpcOTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { OTLPMetricExporter as OTLPHttpOTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { PushMetricExporter } from '@opentelemetry/sdk-metrics';
import { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import {
  AlwaysOnSampler,
  NodeTracerProvider,
  ParentBasedSampler,
  Sampler,
  SpanExporter,
} from '@opentelemetry/sdk-trace-node';
import * as assert from 'assert';
import expect from 'expect';
import * as sinon from 'sinon';
import { AlwaysRecordSampler } from '../src/always-record-sampler';
import { AttributePropagatingSpanProcessor } from '../src/attribute-propagating-span-processor';
import { AwsMetricAttributesSpanExporter } from '../src/aws-metric-attributes-span-exporter';
import {
  ApplicationSignalsExporterProvider,
  AwsOpentelemetryConfigurator,
  AwsSpanProcessorProvider,
  customBuildSamplerFromEnv,
} from '../src/aws-opentelemetry-configurator';
import { AwsSpanMetricsProcessor } from '../src/aws-span-metrics-processor';
import { setAwsDefaultEnvironmentVariables } from '../src/register';
import { AwsXRayRemoteSampler } from '../src/sampler/aws-xray-remote-sampler';
import { AwsXraySamplingClient } from '../src/sampler/aws-xray-sampling-client';
import { GetSamplingRulesResponse } from '../src/sampler/remote-sampler.types';

// Tests AwsOpenTelemetryConfigurator after running Environment Variable setup in register.ts
describe('AwsOpenTelemetryConfiguratorTest', () => {
  let awsOtelConfigurator: AwsOpentelemetryConfigurator;

  // setUpClass
  before(() => {
    // Run environment setup in register.ts, then validate expected env values.
    setAwsDefaultEnvironmentVariables();
    validateConfiguratorEnviron();

    // Overwrite exporter configs to keep tests clean, set sampler configs for tests
    process.env.OTEL_TRACES_EXPORTER = 'none';
    process.env.OTEL_METRICS_EXPORTER = 'none';
    process.env.OTEL_LOGS_EXPORTER = 'none';
    process.env.OTEL_TRACES_SAMPLER = 'traceidratio';
    process.env.OTEL_TRACES_SAMPLER_ARG = '0.01';

    // Create configurator
    awsOtelConfigurator = new AwsOpentelemetryConfigurator([]);
  });

  // The probability of this passing once without correct IDs is low, 20 times is inconceivable.
  it('ProvideGenerateXrayIdsTest', () => {
    const tracerProvider: NodeTracerProvider = new NodeTracerProvider(awsOtelConfigurator.configure());
    tracerProvider.addSpanProcessor(
      AttributePropagatingSpanProcessor.create((span: ReadableSpan) => '', 'spanNameKey', ['testKey1', 'testKey2'])
    );
    for (let _: number = 0; _ < 20; _++) {
      const tracer: Tracer = tracerProvider.getTracer('test');
      const startTimeSec: number = Math.floor(new Date().getTime() / 1000.0);
      const span: Span = tracer.startSpan('test');
      const traceId: string = span.spanContext().traceId;
      const traceId4ByteHex: string = traceId.substring(0, 8);
      const traceId4ByteNumber: number = Number(`0x${traceId4ByteHex}`);
      expect(traceId4ByteNumber).toBeGreaterThanOrEqual(startTimeSec);
    }
  });

  // Sanity check that the trace ID ratio sampler works fine with the x-ray generator.
  it('TraceIdRatioSamplerTest', () => {
    process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED = 'True';
    const tracerProvider: NodeTracerProvider = new NodeTracerProvider(awsOtelConfigurator.configure());
    delete process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED;

    tracerProvider.addSpanProcessor(
      AttributePropagatingSpanProcessor.create((span: ReadableSpan) => '', 'spanNameKey', ['testKey1', 'testKey2'])
    );
    for (let _: number = 0; _ < 20; _++) {
      const numSpans: number = 100000;
      let numSampled: number = 0;
      const tracer: Tracer = tracerProvider.getTracer('test');
      for (let __: number = 0; __ < numSpans; __++) {
        const span: Span = tracer.startSpan('test');
        if (span.spanContext().traceFlags & TraceFlags.SAMPLED) {
          numSampled += 1;
        }
        span.end();
      }
      // Configured for 1%, confirm there are at most 5% to account for randomness and reduce test flakiness.
      expect(0.05).toBeGreaterThan(numSampled / numSpans);
    }
  });

  it('ImportDefaultSamplerWhenEnvVarIsNotSetTest', () => {
    delete process.env.OTEL_TRACES_SAMPLER;
    const defaultSampler: Sampler = customBuildSamplerFromEnv(Resource.empty());

    expect(defaultSampler).not.toBeUndefined();
    expect(defaultSampler.toString()).toEqual(new ParentBasedSampler({ root: new AlwaysOnSampler() }).toString());
  });

  it('ImportXRaySamplerWhenEnvVarIsSetTest', () => {
    delete process.env.OTEL_TRACES_SAMPLER;
    process.env.OTEL_TRACES_SAMPLER = 'xray';
    const sampler = customBuildSamplerFromEnv(Resource.empty());

    expect(sampler).toBeInstanceOf(AwsXRayRemoteSampler);
    expect((sampler as AwsXRayRemoteSampler).getAwsProxyEndpoint()).toEqual('http://localhost:2000');
    expect((sampler as AwsXRayRemoteSampler).getRulePollingIntervalMillis()).toEqual(300000); // ms

    clearInterval((sampler as any).rulePoller);
    clearInterval((sampler as any).targetPoller);
  });

  it('ImportXRaySamplerWhenSamplerArgsSet', () => {
    delete process.env.OTEL_TRACES_SAMPLER;

    process.env.OTEL_TRACES_SAMPLER = 'xray';
    process.env.OTEL_TRACES_SAMPLER_ARG = 'endpoint=http://asdfghjkl:2000,polling_interval=600'; // seconds
    const sampler = customBuildSamplerFromEnv(Resource.empty());

    expect(sampler).toBeInstanceOf(AwsXRayRemoteSampler);
    expect((sampler as AwsXRayRemoteSampler).getAwsProxyEndpoint()).toEqual('http://asdfghjkl:2000');
    expect((sampler as AwsXRayRemoteSampler).getRulePollingIntervalMillis()).toEqual(600000); // ms
    expect(((sampler as AwsXRayRemoteSampler).getSamplingClient() as any).getSamplingRulesEndpoint).toEqual(
      'http://asdfghjkl:2000/GetSamplingRules'
    );
    expect(((sampler as AwsXRayRemoteSampler).getSamplingClient() as any).samplingTargetsEndpoint).toEqual(
      'http://asdfghjkl:2000/SamplingTargets'
    );

    clearInterval((sampler as any).rulePoller);
    clearInterval((sampler as any).targetPoller);
  });

  it('ImportXRaySamplerWithInvalidPollingIntervalSet', () => {
    delete process.env.OTEL_TRACES_SAMPLER;
    delete process.env.OTEL_TRACES_SAMPLER_ARG;

    process.env.OTEL_TRACES_SAMPLER = 'xray';
    process.env.OTEL_TRACES_SAMPLER_ARG = 'endpoint=http://asdfghjkl:2000,polling_interval=FOOBAR';

    const sampler = customBuildSamplerFromEnv(Resource.empty());

    expect(sampler).toBeInstanceOf(AwsXRayRemoteSampler);
    expect((sampler as AwsXRayRemoteSampler).getAwsProxyEndpoint()).toEqual('http://asdfghjkl:2000');
    expect((sampler as AwsXRayRemoteSampler).getRulePollingIntervalMillis()).toEqual(300000); // default value
    expect(((sampler as AwsXRayRemoteSampler).getSamplingClient() as any).getSamplingRulesEndpoint).toEqual(
      'http://asdfghjkl:2000/GetSamplingRules'
    );
    expect(((sampler as AwsXRayRemoteSampler).getSamplingClient() as any).samplingTargetsEndpoint).toEqual(
      'http://asdfghjkl:2000/SamplingTargets'
    );

    clearInterval((sampler as any).rulePoller);
    clearInterval((sampler as any).targetPoller);
  });

  // test_import_xray_sampler_with_invalid_environment_arguments
  it('ImportXRaySamplerWithInvalidURLSet', () => {
    delete process.env.OTEL_TRACES_SAMPLER;
    delete process.env.OTEL_TRACES_SAMPLER_ARG;

    process.env.OTEL_TRACES_SAMPLER = 'xray';
    process.env.OTEL_TRACES_SAMPLER_ARG = 'endpoint=ht-tp:/-/-a-a-:2-2-2,polling_interval=600';

    const tmp = (AwsXraySamplingClient.prototype as any).makeSamplingRequest;
    (AwsXraySamplingClient.prototype as any).makeSamplingRequest = (
      endpoint: string,
      callback: (responseObject: GetSamplingRulesResponse) => void
    ) => {
      callback({});
    };

    const sampler = customBuildSamplerFromEnv(Resource.empty());

    expect(sampler).toBeInstanceOf(AwsXRayRemoteSampler);
    expect((sampler as AwsXRayRemoteSampler).getAwsProxyEndpoint()).toEqual('ht-tp:/-/-a-a-:2-2-2');
    expect((sampler as AwsXRayRemoteSampler).getRulePollingIntervalMillis()).toEqual(600000);
    expect(((sampler as AwsXRayRemoteSampler).getSamplingClient() as any).getSamplingRulesEndpoint).toEqual(
      'ht-tp:/-/-a-a-:2-2-2/GetSamplingRules'
    );
    expect(((sampler as AwsXRayRemoteSampler).getSamplingClient() as any).samplingTargetsEndpoint).toEqual(
      'ht-tp:/-/-a-a-:2-2-2/SamplingTargets'
    );

    (AwsXraySamplingClient.prototype as any).makeSamplingRequest = tmp;
  });

  it('IsApplicationSignalsEnabledTest', () => {
    process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED = 'True';
    expect(AwsOpentelemetryConfigurator.isApplicationSignalsEnabled()).toBeTruthy();
    delete process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED;

    process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED = 'False';
    expect(AwsOpentelemetryConfigurator.isApplicationSignalsEnabled()).toBeFalsy();
    delete process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED;
    expect(AwsOpentelemetryConfigurator.isApplicationSignalsEnabled()).toBeFalsy();
  });

  it('CustomizeSamplerTest', () => {
    const mockSampler: Sampler = sinon.createStubInstance(AlwaysOnSampler);
    let customizedSampler: Sampler = AwsOpentelemetryConfigurator.customizeSampler(mockSampler);
    expect(mockSampler).toEqual(customizedSampler);

    process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED = 'True';
    customizedSampler = AwsOpentelemetryConfigurator.customizeSampler(mockSampler);
    expect(mockSampler).not.toEqual(customizedSampler);
    expect(customizedSampler).toBeInstanceOf(AlwaysRecordSampler);
    expect(mockSampler).toEqual((customizedSampler as any).rootSampler);
    delete process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED;
  });

  it('CustomizeExporterTest', () => {
    const mockExporter: SpanExporter = sinon.createStubInstance(AwsMetricAttributesSpanExporter);
    let customizedExporter: SpanExporter = AwsSpanProcessorProvider.customizeSpanExporter(
      mockExporter,
      Resource.empty()
    );
    expect(mockExporter).toEqual(customizedExporter);

    process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED = 'True';
    customizedExporter = AwsSpanProcessorProvider.customizeSpanExporter(mockExporter, Resource.empty());
    expect(mockExporter).not.toEqual(customizedExporter);
    expect(customizedExporter).toBeInstanceOf(AwsMetricAttributesSpanExporter);
    expect(mockExporter).toEqual((customizedExporter as any).delegate);
    delete process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED;
  });

  it('CustomizeSpanProcessorsTest', () => {
    delete process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED;
    const spanProcessors: SpanProcessor[] = [];
    AwsOpentelemetryConfigurator.customizeSpanProcessors(spanProcessors, Resource.empty());
    expect(spanProcessors.length).toEqual(0);

    process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED = 'True';
    AwsOpentelemetryConfigurator.customizeSpanProcessors(spanProcessors, Resource.empty());
    expect(spanProcessors.length).toEqual(2);
    const firstProcessor: SpanProcessor = spanProcessors[0];
    expect(firstProcessor).toBeInstanceOf(AttributePropagatingSpanProcessor);
    const secondProcessor: SpanProcessor = spanProcessors[1];
    expect(secondProcessor).toBeInstanceOf(AwsSpanMetricsProcessor);
    delete process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED;

    try {
      process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED = 'True';
      process.env.OTEL_METRIC_EXPORT_INTERVAL = undefined;
      AwsOpentelemetryConfigurator.customizeSpanProcessors(spanProcessors, Resource.empty());
      process.env.OTEL_METRIC_EXPORT_INTERVAL = '123abc';
      AwsOpentelemetryConfigurator.customizeSpanProcessors(spanProcessors, Resource.empty());
      process.env.OTEL_METRIC_EXPORT_INTERVAL = '!@#$%^&*()';
      AwsOpentelemetryConfigurator.customizeSpanProcessors(spanProcessors, Resource.empty());
      process.env.OTEL_METRIC_EXPORT_INTERVAL = '40000';
      AwsOpentelemetryConfigurator.customizeSpanProcessors(spanProcessors, Resource.empty());
    } catch (e: any) {
      assert.fail(`AwsOpentelemetryConfigurator.customizeSpanProcessors() has incorrectly thrown error: ${e}`);
    } finally {
      delete process.env.OTEL_METRIC_EXPORT_INTERVAL;
      delete process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED;
    }
  });

  it('ApplicationSignalsExporterProviderTest', () => {
    // Check default protocol - HTTP, as specified by aws-distro-opentelemetry-node-autoinstrumentation's register.ts.
    let exporter: PushMetricExporter = ApplicationSignalsExporterProvider.Instance.createExporter();
    expect(exporter).toBeInstanceOf(OTLPHttpOTLPMetricExporter);
    expect('http://localhost:4316/v1/metrics').toEqual((exporter as any)._otlpExporter.url);

    // Overwrite protocol to gRPC.
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = 'grpc';
    exporter = ApplicationSignalsExporterProvider.Instance.createExporter();
    expect(exporter).toBeInstanceOf(OTLPGrpcOTLPMetricExporter);
    expect('localhost:4315').toEqual((exporter as any)._otlpExporter.url);

    // Overwrite protocol back to HTTP.
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = 'http/protobuf';
    exporter = ApplicationSignalsExporterProvider.Instance.createExporter();
    expect(exporter).toBeInstanceOf(OTLPHttpOTLPMetricExporter);
    expect('http://localhost:4316/v1/metrics').toEqual((exporter as any)._otlpExporter.url);
  });

  function validateConfiguratorEnviron() {
    // Set by register.ts
    expect('http/protobuf').toEqual(process.env.OTEL_EXPORTER_OTLP_PROTOCOL);
    expect('xray,tracecontext,b3,b3multi').toEqual(process.env.OTEL_PROPAGATORS);

    // Not set
    expect(undefined).toEqual(process.env.OTEL_TRACES_SAMPLER);
    expect(undefined).toEqual(process.env.OTEL_TRACES_SAMPLER_ARG);
    expect(undefined).toEqual(process.env.OTEL_TRACES_EXPORTER);
    expect(undefined).toEqual(process.env.OTEL_METRICS_EXPORTER);
  }
});