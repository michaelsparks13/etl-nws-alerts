import { Type, type TSchema } from '@sinclair/typebox';
import type {
    Feature as GeoJSONFeature,
    Geometry,
    Polygon,
    MultiPolygon,
} from 'geojson';

export const SEVERITY_VALUES = ['Extreme', 'Severe', 'Moderate', 'Minor', 'Unknown'] as const;
export type Severity = (typeof SEVERITY_VALUES)[number];

export const SEVERITY_RANK: Record<Severity, number> = {
    Extreme: 4,
    Severe: 3,
    Moderate: 2,
    Minor: 1,
    Unknown: 0,
};

export const SEVERITY_COLOR: Record<Severity, string> = {
    Extreme: '#dc2626',
    Severe: '#ea580c',
    Moderate: '#facc15',
    Minor: '#2563eb',
    Unknown: '#6b7280',
};

export const NWS_API_BASE = 'https://api.weather.gov';
export const DEFAULT_USER_AGENT = '(etl-nws-alerts, https://github.com/dfpc-coe/etl-nws-alerts)';
export const MAX_ZONES_PER_ALERT = 25;

export const InputSchema = Type.Object({
    'NWS_Area': Type.String({
        description: 'Comma-separated NWS area codes (US state/territory codes, e.g. "CO" or "CO,WY,UT,NM"). At least one is required.',
    }),
    'NWS_Events': Type.Optional(Type.Array(Type.String(), {
        description: 'Optional list of event names to include (e.g. "Red Flag Warning", "Fire Weather Watch", "Flash Flood Warning"). Empty/omitted = all events. Case-sensitive — must match the NWS event name exactly.',
        default: [],
    })),
    'NWS_MinimumSeverity': Type.Optional(Type.Union(
        SEVERITY_VALUES.map((v) => Type.Literal(v)),
        {
            description: 'Filter out alerts below this severity. Order is Extreme > Severe > Moderate > Minor > Unknown. Omit for no filter.',
        },
    )),
    'NWS_ResolveZoneGeometry': Type.Boolean({
        description: 'When an alert has null geometry (common for fire-weather zone alerts like Red Flag Warnings), resolve zone polygons via the NWS zones API. Adds API calls — leave off unless your operators need the zone polygons drawn.',
        default: false,
    }),
    'NWS_UserAgent': Type.String({
        description: 'User-Agent string for api.weather.gov. NOAA requires a descriptive UA in the form "(your-org-name, contact@example.com)". See https://www.weather.gov/documentation/services-web-api',
        default: DEFAULT_USER_AGENT,
    }),
    'DEBUG': Type.Boolean({
        description: 'Print verbose logging including the GeoJSON FeatureCollection that would be submitted.',
        default: false,
    }),
});

export const OutputSchema = Type.Object({
    id: Type.String(),
    event: Type.String(),
    headline: Type.Union([Type.String(), Type.Null()]),
    description: Type.Union([Type.String(), Type.Null()]),
    instruction: Type.Union([Type.String(), Type.Null()]),
    severity: Type.String(),
    urgency: Type.String(),
    certainty: Type.String(),
    sent: Type.String(),
    effective: Type.String(),
    onset: Type.Union([Type.String(), Type.Null()]),
    expires: Type.String(),
    ends: Type.Union([Type.String(), Type.Null()]),
    senderName: Type.String(),
    areaDesc: Type.String(),
    messageType: Type.String(),
    affectedZones: Type.Array(Type.String()),
});

export interface NWSAlertProperties {
    id: string;
    event: string;
    headline: string | null;
    description: string | null;
    instruction: string | null;
    severity: string;
    urgency: string;
    certainty: string;
    sent: string;
    effective: string;
    onset: string | null;
    expires: string;
    ends: string | null;
    senderName: string;
    areaDesc: string;
    messageType: string;
    affectedZones: string[];
    parameters?: Record<string, unknown>;
    [k: string]: unknown;
}

export type NWSAlertFeature = GeoJSONFeature<Geometry | null, NWSAlertProperties>;

export interface AlertFilters {
    events?: string[];
    minimumSeverity?: Severity;
}

export interface MapOptions {
    debug?: boolean;
}

export function colorForSeverity(severity: string): string {
    return SEVERITY_COLOR[severity as Severity] ?? SEVERITY_COLOR.Unknown;
}

export function severityRank(severity: string): number {
    return SEVERITY_RANK[severity as Severity] ?? 0;
}

