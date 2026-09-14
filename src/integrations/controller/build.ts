/**
 * Assembly for the pull half.
 *
 * The push mappers have their own builder (map/build.ts) because they start
 * from a DecodedRecord and have three timestamps to reconcile. A controller
 * reply has neither problem: it is already JSON, and the controller's clock is
 * a cloud service's clock rather than a switch with broken NTP, so the reported
 * time can simply be believed.
 *
 * What both builders share is the part that must not drift - the id hash, the
 * severity rule, and the plane. Those come from platform/types.ts and
 * classify.ts either way.
 */
import type {
  DeviceId, EventKind, EventObservation, MetricKind, MetricObservation,
  ObservationPlane, PlatformId, SiteId, TenantId, Unit, VendorId,
} from '../../platform/types.ts';
import { dedupeKeyFor, observationId, planeFor } from '../../platform/types.ts';
import { severityForEvent, severityForMetric } from '../classify.ts';

export type ControllerIdentity = {
  vendor: VendorId;
  platform: PlatformId;
  tenantId: TenantId;
};

type CommonArgs = {
  identity: ControllerIdentity;
  deviceId: DeviceId;
  siteId?: SiteId;
  sourceRef: string;
  observedAt: string;
  receivedAt: string;
  attributes?: Record<string, string | number | boolean>;
};

const PLANE: ObservationPlane = planeFor('rest-json');

function base(args: CommonArgs, kind: string) {
  return {
    tenantId: args.identity.tenantId,
    observationId: observationId(
      args.identity.vendor, args.deviceId, args.sourceRef, kind, args.observedAt,
    ),
    vendor: args.identity.vendor,
    platform: args.identity.platform,
    encoding: 'rest-json' as const,
    plane: PLANE,
    deviceId: args.deviceId,
    siteId: args.siteId,
    sourceRef: args.sourceRef,
    observedAt: args.observedAt,
    receivedAt: args.receivedAt,
    attributes: args.attributes ?? {},
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
    dedupeKey: dedupeKeyFor({
      deviceId: common.deviceId,
      kind: args.kind,
      state: args.state,
      observedAt: common.observedAt,
    }),
  };
}
