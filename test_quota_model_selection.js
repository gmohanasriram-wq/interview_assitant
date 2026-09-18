/**
 * Focused test for Groq quota bucket accounting + getModelForToday() ladder.
 *
 * Covers D6: primary model usage was written to the wrong bucket
 * ('gpt-oss-120b' written, 'openai/gpt-oss-120b' read).
 *
 * Runs under plain node:  node test_quota_model_selection.js
 *
 * ISOLATION: storage.js derives its config dir from os.homedir(), so we
 * redirect USERPROFILE/HOME to a throwaway temp dir BEFORE requiring it.
 * The real user limits.json is never read or written. A hard guard below
 * asserts isolation actually took effect and aborts otherwise.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// ---------------------------------------------------------------- isolation
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'meetpilot-quota-test-'));
process.env.USERPROFILE = TMP_HOME; // win32
process.env.HOME = TMP_HOME; // darwin / linux

const storage = require('./src/storage');

function getConfigDir() {
    const platform = os.platform();
    if (platform === 'win32') return path.join(TMP_HOME, 'AppData', 'Roaming', 'cheating-daddy-config');
    if (platform === 'darwin') return path.join(TMP_HOME, 'Library', 'Application Support', 'cheating-daddy-config');
    return path.join(TMP_HOME, '.config', 'cheating-daddy-config');
}

const LIMITS_PATH = path.join(getConfigDir(), 'limits.json');

// Hard guard: never touch the real quota file.
if (!LIMITS_PATH.startsWith(TMP_HOME)) {
    console.error(`FATAL: isolation failed. Resolved path escaped temp dir: ${LIMITS_PATH}`);
    process.exit(1);
}

// ------------------------------------------------------------------ harness
const results = { timestamp: new Date().toISOString(), tests: [] };
let passed = 0;
let failed = 0;

function assert(name, condition, details = '') {
    const status = condition ? 'PASS' : 'FAIL';
    if (condition) passed++;
    else failed++;
    results.tests.push({ name, status, details });
    console.log(`  [${status}] ${name}${details ? ' — ' + details : ''}`);
}

const TODAY = new Date().toISOString().split('T')[0];

/** Write an arbitrary limits.json state into the isolated config dir. */
function seedLimits(groq, extras = {}) {
    fs.mkdirSync(getConfigDir(), { recursive: true });
    const entry = Object.assign(
        {
            date: TODAY,
            flash: { count: 0 },
            flashLite: { count: 0 },
            groq,
            gemini: { 'gemma-4-26b-a4b-it': { chars: 0 } },
        },
        extras
    );
    fs.writeFileSync(LIMITS_PATH, JSON.stringify({ data: [entry] }, null, 2));
}

function readLimits() {
    return JSON.parse(fs.readFileSync(LIMITS_PATH, 'utf8'));
}

function todayGroq() {
    const limits = readLimits();
    return limits.data.find(e => e.date === TODAY).groq;
}

// -------------------------------------------------------------- ladder tests
console.log('\n=== getModelForToday() ladder ===');

// Test 1: 120B usage below 1.5M -> primary model
console.log('\nTest 1: 120B below limit -> openai/gpt-oss-120b');
seedLimits({
    'gpt-oss-120b': { chars: 100000, limit: 1500000 },
    'gpt-oss-20b': { chars: 0, limit: 600000 },
});
assert('T1 120B under limit returns primary', storage.getModelForToday() === 'openai/gpt-oss-120b', `got ${storage.getModelForToday()}`);

// Test 1b: boundary — exactly at limit must NOT be "under"
console.log('\nTest 1b: 120B exactly at limit -> falls through to 20B');
seedLimits({
    'gpt-oss-120b': { chars: 1500000, limit: 1500000 },
    'gpt-oss-20b': { chars: 0, limit: 600000 },
});
assert('T1b 120B exactly at limit drops to 20B', storage.getModelForToday() === 'openai/gpt-oss-20b', `got ${storage.getModelForToday()}`);

// Test 2: 120B exhausted, 20B available -> 20B model
console.log('\nTest 2: 120B exhausted, 20B below limit -> openai/gpt-oss-20b');
seedLimits({
    'gpt-oss-120b': { chars: 1600000, limit: 1500000 },
    'gpt-oss-20b': { chars: 10, limit: 600000 },
});
assert('T2 120B exhausted returns 20B', storage.getModelForToday() === 'openai/gpt-oss-20b', `got ${storage.getModelForToday()}`);

// Test 3: both exhausted -> null
console.log('\nTest 3: both exhausted -> null');
seedLimits({
    'gpt-oss-120b': { chars: 1500000, limit: 1500000 },
    'gpt-oss-20b': { chars: 600000, limit: 600000 },
});
assert('T3 all local quotas exhausted returns null', storage.getModelForToday() === null, `got ${JSON.stringify(storage.getModelForToday())}`);

// Test 3b: 20B boundary — exactly at limit -> null
console.log('\nTest 3b: 20B exactly at limit -> null');
seedLimits({
    'gpt-oss-120b': { chars: 1500000, limit: 1500000 },
    'gpt-oss-20b': { chars: 600000, limit: 600000 },
});
assert('T3b 20B exactly at limit returns null', storage.getModelForToday() === null, `got ${JSON.stringify(storage.getModelForToday())}`);

// --------------------------------------------------------- accounting tests
console.log('\n=== usage accounting (mirrors gemini.js:532 unchanged) ===');

