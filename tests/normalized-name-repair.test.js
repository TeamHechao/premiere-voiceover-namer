const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const mainSource = fs.readFileSync('src/main.js', 'utf8');

function functionBody(name, nextName) {
  const start = mainSource.indexOf(`function ${name}`);
  const end = mainSource.indexOf(`function ${nextName}`, start + 1);
  assert.ok(start >= 0, `${name} is missing`);
  assert.ok(end > start, `${name} boundary is missing`);
  return mainSource.slice(start, end);
}

test('normalized UUID media is claimed once and sent through the name-only repair transaction', () => {
  assert.match(mainSource, /var\s+normalizedNameChecks\s*=\s*new Set\(\)/);
  assert.match(mainSource, /async function synchronizeNormalizedRecordingNames\(candidate\)/);
  assert.match(mainSource, /Transaction\.synchronizeNames\(\{/);
  assert.match(mainSource, /targetName:\s*targetName/);
  assert.match(mainSource, /expectedMediaPath:\s*candidate\.mediaPath/);

  const normalizedBranch = mainSource.match(
    /if \(isNormalizedRecording\(candidate\)\) \{([\s\S]*?)\n\s*continue;\n\s*\}/,
  );
  assert.ok(normalizedBranch, 'normalized recording branch is missing');
  assert.match(normalizedBranch[1], /if \(!normalizedNameChecks\.has\(key\)\)/);
  assert.match(normalizedBranch[1], /normalizedNameChecks\.add\(key\)/);
  assert.match(normalizedBranch[1], /candidate\.multipleProjectItems/);
  assert.match(normalizedBranch[1], /await synchronizeNormalizedRecordingNames\(candidate\)/);
});

test('name repair claims are reset at monitor and sequence boundaries and after manual refresh', () => {
  const startBody = functionBody('startMonitoring', 'stopMonitoring');
  const stopBody = functionBody('stopMonitoring', 'statTimestamp');
  const primaryBody = functionBody('handlePrimaryAction', 'onStopButtonClick');
  const refreshBody = functionBody('onRefreshButtonClick', 'onCancelScanClick');

  assert.match(startBody, /normalizedNameChecks\.clear\(\)/);
  assert.match(stopBody, /normalizedNameChecks\.clear\(\)/);
  assert.match(mainSource, /if \(sequenceChanged\) \{[\s\S]*?normalizedNameChecks\.clear\(\)/);
  assert.match(primaryBody, /primaryAction === "refresh"[\s\S]*?normalizedNameChecks\.clear\(\)/);
  assert.match(refreshBody, /normalizedNameChecks\.clear\(\)/);
  assert.match(refreshBody, /if \(monitoring\)[\s\S]*?requestSoonScan\(\)/);
  assert.match(mainSource, /refreshButton\.title\s*=\s*monitoring \? "重新检查" : "刷新项目"/);
  assert.match(mainSource, /refreshButton\.setAttribute\("aria-label", refreshButton\.title\)/);
  assert.match(mainSource, /refreshButton\.disabled\s*=\s*view\.busy \|\| \(monitoring && !panelErrorMessage\)/);
});

test('a newly completed rename is pre-marked so the next scan does not repair it again', () => {
  const executeBody = functionBody('executeCandidate', 'synchronizeNormalizedRecordingNames');
  assert.match(
    executeBody,
    /normalizedNameChecks\.add\(Core\.normalizePathForComparison\(plan\.targetPath\)\)/,
  );
});
