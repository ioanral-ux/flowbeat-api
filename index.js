const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { spawn } = require('child_process');
const MusicTempo = require('music-tempo');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ── HEALTH CHECK ──────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'FlowBeat API', version: '1.0.0' });
});

// ── BPM DETECTION FROM AUDIO URL ──────────────────────
async function detectBPM(audioUrl) {
  return new Promise(async (resolve, reject) => {
    try {
      const response = await fetch(audioUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; FlowBeat/1.0)',
          'Accept': 'audio/mpeg, audio/*'
        },
        timeout: 10000
      });

      if (!response.ok) {
        return reject(new Error(`HTTP ${response.status} fetching audio`));
      }

      const audioBuffer = await response.buffer();
      if (audioBuffer.length < 1000) {
        return reject(new Error('Audio file too small'));
      }

      // Decode mp3 to raw PCM float32 mono at 22050hz using ffmpeg
      const ffmpeg = spawn('ffmpeg', [
        '-i', 'pipe:0',
        '-f', 'f32le',
        '-ac', '1',
        '-ar', '22050',
        'pipe:1'
      ]);

      const chunks = [];
      ffmpeg.stdout.on('data', chunk => chunks.push(chunk));
      ffmpeg.stderr.on('data', () => {}); // suppress ffmpeg logs

      ffmpeg.stdin.on('error', () => {}); // ignore broken pipe
      ffmpeg.stdin.write(audioBuffer);
      ffmpeg.stdin.end();

      ffmpeg.stdout.on('end', () => {
        try {
          const pcm = Buffer.concat(chunks);
          if (pcm.length < 4) return reject(new Error('No PCM output from ffmpeg'));

          const floats = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 4);
          const mt = new MusicTempo(floats);
          resolve(Math.round(mt.tempo * 10) / 10); // one decimal place
        } catch (e) {
          reject(new Error('BPM detection failed: ' + e.message));
        }
      });

      ffmpeg.on('error', e => reject(new Error('ffmpeg error: ' + e.message)));

    } catch (e) {
      reject(e);
    }
  });
}

// ── BPM LOOKUP via MusicBrainz + AcousticBrainz (fallback) ──
async function lookupBPMByTitle(title, artist) {
  try {
    // Search MusicBrainz for the recording
    const query = encodeURIComponent(`recording:"${title}" AND artist:"${artist}"`);
    const mbRes = await fetch(
      `https://musicbrainz.org/ws/2/recording/?query=${query}&limit=1&fmt=json`,
      { headers: { 'User-Agent': 'FlowBeat/1.0 (https://ioanral-ux.github.io/flowbeat)' } }
    );
    if (!mbRes.ok) return null;
    const mbData = await mbRes.json();
    const recording = mbData.recordings?.[0];
    if (!recording) return null;

    // Try AcousticBrainz for BPM data
    const abRes = await fetch(
      `https://acousticbrainz.org/${recording.id}/low-level`,
      { headers: { 'User-Agent': 'FlowBeat/1.0' } }
    );
    if (!abRes.ok) return null;
    const abData = await abRes.json();
    const bpm = abData?.rhythm?.bpm;
    return bpm ? Math.round(bpm * 10) / 10 : null;
  } catch (e) {
    return null;
  }
}

// ── MAIN ENDPOINT: POST /analyze ──────────────────────
// Body: { tracks: [{ id, previewUrl, title, artist }] }
// Returns: { results: [{ id, bpm, error? }] }
app.post('/analyze', async (req, res) => {
  const { tracks } = req.body;

  if (!tracks || !Array.isArray(tracks) || tracks.length === 0) {
    return res.status(400).json({ error: 'tracks array required' });
  }

  if (tracks.length > 20) {
    return res.status(400).json({ error: 'Max 20 tracks per request' });
  }

  // Process all tracks in parallel
  const results = await Promise.all(
    tracks.map(async ({ id, previewUrl, title, artist }) => {
      // Try preview URL first (most accurate)
      if (previewUrl) {
        try {
          const bpm = await detectBPM(previewUrl);
          return { id, bpm, source: 'preview' };
        } catch (e) {
          console.log(`Preview BPM failed for ${title}, trying MusicBrainz...`);
        }
      }
      // Fall back to MusicBrainz lookup
      if (title && artist) {
        try {
          const bpm = await lookupBPMByTitle(title, artist);
          if (bpm) return { id, bpm, source: 'musicbrainz' };
        } catch (e) {
          console.log(`MusicBrainz lookup failed for ${title}`);
        }
      }
      return { id, bpm: null, error: 'No BPM data available' };
    })
  );

  res.json({ results });
});

// ── SINGLE TRACK ENDPOINT: GET /bpm?url=... ───────────
app.get('/bpm', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url query param required' });

  try {
    const bpm = await detectBPM(url);
    res.json({ bpm });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`FlowBeat API running on port ${PORT}`);
});
