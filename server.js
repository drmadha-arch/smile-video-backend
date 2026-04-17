const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

const FAL_KEY    = process.env.FAL_KEY;
const GOOGLE_KEY = process.env.GOOGLE_KEY;

const GEMINI_MODELS = [
  'gemini-2.5-flash-image',
  'gemini-2.5-flash-image-preview',
  'gemini-2.0-flash-preview-image-generation',
  'gemini-2.0-flash-exp-image-generation'
];

// Health check
app.get('/', (req, res) => res.json({ status: 'ok', service: 'Smile Design Backend' }));

// Generate smile photo
app.post('/generate-smile', async (req, res) => {
  const { image_b64, mime, prompt } = req.body;
  if (!image_b64 || !prompt) return res.status(400).json({ error: 'image_b64 and prompt required' });
  if (!GOOGLE_KEY) return res.status(500).json({ error: 'GOOGLE_KEY not set on server' });

  const body = JSON.stringify({
    contents: [{ parts: [
      { inline_data: { mime_type: mime || 'image/jpeg', data: image_b64 } },
      { text: prompt }
    ]}],
    generationConfig: { responseModalities: ['IMAGE', 'TEXT'] }
  });

  let lastErr = '';
  for (const model of GEMINI_MODELS) {
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GOOGLE_KEY}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }
      );
      const d = await r.json();
      if (d.error) { lastErr = `${model}: ${d.error.message}`; continue; }
      for (const c of d.candidates || [])
        for (const p of c.content?.parts || [])
          if (p.inlineData?.data) return res.json({ image_b64: p.inlineData.data });
      lastErr = `${model}: no image returned`;
    } catch(e) { lastErr = e.message; }
  }
  return res.status(500).json({ error: lastErr });
});