export function shouldIncludeAlert(alert: NWSAlertFeature, filters: AlertFilters): boolean {
    const p = alert.properties;
    if (!p) return false;
    // Cancel messages tell consumers to drop the prior alert; suppress them
    // rather than emit them as features.
    if (p.messageType === 'Cancel') return false;
    if (filters.events && filters.events.length > 0 && !filters.events.includes(p.event)) {
        return false;
    }
    if (filters.minimumSeverity && severityRank(p.severity) < severityRank(filters.minimumSeverity)) {
        return false;
    }
    return true;
}

export function buildCallsign(p: NWSAlertProperties): string {
    const area = p.areaDesc?.split(';')[0]?.trim() ?? '';
    return area ? `${p.event} — ${area}` : p.event;
}

export function buildRemarks(p: NWSAlertProperties): string {
    const parts: string[] = [];
    if (p.headline) parts.push(p.headline);
    if (p.description) parts.push('', p.description);
    if (p.instruction) parts.push('', 'Instruction:', p.instruction);
    parts.push('', `Severity: ${p.severity}    Urgency: ${p.urgency}    Certainty: ${p.certainty}`);
    if (p.senderName) parts.push(`Sender: ${p.senderName}`);
    return parts.join('\n');
}

export function combineZoneGeometries(zoneFeatures: GeoJSONFeature[]): Polygon | MultiPolygon | null {
    const coords: Polygon['coordinates'][] = [];
    for (const z of zoneFeatures) {
        if (!z.geometry) continue;
        if (z.geometry.type === 'Polygon') {
            coords.push((z.geometry as Polygon).coordinates);
        } else if (z.geometry.type === 'MultiPolygon') {
            for (const c of (z.geometry as MultiPolygon).coordinates) coords.push(c);
        }
    }
    if (coords.length === 0) return null;
    if (coords.length === 1) return { type: 'Polygon', coordinates: coords[0] };
    return { type: 'MultiPolygon', coordinates: coords };
}

/**
 * Map a raw NWS alert GeoJSON Feature to a CloudTAK-shaped output Feature.
 * Returns null when the alert has no resolvable geometry — callers should
 * have already resolved zone polygons (if enabled) before invoking this.
 */
export function mapAlertToFeature(
    alert: NWSAlertFeature,
    opts: MapOptions = {},
): GeoJSONFeature | null {
    const p = alert.properties;
    if (!p) return null;
    if (!alert.geometry) {
        if (opts.debug) console.log(`[nws] skip ${p.id}: no geometry`);
        return null;
    }
    const color = colorForSeverity(p.severity);
    const metadata: Record<string, unknown> = {
        id: p.id,
        event: p.event,
        headline: p.headline,
        description: p.description,
        instruction: p.instruction,
        severity: p.severity,
        urgency: p.urgency,
        certainty: p.certainty,
        sent: p.sent,
        effective: p.effective,
        onset: p.onset,
        expires: p.expires,
        ends: p.ends,
        senderName: p.senderName,
        areaDesc: p.areaDesc,
        messageType: p.messageType,
        affectedZones: p.affectedZones,
    };

    return {
        id: `nws-${p.id}`,
        type: 'Feature',
        geometry: alert.geometry,
        properties: {
            callsign: buildCallsign(p),
            remarks: buildRemarks(p),
            start: p.onset || p.effective,
            stale: p.ends || p.expires,
            stroke: color,
            'stroke-opacity': 0.85,
            'stroke-width': 2,
            fill: color,
            'fill-opacity': 0.25,
            metadata,
        },
    };
}

/**
 * Split a MultiPolygon feature into one feature per polygon, suffixing the id
 * with `-N`. Mirrors the convention used in etl-cotrip-incidents and
 * etl-cotrip-weather. Non-MultiPolygon features pass through unchanged.
 */
export function splitMultiPolygon(feature: GeoJSONFeature): GeoJSONFeature[] {
    if (!feature.geometry || feature.geometry.type !== 'MultiPolygon') return [feature];
    const mp = feature.geometry as MultiPolygon;
    return mp.coordinates.map((coords, i) => ({
        ...feature,
        id: feature.id ? `${feature.id}-${i}` : undefined,
        geometry: { type: 'Polygon', coordinates: coords } as Polygon,
    }));
}

export type InputSchemaType = typeof InputSchema;
export type { TSchema };
