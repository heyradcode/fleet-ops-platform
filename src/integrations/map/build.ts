/**
 * Assembly, so that a mapper is only ever a lookup table.
 *
 * Every mapper has to reconcile three timestamps, hash an id, derive a
 * severity, attach the site and - for events - compute a dedupe key. None of
 * that is vendor knowledge, and having it inline in each mapper is how the
 * files drift: one of them forgets the skew check, or hashes a different tuple,
 * and the resulting bug only shows up as records that mysteriously fail to
 * correlate months later.
 *
 * Hoisting it here leaves each mapper as what it should be - a translation from
 * this vendor's vocabulary to ours - and makes "add a vendor" genuinely a
 * mapping table rather than a new subsystem.
 */
import type {
  EventKind, EventObservation, MetricKind, MetricObservation,
  PlatformId, Unit, VendorId,
} from '../../platform/types.ts';
import {
  dedupeKeyFor, observationId, planeFor, resolveObservedAt,
} from '../../platform/types.ts';
import { severityForEvent, severityForMetric } from '../classify.ts';
import type { DecodedRecord, MapContext } from '../wire.ts';

export type MapperIdentity = { vendor: VendorId; platform: PlatformId };

type CommonArgs = {
  rec: DecodedRecord;
  ctx: MapContext;
  identity: MapperIdentity;
  sourceRef: string;
  interfaceId?: string;
  attributes?: Record<string, string | number | boolean>;
};

function base(args: CommonArgs, kind: string) {
  const time = resolveObservedAt(args.rec.receivedAt, args.rec.claimedTime);

  return {
    tenantId: args.ctx.tenantId,
    observationId: observationId(
      args.identity.vendor, args.ctx.deviceId, args.sourceRef, kind, time.observedAt,
    ),
    vendor: args.identity.vendor,
    platform: args.identity.platform,
    encoding: args.rec.encoding,
    // Derived from the encoding rather than declared per mapper. Getting this
    // wrong is silent and expensive: label a controller feed 'device' and the
    // corroboration rule starts counting one witness as two.
    plane: planeFor(args.rec.encoding),
    deviceId: args.ctx.deviceId,
    interfaceId: args.interfaceId,
    siteId: args.ctx.siteId,
    sourceRef: args.sourceRef,
    ...time,
    // The vendor's own tag travels with the record. Nothing reads it for a
    // decision, but it is the first thing anyone wants when asking why a
    // particular line was interpreted the way it was.
    attributes: { tag: args.rec.tag, ...args.attributes },
  };
}

export function buildEvent(args: CommonArgs & {
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
    dedupeKey: dedupeKeyFor({
      deviceId: common.deviceId,
      interfaceId: common.interfaceId,
      kind: args.kind,
      state: args.state,
      observedAt: common.observedAt,
    }),
  };
}

export function buildMetric(args: CommonArgs & {
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