// Generate talking video
app.post('/generate-video', async (req, res) => {
  const { image_url, text_input, voice, prompt } = req.body;

  if (!image_url || !text_input) {
    return res.status(400).json({ error: 'image_url and text_input required' });
  }
  if (!FAL_KEY) {
    return res.status(500).json({ error: 'FAL_KEY not set on server' });
  }

  try {
    // Step 1: Generate TTS audio
    console.log('Step 1: Generating TTS audio...');
    const ttsRes = await fetch('https://fal.run/fal-ai/kokoro/american-english', {
      method: 'POST',
      headers: { 'Authorization': `Key ${FAL_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: text_input,
        voice: voice && voice.includes('Roger') || voice === 'Liam' || voice === 'Will' || voice === 'Chris' || voice === 'Brian' ? 'am_adam' : 'af_sarah'
      })
    });

    let audioUrl = null;
    if (ttsRes.ok) {
      const ttsData = await ttsRes.json();
      audioUrl = ttsData.audio?.url || ttsData.url;
      console.log('TTS audio URL:', audioUrl);
    }

    if (!audioUrl) {
      // Fallback: use a pre-made audio clip
      console.log('TTS failed, using Infinitalk instead...');
      return generateWithInfinitalk(req, res, image_url, text_input, voice);
    }

    // Step 2: Kling Avatar - lip sync image to audio (~30-60 sec)
    console.log('Step 2: Sending to Kling Avatar...');
    const MODEL = 'fal-ai/kling-video/ai-avatar/v2/standard';

    const submitRes = await fetch(`https://queue.fal.run/${MODEL}`, {
      method: 'POST',
      headers: { 'Authorization': `Key ${FAL_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image_url,
        audio_url: audioUrl,
        prompt: prompt || 'Natural head movement, warm smile, teeth visible'
      })
    });

    if (!submitRes.ok) {
      const err = await submitRes.text();
      console.log('Kling Avatar failed, falling back to Infinitalk:', err);
      return generateWithInfinitalk(req, res, image_url, text_input, voice);
    }

    const submitData = await submitRes.json();
    const requestId = submitData.request_id;
    if (!requestId) return generateWithInfinitalk(req, res, image_url, text_input, voice);

    const statusUrl = submitData.status_url || `https://queue.fal.run/${MODEL}/requests/${requestId}/status`;
    const resultUrl = submitData.response_url || `https://queue.fal.run/${MODEL}/requests/${requestId}`;

    // Poll
    const start = Date.now();
    while (Date.now() - start < 3 * 60 * 1000) {
      await sleep(3000);
      const elapsed = Math.floor((Date.now() - start) / 1000);
      const stRes = await fetch(statusUrl, { headers: { 'Authorization': `Key ${FAL_KEY}` } });
      if (!stRes.ok) continue;
      const st = await stRes.json();
      console.log(`Kling Avatar status @${elapsed}s:`, st.status);

      if (st.status === 'COMPLETED') {
        const rRes = await fetch(resultUrl, { headers: { 'Authorization': `Key ${FAL_KEY}` } });
        const data = await rRes.json();
        const videoUrl = data.video?.url;
        if (!videoUrl) return generateWithInfinitalk(req, res, image_url, text_input, voice);
        console.log('Kling Avatar done! Video:', videoUrl);
        return res.json({ video_url: videoUrl });
      }
      if (st.status === 'FAILED' || st.status === 'ERROR') {
        console.log('Kling Avatar failed, falling back...');
        return generateWithInfinitalk(req, res, image_url, text_input, voice);
      }
    }
    return generateWithInfinitalk(req, res, image_url, text_input, voice);

  } catch (e) {
    console.error('Server error:', e);
    return res.status(500).json({ error: e.message });
  }
});

// Infinitalk fallback
async function generateWithInfinitalk(req, res, image_url, text_input, voice) {
  const MODEL = 'fal-ai/infinitalk/single-text';
  console.log('Using Infinitalk fallback...');

  try {
    const submitRes = await fetch(`https://queue.fal.run/${MODEL}`, {
      method: 'POST',
      headers: { 'Authorization': `Key ${FAL_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image_url,
        text_input,
        voice: voice || 'Sarah',
        prompt: 'Happy person talking and smiling, teeth visible, natural head movement.',
        resolution: '480p',
        num_frames: 81,
        acceleration: 'high'
      })
    });

    if (!submitRes.ok) {
      const err = await submitRes.text();
      return res.status(500).json({ error: `Submit failed: ${err}` });
    }

    const submitData = await submitRes.json();
    const requestId = submitData.request_id;
    if (!requestId) return res.status(500).json({ error: 'No request_id' });

    const statusUrl = submitData.status_url || `https://queue.fal.run/${MODEL}/requests/${requestId}/status`;
    const resultUrl = submitData.response_url || `https://queue.fal.run/${MODEL}/requests/${requestId}`;

    const start = Date.now();
    while (Date.now() - start < 8 * 60 * 1000) {
      await sleep(3000);
      const elapsed = Math.floor((Date.now() - start) / 1000);
      const stRes = await fetch(statusUrl, { headers: { 'Authorization': `Key ${FAL_KEY}` } });
      if (!stRes.ok) continue;
      const st = await stRes.json();
      console.log(`Infinitalk @${elapsed}s:`, st.status);

      if (st.status === 'COMPLETED') {
        const rRes = await fetch(resultUrl, { headers: { 'Authorization': `Key ${FAL_KEY}` } });
        const data = await rRes.json();
        const videoUrl = data.video?.url;
        if (!videoUrl) return res.status(500).json({ error: 'No video URL' });
        console.log('Infinitalk done! Video:', videoUrl);
        return res.json({ video_url: videoUrl });
      }
      if (st.status === 'FAILED' || st.status === 'ERROR') {
        return res.status(500).json({ error: 'Generation failed: ' + JSON.stringify(st) });
      }
    }
    return res.status(504).json({ error: 'Timeout after 8 minutes' });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Smile video backend running on port ${PORT}`));
