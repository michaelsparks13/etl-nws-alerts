import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Feature as GeoJSONFeature, Polygon, MultiPolygon } from 'geojson';

import {
    combineZoneGeometries,
    mapAlertToFeature,
    splitMultiPolygon,
    type NWSAlertFeature,
} from '../lib.ts';

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const load = <T>(name: string): T => JSON.parse(readFileSync(join(fixtureDir, name), 'utf8'));

test('combineZoneGeometries: returns null on empty input', () => {
    assert.equal(combineZoneGeometries([]), null);
});

test('combineZoneGeometries: single zone returns a Polygon, two zones return a MultiPolygon', () => {
    const zoneA = load<GeoJSONFeature>('zone-coz220.json');
    const zoneB = load<GeoJSONFeature>('zone-coz222.json');

    const one = combineZoneGeometries([zoneA]);
    assert.equal(one?.type, 'Polygon');
    assert.deepEqual(
        (one as Polygon).coordinates,
        (zoneA.geometry as Polygon).coordinates,
    );

    const two = combineZoneGeometries([zoneA, zoneB]);
    assert.equal(two?.type, 'MultiPolygon');
    assert.equal((two as MultiPolygon).coordinates.length, 2);
});

test('null-geometry alert + zone resolution + mapping = single mapped feature with the combined geometry', () => {
    const alert = load<NWSAlertFeature>('red-flag-warning.json');
    const zoneA = load<GeoJSONFeature>('zone-coz220.json');
    const zoneB = load<GeoJSONFeature>('zone-coz222.json');

    // Simulate the control() resolution step
    const combined = combineZoneGeometries([zoneA, zoneB]);
    assert.ok(combined);
    alert.geometry = combined;

    const mapped = mapAlertToFeature(alert);
    assert.ok(mapped);
    assert.equal(mapped.id, 'nws-urn:oid:2.49.0.1.840.0.example-redflag-001');
    assert.equal(mapped.geometry?.type, 'MultiPolygon');

    // splitMultiPolygon should yield one feature per polygon, suffixed
    const split = splitMultiPolygon(mapped);
    assert.equal(split.length, 2);
    assert.equal(split[0].id, 'nws-urn:oid:2.49.0.1.840.0.example-redflag-001-0');
    assert.equal(split[1].id, 'nws-urn:oid:2.49.0.1.840.0.example-redflag-001-1');
    assert.equal(split[0].geometry?.type, 'Polygon');
});

test('splitMultiPolygon: non-MultiPolygon features pass through unchanged', () => {
    const alert = load<NWSAlertFeature>('severe-thunderstorm.json');
    const mapped = mapAlertToFeature(alert);
    assert.ok(mapped);
    const split = splitMultiPolygon(mapped);
    assert.equal(split.length, 1);
    assert.equal(split[0], mapped);
});