// Test 4: a Groq request using openai/gpt-oss-120b must increment gpt-oss-120b.
// gemini.js is NOT modified; it calls incrementCharUsage('groq', modelToUse.split('/').pop(), n).
console.log('\nTest 4: openai/gpt-oss-120b request increments gpt-oss-120b bucket');
seedLimits({
    'gpt-oss-120b': { chars: 1000, limit: 1500000 },
    'gpt-oss-20b': { chars: 0, limit: 600000 },
});
const modelToUse = storage.getModelForToday(); // 'openai/gpt-oss-120b'
const modelKey = modelToUse.split('/').pop(); // unchanged gemini.js behaviour
storage.incrementCharUsage('groq', modelKey, 500);
assert('T4 request increments the primary bucket', todayGroq()['gpt-oss-120b'].chars === 1500, `chars=${todayGroq()['gpt-oss-120b'].chars}, key=${modelKey}`);

// Test 4b: an openai/gpt-oss-20b request must increment gpt-oss-20b.
console.log('\nTest 4b: openai/gpt-oss-20b request increments gpt-oss-20b bucket');
seedLimits({
    'gpt-oss-120b': { chars: 1500000, limit: 1500000 },
    'gpt-oss-20b': { chars: 1000, limit: 600000 },
});
const model20 = storage.getModelForToday();
storage.incrementCharUsage('groq', model20.split('/').pop(), 250);
assert('T4b 20B request increments the 20B bucket', todayGroq()['gpt-oss-20b'].chars === 1250, `chars=${todayGroq()['gpt-oss-20b'].chars}, key=${model20.split('/').pop()}`);

// ------------------------------------------------------------ migration tests
console.log('\n=== migration (existing usage must survive) ===');

// Test 5: legacy 'openai/gpt-oss-120b' bucket merges into 'gpt-oss-120b', preserving chars.
console.log('\nTest 5: legacy prefixed bucket migrates, chars preserved');
seedLimits({
    'openai/gpt-oss-120b': { chars: 75793, limit: 1500000 },
    'gpt-oss-120b': { chars: 0, limit: 600000 },
    'gpt-oss-20b': { chars: 42, limit: 600000 },
});
storage.getTodayLimits(); // triggers migration
const after5 = todayGroq();
assert('T5 legacy chars preserved', after5['gpt-oss-120b'].chars === 75793, `chars=${after5['gpt-oss-120b'].chars}`);
assert('T5 primary limit normalised to 1,500,000', after5['gpt-oss-120b'].limit === 1500000, `limit=${after5['gpt-oss-120b'].limit}`);
assert('T5 no duplicate primary bucket remains', after5['openai/gpt-oss-120b'] === undefined, `keys=${Object.keys(after5).join(',')}`);
assert('T5 20B usage untouched', after5['gpt-oss-20b'].chars === 42, `chars=${after5['gpt-oss-20b'].chars}`);

// Test 5b: the exact real-world state observed on disk.
console.log('\nTest 5b: exact real on-disk state (0 + 75,793)');
seedLimits({
    'openai/gpt-oss-120b': { chars: 0, limit: 1500000 },
    'gpt-oss-120b': { chars: 75793, limit: 600000 },
    'gpt-oss-20b': { chars: 0, limit: 600000 },
});
storage.getTodayLimits();
const after5b = todayGroq();
assert('T5b real usage preserved after migration', after5b['gpt-oss-120b'].chars === 75793, `chars=${after5b['gpt-oss-120b'].chars}`);
assert('T5b limit raised to 1,500,000', after5b['gpt-oss-120b'].limit === 1500000, `limit=${after5b['gpt-oss-120b'].limit}`);
assert('T5b duplicate bucket removed', after5b['openai/gpt-oss-120b'] === undefined, `keys=${Object.keys(after5b).join(',')}`);

// Test 5c: migration is idempotent — running twice must not double-count.
console.log('\nTest 5c: migration is idempotent');
storage.getTodayLimits();
storage.getTodayLimits();
assert('T5c repeated migration does not double-count', todayGroq()['gpt-oss-120b'].chars === 75793, `chars=${todayGroq()['gpt-oss-120b'].chars}`);

// Test 5d: fresh day / empty state gets the normalised shape.
console.log('\nTest 5d: fresh state has normalised buckets');
fs.writeFileSync(LIMITS_PATH, JSON.stringify({ data: [] }, null, 2));
const fresh = storage.getTodayLimits();
assert('T5d fresh primary bucket is unprefixed', fresh.groq['gpt-oss-120b'] !== undefined && fresh.groq['openai/gpt-oss-120b'] === undefined, `keys=${Object.keys(fresh.groq).join(',')}`);
assert('T5d fresh primary limit is 1,500,000', fresh.groq['gpt-oss-120b'].limit === 1500000, `limit=${fresh.groq['gpt-oss-120b'].limit}`);
assert('T5d fresh 20B limit is 600,000', fresh.groq['gpt-oss-20b'].limit === 600000, `limit=${fresh.groq['gpt-oss-20b'].limit}`);

// ------------------------------------------------------------------ cleanup
try {
    fs.rmSync(TMP_HOME, { recursive: true, force: true });
} catch (e) {
    /* best effort */
}

// ------------------------------------------------------------------- report
results.passed = passed;
results.failed = failed;
results.isolatedConfigDir = getConfigDir();
fs.writeFileSync(path.join(__dirname, 'quota_selection_test_results.json'), JSON.stringify(results, null, 2));

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
console.log(`  isolated dir: ${results.isolatedConfigDir}`);
process.exit(failed === 0 ? 0 : 1);
