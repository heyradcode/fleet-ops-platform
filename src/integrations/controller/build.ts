/**
 * Assembly, so that a connector's normalise() is only ever a translation table.
 *
 * Every mapping has to hash an id, derive a severity and - for events - compute
 * a dedupe key. None of that is vendor knowledge, and having it inline in each
 * connector is how the files drift: one of them hashes a different tuple, and
 * the resulting bug shows up months later as records that mysteriously fail to
 * deduplicate.
 *
 * `plane` IS A REQUIRED ARGUMENT, and that is the point of this file as much as
 * the hashing is. It used to be derived from the encoding, which was correct
 * while syslog meant "the box said so" and REST meant "its cloud said so".
 * Now every feed is cloud HTTP, so deriving it would mark the entire platform
 * `controller`, corroboration would never be satisfiable from vendor data, and
 * every alarm would be held back. Making it a parameter with no default means
 * a new connector cannot compile until its author has decided, per endpoint,
 * where the knowledge actually came from.
 */
import type {
  DeviceId, EventKind, EventObservation, MetricKind, MetricObservation,
  ObservationPlane, PlatformId, SiteId, TenantId, Unit, VendorId,
} from '../../platform/types.ts';
import { dedupeKeyFor, observationId } from '../../platform/types.ts';
import { severityForEvent, severityForMetric } from '../classify.ts';
import type { Encoding } from '../../platform/types.ts';

export type ControllerIdentity = {
  vendor: VendorId;
  platform: PlatformId;
  tenantId: TenantId;
};

type CommonArgs = {
  identity: ControllerIdentity;
  /** Where this knowledge came from. No default, deliberately. */
  plane: ObservationPlane;
  /** How it reached us. Never used to infer the plane. */
  encoding: Encoding;
  deviceId: DeviceId;
  siteId?: SiteId;
  sourceRef: string;
  observedAt: string;
  receivedAt: string;
  attributes?: Record<string, string | number | boolean>;
};

function base(args: CommonArgs, kind: string) {
  return {
    tenantId: args.identity.tenantId,
    observationId: observationId(
      args.identity.vendor, args.deviceId, args.sourceRef, kind, args.observedAt,
    ),
    vendor: args.identity.vendor,
    platform: args.identity.platform,
    encoding: args.encoding,
    plane: args.plane,
    deviceId: args.deviceId,
    siteId: args.siteId,
    sourceRef: args.sourceRef,
    observedAt: args.observedAt,
    receivedAt: args.receivedAt,
    attributes: { ...args.attributes, plane: args.plane },
  };
}

export function controllerMetric(args: CommonArgs & {
  kind: MetricKind; value: number; unit: Unit;
}): MetricObservation {
  return {
    ...base(args, args.kind),
    class: 'metric',
    kind: args.kind,
    value: args.value,
    unit: args.unit,
    severity: severityForMetric(args.kind, args.value),
  };
}

export function controllerEvent(args: CommonArgs & {
  kind: EventKind; state: string; message: string;
}): EventObservation {
  const common = base(args, args.kind);
  return {
    ...common,
    class: 'event',
    kind: args.kind,
    state: args.state,
    message: args.message,
    severity: severityForEvent(args.kind, args.state),
    // NOTE the dedupe key does not include the plane or the encoding. That is
    // what lets a webhook delivery and the poll that later re-reports the same
    // event collapse into one record - which is the whole reason the poll can
    // safely overlap its watermark.
    dedupeKey: dedupeKeyFor({
      deviceId: common.deviceId,
      kind: args.kind,
      state: args.state,
      observedAt: common.observedAt,
    }),
  };
}
