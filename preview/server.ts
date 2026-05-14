// Local preview server — runs the actual ETL transformation pipeline
// against the live NWS API and serves the resulting FeatureCollection
// to a Leaflet map. Not part of the deployed Lambda; dev-only.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type {
    Feature as GeoJSONFeature,
    FeatureCollection as GeoJSONFeatureCollection,
    Polygon,
    MultiPolygon,
    Geometry,
} from 'geojson';

import {
    NWS_API_BASE,
    DEFAULT_USER_AGENT,
    MAX_ZONES_PER_ALERT,
    combineZoneGeometries,
    mapAlertToFeature,
    shouldIncludeAlert,
    splitMultiPolygon,
    type NWSAlertFeature,
    type Severity,
} from '../lib.ts';

const PORT = Number(process.env.PORT ?? 3000);
const HERE = dirname(fileURLToPath(import.meta.url));
const USER_AGENT = process.env.NWS_USER_AGENT ?? DEFAULT_USER_AGENT;

async function fetchActiveAlerts(area: string): Promise<GeoJSONFeatureCollection> {
    const url = new URL('/alerts/active', NWS_API_BASE);
    url.searchParams.set('area', area);
    const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/geo+json' },
    });
    if (!res.ok) throw new Error(`NWS /alerts/active → HTTP ${res.status}`);
    return (await res.json()) as GeoJSONFeatureCollection;
}

const zoneCache = new Map<string, Geometry | null>();
async function fetchZoneGeometry(zoneUrl: string): Promise<Geometry | null> {
    if (zoneCache.has(zoneUrl)) return zoneCache.get(zoneUrl) ?? null;
    try {
        const r = await fetch(zoneUrl, {
            headers: { 'User-Agent': USER_AGENT, Accept: 'application/geo+json' },
        });
        if (!r.ok) {
            zoneCache.set(zoneUrl, null);
            return null;
        }
        const body = (await r.json()) as GeoJSONFeature;
        const g = body.geometry ?? null;
        zoneCache.set(zoneUrl, g);
        return g;
    } catch {
        zoneCache.set(zoneUrl, null);
        return null;
    }
}

async function resolveZoneGeometryFor(alert: NWSAlertFeature): Promise<Polygon | MultiPolygon | null> {
    const urls = (alert.properties.affectedZones ?? []).slice(0, MAX_ZONES_PER_ALERT);
    const zoneFeatures: GeoJSONFeature[] = [];
    for (const u of urls) {
        const g = await fetchZoneGeometry(u);
        if (g) zoneFeatures.push({ type: 'Feature', geometry: g, properties: {} } as GeoJSONFeature);
    }
    return combineZoneGeometries(zoneFeatures);
}

interface PreviewParams {
    area: string;
    events: string[];
    minimumSeverity?: Severity;
    resolveZones: boolean;
}

function parseParams(url: URL): PreviewParams {
    const events = (url.searchParams.get('events') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    const min = url.searchParams.get('minSeverity') as Severity | null;
    return {
        area: url.searchParams.get('area') ?? 'CO',
        events,
        minimumSeverity: min ?? undefined,
        resolveZones: url.searchParams.get('resolveZones') === '1',
    };
}

async function buildPreviewFeatureCollection(params: PreviewParams) {
    const upstream = await fetchActiveAlerts(params.area);
    const filters = { events: params.events, minimumSeverity: params.minimumSeverity };

    let nullGeomCount = 0;
    let zoneResolvedCount = 0;
    const out: GeoJSONFeature[] = [];

    for (const alert of (upstream.features ?? []) as NWSAlertFeature[]) {
        if (!shouldIncludeAlert(alert, filters)) continue;

        if (!alert.geometry) {
            nullGeomCount++;
            if (params.resolveZones) {
                const resolved = await resolveZoneGeometryFor(alert);
                if (resolved) {
                    alert.geometry = resolved;
                    zoneResolvedCount++;
                }
            }
        }

        const mapped = mapAlertToFeature(alert);
        if (!mapped) continue;
        for (const f of splitMultiPolygon(mapped)) out.push(f);
    }

    return {
        type: 'FeatureCollection' as const,
        features: out,
        metadata: {
            upstreamCount: upstream.features?.length ?? 0,
            keptCount: out.length,
            nullGeomCount,
            zoneResolvedCount,
            params,
            generatedAt: new Date().toISOString(),
        },
    };
}

async function send(res: import('node:http').ServerResponse, status: number, body: string, contentType: string) {
    res.writeHead(status, {
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
    });
    res.end(body);
}

createServer(async (req, res) => {
    try {
        const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
        if (url.pathname === '/' || url.pathname === '/index.html') {
            const html = await readFile(join(HERE, 'index.html'), 'utf8');
            return send(res, 200, html, 'text/html; charset=utf-8');
        }
        if (url.pathname === '/alerts.geojson') {
            const params = parseParams(url);
            const fc = await buildPreviewFeatureCollection(params);
            return send(res, 200, JSON.stringify(fc), 'application/geo+json');
        }
        if (url.pathname === '/healthz') {
            return send(res, 200, JSON.stringify({ ok: true }), 'application/json');
        }
        return send(res, 404, JSON.stringify({ error: 'not found' }), 'application/json');
    } catch (err) {
        return send(res, 500, JSON.stringify({ error: (err as Error).message }), 'application/json');
    }
}).listen(PORT, () => {
    console.log(`[preview] http://localhost:${PORT}`);
    console.log(`[preview] User-Agent: ${USER_AGENT}`);
});
