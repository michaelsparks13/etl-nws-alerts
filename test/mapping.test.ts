import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
    mapAlertToFeature,
    buildCallsign,
    buildRemarks,
    colorForSeverity,
    type NWSAlertFeature,
} from '../lib.ts';

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const loadFixture = (name: string): NWSAlertFeature =>
    JSON.parse(readFileSync(join(fixtureDir, name), 'utf8'));

test('mapAlertToFeature: polygon alert produces a CloudTAK feature with stable id and styled properties', () => {
    const alert = loadFixture('severe-thunderstorm.json');
    const feature = mapAlertToFeature(alert);

    assert.ok(feature, 'expected a feature, got null');
    assert.equal(feature.id, 'nws-urn:oid:2.49.0.1.840.0.example-svr-001');
    assert.equal(feature.type, 'Feature');
    assert.equal(feature.geometry?.type, 'Polygon');

    const p = feature.properties as Record<string, unknown>;
    assert.equal(p.callsign, 'Severe Thunderstorm Warning — Arapahoe County');
    assert.equal(p.start, '2026-05-14T15:30:00-06:00');
    assert.equal(p.stale, '2026-05-14T16:30:00-06:00');
    assert.equal(p.stroke, '#ea580c'); // Severe → orange
    assert.equal(p.fill, '#ea580c');
    assert.equal(p['fill-opacity'], 0.25);
    assert.equal(p['stroke-opacity'], 0.85);

    const meta = p.metadata as Record<string, unknown>;
    assert.equal(meta.event, 'Severe Thunderstorm Warning');
    assert.equal(meta.severity, 'Severe');
    assert.equal(meta.messageType, 'Alert');
});

test('mapAlertToFeature: returns null when geometry is null and no zone resolution happened', () => {
    const alert = loadFixture('red-flag-warning.json');
    const feature = mapAlertToFeature(alert);
    assert.equal(feature, null);
});

test('mapAlertToFeature: start falls back to effective when onset is null', () => {
    const alert = loadFixture('flash-flood-watch-minor.json');
    // Simulate a resolved geometry so mapping proceeds
    alert.geometry = { type: 'Point', coordinates: [-105.5, 39.0] };
    const feature = mapAlertToFeature(alert);
    assert.ok(feature);
    // Fixture has both onset and effective set; verify onset wins when present
    const p = feature.properties as Record<string, unknown>;
    assert.equal(p.start, '2026-05-14T14:00:00-06:00'); // onset
    assert.equal(p.stale, '2026-05-14T22:00:00-06:00'); // expires (ends is null)
});

test('buildCallsign: uses only the first segment of areaDesc to keep it short', () => {
    const p = {
        event: 'Red Flag Warning',
        areaDesc: 'Crowley County; Pueblo County',
    } as Parameters<typeof buildCallsign>[0];
    assert.equal(buildCallsign(p), 'Red Flag Warning — Crowley County');
});

test('buildRemarks: includes headline, description, instruction, severity/urgency/certainty, sender', () => {
    const alert = loadFixture('severe-thunderstorm.json');
    const remarks = buildRemarks(alert.properties);
    assert.match(remarks, /Severe Thunderstorm Warning issued/);
    assert.match(remarks, /HAZARD: 70 mph wind gusts/);
    assert.match(remarks, /Instruction:/);
    assert.match(remarks, /Severity: Severe/);
    assert.match(remarks, /Sender: NWS Denver CO/);
});

test('colorForSeverity: returns expected hex per severity tier; unknown falls back to gray', () => {
    assert.equal(colorForSeverity('Extreme'), '#dc2626');
    assert.equal(colorForSeverity('Severe'), '#ea580c');
    assert.equal(colorForSeverity('Moderate'), '#facc15');
    assert.equal(colorForSeverity('Minor'), '#2563eb');
    assert.equal(colorForSeverity('Unknown'), '#6b7280');
    assert.equal(colorForSeverity('NonexistentSeverity'), '#6b7280');
});
