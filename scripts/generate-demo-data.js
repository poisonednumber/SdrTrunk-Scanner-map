const fs = require('fs');
const path = require('path');

const outputDir = path.join(__dirname, '..', 'data');
const outputFile = path.join(outputDir, 'demo-calls.json');

const now = Math.floor(Date.now() / 1000);
const calls = [
  {
    id: 1,
    talk_group_id: '1001',
    timestamp: now - 420,
    transcription: 'Engine 12 responding to a medical call near Main Street and Oak Avenue.',
    audio_file_path: '',
    address: 'Main Street and Oak Avenue',
    lat: 39.083997,
    lon: -77.152758,
    category: 'Medical Call'
  },
  {
    id: 2,
    talk_group_id: '2001',
    timestamp: now - 240,
    transcription: 'Units checking a vehicle collision near the northbound ramp.',
    audio_file_path: '',
    address: 'Northbound ramp',
    lat: 39.099721,
    lon: -77.184516,
    category: 'Vehicle Collision'
  },
  {
    id: 3,
    talk_group_id: '3001',
    timestamp: now - 60,
    transcription: 'Police responding for a disturbance at the shopping center.',
    audio_file_path: '',
    address: 'Shopping center',
    lat: 39.045753,
    lon: -77.118741,
    category: 'Disturbance'
  }
];

fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(outputFile, `${JSON.stringify(calls, null, 2)}\n`);
console.log(`Wrote ${calls.length} demo calls to ${outputFile}`);
