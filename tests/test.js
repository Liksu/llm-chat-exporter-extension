/**
 * Single discovery+runner file for the scenario test corpus.
 *
 * Behavior:
 *   - Walk tests/scenarios/** recursively for any directory containing a
 *     scenario.json file.
 *   - For each scenario, emit a node:test test() per export-variant.
 *   - With UPDATE_GOLDEN=1, expected files are (re)written instead of compared.
 *
 * To run:    npm test
 * To refresh goldens (carefully):   UPDATE_GOLDEN=1 npm run test:update
 *
 * TZ: forced to UTC at the very top of this file so todayStamp() and
 * date-format='iso-utc' renderings are deterministic regardless of the
 * developer's machine. Node reads TZ lazily on first Date construction,
 * so setting it before anything else loads is enough.
 */

'use strict';

process.env.TZ = process.env.TZ || 'UTC';

const path = require('node:path');
const { test } = require('node:test');
const fs = require('node:fs');

const { findScenarios, runExport } = require('./scaffolding/run-scenario');

const SCENARIOS_DIR = path.join(__dirname, 'scenarios');

const scenarios = findScenarios(SCENARIOS_DIR);

if (scenarios.length === 0) {
  // Still emit one test so `npm test` doesn't silently report "0 passing".
  test('no scenarios found — add one under tests/scenarios/', () => {
    throw new Error(
      `No scenario.json discovered under ${SCENARIOS_DIR}. ` +
        `Drop a scenario directory under tests/scenarios/examples/ or tests/scenarios/local/.`
    );
  });
} else {
  for (const { dir, configPath } of scenarios) {
    const scenario = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const scenarioLabel = scenario.name || path.relative(SCENARIOS_DIR, dir);
    const exports_ = Array.isArray(scenario.exports) ? scenario.exports : [];

    test(scenarioLabel, async (t) => {
      if (exports_.length === 0) {
        throw new Error(`Scenario "${scenarioLabel}" has no exports[] defined`);
      }
      for (const exp of exports_) {
        const expLabel = exp.name || JSON.stringify(exp.message);
        await t.test(expLabel, async () => {
          await runExport(dir, scenario, exp);
        });
      }
    });
  }
}
