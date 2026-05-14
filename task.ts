import ETL, {
    type Event,
    SchemaType,
    handler as internal,
    local,
    DataFlowType,
    InvocationType,
} from '@tak-ps/etl';
import { type Static, type TSchema } from '@sinclair/typebox';
import type { Feature as GeoJSONFeature } from 'geojson';

import {
    InputSchema,
    OutputSchema,
    NWS_API_BASE,
    MAX_ZONES_PER_ALERT,
    type NWSAlertFeature,
    type Severity,
    combineZoneGeometries,
    mapAlertToFeature,
    shouldIncludeAlert,
    splitMultiPolygon,
} from './lib.ts';

interface NWSFeatureCollection {
    type: 'FeatureCollection';
    features: NWSAlertFeature[];
    title?: string;
    updated?: string;
}

export default class Task extends ETL {
    static name = 'etl-nws-alerts';
    static flow = [DataFlowType.Incoming];
    static invocation = [InvocationType.Schedule];

    async schema(
        type: SchemaType = SchemaType.Input,
        flow: DataFlowType = DataFlowType.Incoming,
    ): Promise<TSchema> {
        if (flow === DataFlowType.Incoming) {
            if (type === SchemaType.Input) return InputSchema;
            return OutputSchema;
        }
        return InputSchema;
    }

    async control(): Promise<void> {
        const env = await this.env(InputSchema);
        const debug = env.DEBUG ?? false;
        const userAgent = env.NWS_UserAgent;

        const url = new URL('/alerts/active', NWS_API_BASE);
        url.searchParams.set('area', env.NWS_Area);
        if (env.NWS_Events && env.NWS_Events.length === 1) {
            // NWS /alerts/active accepts a single `event` filter; multiple
            // values are filtered client-side below.
            url.searchParams.set('event', env.NWS_Events[0]);
        }

        if (debug) console.log(`[nws] GET ${url.toString()}`);

        const resp = await fetch(url, {
            headers: {
                'User-Agent': userAgent,
                'Accept': 'application/geo+json',
            },
        });
        if (!resp.ok) {
            throw new Error(`NWS /alerts/active returned ${resp.status} ${resp.statusText}`);
        }
        const fc = (await resp.json()) as NWSFeatureCollection;
        if (debug) console.log(`[nws] received ${fc.features?.length ?? 0} active alerts`);

        const filters = {
            events: env.NWS_Events,
            minimumSeverity: env.NWS_MinimumSeverity as Severity | undefined,
        };

        const errs: string[] = [];
        const outFeatures: GeoJSONFeature[] = [];

        for (const alert of fc.features ?? []) {
            if (!shouldIncludeAlert(alert, filters)) continue;

            if (!alert.geometry && env.NWS_ResolveZoneGeometry) {
                try {
                    const geometry = await this.resolveZoneGeometry(
                        alert.properties.affectedZones ?? [],
                        userAgent,
                        debug,
                    );
                    if (geometry) alert.geometry = geometry;
                } catch (err) {
                    errs.push(`${alert.properties.id}: zone resolve failed: ${(err as Error).message}`);
                }
            }

            const mapped = mapAlertToFeature(alert, { debug });
            if (!mapped) continue;

            for (const f of splitMultiPolygon(mapped)) outFeatures.push(f);
        }

        const outFC = { type: 'FeatureCollection' as const, features: outFeatures };

        if (debug) {
            console.log(`[nws] submitting ${outFeatures.length} features`);
            console.log(JSON.stringify(outFC, null, 2));
        }

        if (process.env.DRY_RUN) {
            console.log('[nws] DRY_RUN set — skipping submit. FeatureCollection follows:');
            console.log(JSON.stringify(outFC, null, 2));
        } else {
            // @tak-ps/etl's submit chunks at 49MB and POSTs to /api/layer/{ETL_LAYER}/cot
            // The cast is needed because node-cot's InputFeatureCollection has extra
            // TAK-specific constraints we satisfy at runtime via flat style properties.
            await this.submit(outFC as unknown as Parameters<ETL['submit']>[0]);
        }

        if (errs.length > 0) {
            throw new Error(`etl-nws-alerts encountered ${errs.length} per-alert errors:\n${errs.join('\n')}`);
        }
    }

    private async resolveZoneGeometry(
        zoneUrls: string[],
        userAgent: string,
        debug: boolean,
    ): Promise<GeoJSONFeature['geometry'] | null> {
        if (zoneUrls.length === 0) return null;
        const capped = zoneUrls.slice(0, MAX_ZONES_PER_ALERT);
        if (debug && zoneUrls.length > MAX_ZONES_PER_ALERT) {
            console.log(`[nws] capping zones from ${zoneUrls.length} to ${MAX_ZONES_PER_ALERT}`);
        }
        const features: GeoJSONFeature[] = [];
        for (const zUrl of capped) {
            const r = await fetch(zUrl, {
                headers: {
                    'User-Agent': userAgent,
                    'Accept': 'application/geo+json',
                },
            });
            if (!r.ok) {
                if (debug) console.log(`[nws] zone fetch ${zUrl} -> ${r.status}`);
                continue;
            }
            features.push((await r.json()) as GeoJSONFeature);
        }
        return combineZoneGeometries(features);
    }
}

// Export pure helpers for downstream consumers / tests
export {
    InputSchema,
    OutputSchema,
    mapAlertToFeature,
    shouldIncludeAlert,
    combineZoneGeometries,
} from './lib.ts';

export type Input = Static<typeof InputSchema>;
export type Output = Static<typeof OutputSchema>;

await local(await Task.init(import.meta.url), import.meta.url);
export async function handler(event: Event = {}) {
    return await internal(await Task.init(import.meta.url), event);
}
