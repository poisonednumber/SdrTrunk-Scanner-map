function parseJsonField(value, fallback = null) {
  if (!value || typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function extractSourceFromFilename(filename) {
  if (!filename) return undefined;
  const match = filename.match(/FROM_(\d+)/);
  return match ? match[1] : undefined;
}

function normalizeSdrTrunkCall(fields = {}, fileInfo = {}) {
  const filenameSource = extractSourceFromFilename(fileInfo.originalFilename);

  return {
    provider: 'sdrtrunk',
    filename: fileInfo.originalFilename || '',
    talkGroupID: fields.talkgroup || fields.talk_group_id || '',
    systemName: fields.systemLabel || fields.system || '',
    talkGroupName: fields.talkgroupLabel || fields.talkgroupName || '',
    talkGroupGroup: fields.talkgroupGroup || '',
    dateTime: fields.dateTime || fields.start_time || '',
    source: fields.source || filenameSource || '',
    talkerAlias: fields.talkerAlias || '',
    frequency: fields.frequency || '',
    metadata: { ...fields },
    isTrunkRecorder: false
  };
}

function enrichTrunkRecorderFields(fields = {}) {
  const enriched = { ...fields };
  const metaData = parseJsonField(fields.meta, {});

  if (metaData && typeof metaData === 'object') {
    const directCopies = [
      'freq',
      'freq_error',
      'signal',
      'noise',
      'emergency',
      'priority',
      'encrypted',
      'call_length',
      'start_time',
      'stop_time',
      'tdma_slot',
      'phase2_tdma',
      'color_code'
    ];

    for (const key of directCopies) {
      if (metaData[key] !== undefined && enriched[key] === undefined) {
        enriched[key === 'freq' ? 'frequency' : key] = metaData[key];
      }
    }

    if (Array.isArray(metaData.srcList) && metaData.srcList.length > 0) {
      const validSource = metaData.srcList.find((src) => src.src && src.src !== -1);
      if (validSource) {
        enriched.source = enriched.source || String(validSource.src);
        if (validSource.tag && String(validSource.tag).trim()) {
          enriched.talkerAlias = enriched.talkerAlias || String(validSource.tag).trim();
        }
      }
      enriched.srcList = enriched.srcList || JSON.stringify(metaData.srcList);
    }

    if (Array.isArray(metaData.freqList)) {
      enriched.freqList = enriched.freqList || JSON.stringify(metaData.freqList);
    }
  }

  return enriched;
}

function normalizeTrunkRecorderCall(fields = {}, fileInfo = {}, options = {}) {
  const enriched = enrichTrunkRecorderFields(fields);
  const provider = options.provider || 'trunk-recorder';

  return {
    provider,
    filename: fileInfo.originalFilename || enriched.filename || '',
    talkGroupID: enriched.talkgroup || enriched.talk_group_id || enriched.talkGroupID || '',
    systemName: enriched.system || enriched.systemName || enriched.systemLabel || '',
    talkGroupName: enriched.talkgroupLabel || enriched.talkgroupName || enriched.talkGroupName || '',
    talkGroupGroup: enriched.talkgroupGroup || '',
    dateTime: enriched.dateTime || enriched.start_time || '',
    source: enriched.source || '',
    talkerAlias: enriched.talkerAlias || '',
    frequency: enriched.frequency || enriched.freq || '',
    metadata: enriched,
    isTrunkRecorder: provider === 'trunk-recorder'
  };
}

function normalizeIncomingCall({ source, fields = {}, fileInfo = {} } = {}) {
  if (source === 'sdrtrunk') return normalizeSdrTrunkCall(fields, fileInfo);
  if (source === 'trunk-recorder') {
    return normalizeTrunkRecorderCall(fields, fileInfo);
  }

  if (source === 'rdio-scanner') {
    return normalizeTrunkRecorderCall(fields, fileInfo, { provider: 'rdio-scanner' });
  }

  return normalizeTrunkRecorderCall(fields, fileInfo);
}

module.exports = {
  enrichTrunkRecorderFields,
  extractSourceFromFilename,
  normalizeIncomingCall,
  normalizeSdrTrunkCall,
  normalizeTrunkRecorderCall,
  parseJsonField
};
