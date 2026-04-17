const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

const FAL_KEY = process.env.FAL_KEY;
const MODEL = 'fal-ai/infinitalk/single-text';

// Health check
app.get('/', (req, res) => res.json({ status: 'ok', service: 'Smile Video Backend' }));

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
    // Submit to fal.ai queue
    console.log('Submitting to Infinitalk...');
    const submitRes = await fetch(`https://queue.fal.run/${MODEL}`, {
      method: 'POST',
      headers: { 'Authorization': `Key ${FAL_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image_url,
        text_input,
        voice: voice || 'Sarah',
        prompt: prompt || 'Happy person talking and smiling, teeth visible, natural head movement.',
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
    if (!requestId) return res.status(500).json({ error: 'No request_id from fal.ai' });

    const statusUrl = submitData.status_url || `https://queue.fal.run/${MODEL}/requests/${requestId}/status`;
    const resultUrl = submitData.response_url || `https://queue.fal.run/${MODEL}/requests/${requestId}`;

    console.log('Polling requestId:', requestId);

    // Poll until done (up to 10 minutes)
    const start = Date.now();
    const MAX = 10 * 60 * 1000;

    while (Date.now() - start < MAX) {
      await sleep(3000);
      const elapsed = Math.floor((Date.now() - start) / 1000);

      const stRes = await fetch(statusUrl, { headers: { 'Authorization': `Key ${FAL_KEY}` } });
      if (!stRes.ok) continue;
      const st = await stRes.json();

      console.log(`Status @${elapsed}s:`, st.status);

      if (st.status === 'COMPLETED') {
        const rRes = await fetch(resultUrl, { headers: { 'Authorization': `Key ${FAL_KEY}` } });
        const data = await rRes.json();
        const videoUrl = data.video?.url;
        if (!videoUrl) return res.status(500).json({ error: 'No video URL in result' });
        console.log('Done! Video URL:', videoUrl);
        return res.json({ video_url: videoUrl });
      }

      if (st.status === 'FAILED' || st.status === 'ERROR') {
        return res.status(500).json({ error: 'Infinitalk generation failed: ' + JSON.stringify(st) });
      }
    }

    return res.status(504).json({ error: 'Timeout after 10 minutes' });

  } catch (e) {
    console.error('Server error:', e);
    return res.status(500).json({ error: e.message });
  }
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Smile video backend running on port ${PORT}`));
