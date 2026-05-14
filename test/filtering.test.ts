import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
    shouldIncludeAlert,
    severityRank,
    type NWSAlertFeature,
} from '../lib.ts';

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const loadFixture = (name: string): NWSAlertFeature =>
    JSON.parse(readFileSync(join(fixtureDir, name), 'utf8'));

test('shouldIncludeAlert: passes through a matching alert with no filters', () => {
    const alert = loadFixture('severe-thunderstorm.json');
    assert.equal(shouldIncludeAlert(alert, {}), true);
});

test('shouldIncludeAlert: drops Cancel messages always', () => {
    const alert = loadFixture('cancel-alert.json');
    assert.equal(shouldIncludeAlert(alert, {}), false);
});

test('shouldIncludeAlert: events filter is an exact-match allow list', () => {
    const alert = loadFixture('red-flag-warning.json');
    assert.equal(
        shouldIncludeAlert(alert, { events: ['Red Flag Warning', 'Fire Weather Watch'] }),
        true,
    );
    assert.equal(
        shouldIncludeAlert(alert, { events: ['Tornado Warning'] }),
        false,
    );
    // Empty events array means "no filter"
    assert.equal(shouldIncludeAlert(alert, { events: [] }), true);
});

test('shouldIncludeAlert: minimumSeverity filters alerts strictly below the threshold', () => {
    const minor = loadFixture('flash-flood-watch-minor.json');
    const severe = loadFixture('severe-thunderstorm.json');

    assert.equal(shouldIncludeAlert(minor, { minimumSeverity: 'Moderate' }), false);
    assert.equal(shouldIncludeAlert(severe, { minimumSeverity: 'Moderate' }), true);
    assert.equal(shouldIncludeAlert(severe, { minimumSeverity: 'Extreme' }), false);
    assert.equal(shouldIncludeAlert(severe, { minimumSeverity: 'Severe' }), true);
});

test('severityRank: orders the standard CAP severities Extreme > Severe > Moderate > Minor > Unknown', () => {
    assert.ok(severityRank('Extreme') > severityRank('Severe'));
    assert.ok(severityRank('Severe') > severityRank('Moderate'));
    assert.ok(severityRank('Moderate') > severityRank('Minor'));
    assert.ok(severityRank('Minor') > severityRank('Unknown'));
    assert.equal(severityRank('NotARealSeverity'), 0);
});
