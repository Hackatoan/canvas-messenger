'use strict';
// Guards the DMs/Unread list filter helper in styles/messenger.js. The UI file
// is a content script, so pull just the pure helper out of the real source.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'styles', 'messenger.js'), 'utf8');
const fnSrc = src.match(/^function convMatches\([\s\S]*?^}\n/m);
assert.ok(fnSrc, 'convMatches() not found in styles/messenger.js');
const convMatches = new Function(fnSrc[0] + '\nreturn convMatches;')();

const conv = {
    participants: [{ id: 1, name: 'Me Myself' }, { id: 2, name: 'Dr. Ada Lovelace' }],
    subject: 'Midterm regrade',
    last_message: 'See you in office hours',
};

test('empty or whitespace query matches everything', () => {
    assert.equal(convMatches(conv, ''), true);
    assert.equal(convMatches(conv, '   '), true);
    assert.equal(convMatches(conv, undefined), true);
});

test('matches participant name, subject, and last message case-insensitively', () => {
    assert.equal(convMatches(conv, 'lovelace'), true);
    assert.equal(convMatches(conv, 'MIDTERM'), true);
    assert.equal(convMatches(conv, 'office hours'), true);
    assert.equal(convMatches(conv, '  ada  '), true);
});

test('non-matching query and missing fields', () => {
    assert.equal(convMatches(conv, 'calculus'), false);
    assert.equal(convMatches({}, 'x'), false);
    assert.equal(convMatches({ participants: [null, { name: null }], subject: null }, 'x'), false);
});
