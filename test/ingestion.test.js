const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractSourceFromFilename,
  normalizeIncomingCall,
  normalizeTrunkRecorderCall
} = require('../src/ingestion/normalizeCall');

test('extractSourceFromFilename reads SDRTrunk FROM source IDs', () => {
  assert.equal(extractSourceFromFilename('CALL_FROM_123456_TO_1001.mp3'), '123456');
  assert.equal(extractSourceFromFilename('call.mp3'), undefined);
});

test('normalizeIncomingCall maps SDRTrunk fields to the internal call shape', () => {
  const call = normalizeIncomingCall({
    source: 'sdrtrunk',
    fileInfo: { originalFilename: 'CALL_FROM_55_TO_1001.mp3' },
    fields: {
      talkgroup: '1001',
      systemLabel: 'County',
      talkgroupLabel: 'Fire Dispatch',
      dateTime: '2026-05-17T12:00:00Z'
    }
  });

  assert.equal(call.provider, 'sdrtrunk');
  assert.equal(call.talkGroupID, '1001');
  assert.equal(call.source, '55');
  assert.equal(call.isTrunkRecorder, false);
});

test('normalizeTrunkRecorderCall extracts source and alias from meta srcList', () => {
  const call = normalizeTrunkRecorderCall({
    talkgroup: '2001',
    meta: JSON.stringify({
      start_time: 1779030000,
      freq: 853000000,
      srcList: [{ src: -1 }, { src: 9901, tag: 'Unit 12' }],
      freqList: [{ freq: 853000000 }]
    })
  });

  assert.equal(call.provider, 'trunk-recorder');
  assert.equal(call.talkGroupID, '2001');
  assert.equal(call.source, '9901');
  assert.equal(call.talkerAlias, 'Unit 12');
  assert.equal(call.frequency, 853000000);
});

test('normalizeIncomingCall preserves rdio-scanner as a non-TrunkRecorder provider', () => {
  const call = normalizeIncomingCall({
    source: 'rdio-scanner',
    fields: {
      talkgroup: '3001',
      dateTime: '2026-05-17T12:00:00Z'
    }
  });

  assert.equal(call.provider, 'rdio-scanner');
  assert.equal(call.isTrunkRecorder, false);
});
