import FormData from 'form-data';

async function callService(baseUrl, endpoint, image) {
  const url = `${baseUrl}${endpoint}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image }),
  });
  if (!res.ok) throw new Error(`Service error (${url}): ${res.status}`);
  return res.json();
}

function getServiceUrl() {
  return process.env.ML_SERVICE_URL || process.env.OCR_SERVICE_URL || null;
}

export const parseImage = async (req, res) => {
  try {
    const { image } = req.body;
    if (!image) return res.status(400).json({ message: 'image is required' });

    const svc = getServiceUrl();
    if (svc) {
      const result = await callService(svc, '/ocr', image);
      return res.json(result);
    }

    let base64 = image;
    let filetype = 'PNG';
    if (image.includes('base64,')) {
      base64 = image.split('base64,')[1];
      const header = image.substring(0, 30);
      if (header.includes('jpeg') || header.includes('jpg')) filetype = 'JPG';
      else if (header.includes('gif')) filetype = 'GIF';
    }

    const form = new FormData();
    form.append('base64image', base64);
    form.append('language', 'eng');
    form.append('filetype', filetype);
    form.append('isOverlayRequired', 'false');

    const ocrRes = await fetch('https://api.ocr.space/parse/image', {
      method: 'POST',
      headers: { apikey: process.env.OCR_SPACE_KEY },
      body: form,
    });
    const json = await ocrRes.json();

    if (json.OCRExitCode === 1 && json.ParsedResults?.length > 0) {
      return res.json({ text: json.ParsedResults[0].ParsedText });
    }

    return res.status(422).json({ message: 'OCR failed', details: json.ErrorMessage || json.ErrorDetails || 'Unknown error' });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const extractImage = async (req, res) => {
  try {
    const { image } = req.body;
    if (!image) return res.status(400).json({ message: 'image is required' });

    const svc = getServiceUrl();
    if (svc) {
      const result = await callService(svc, '/extract', image);
      return res.json(result);
    }

    return res.status(501).json({ message: 'Set ML_SERVICE_URL or OCR_SERVICE_URL in .env' });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

