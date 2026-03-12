// Vercel serverless function — proxies /api/map/* → pub.soksys.no
// Handles CORS so the browser can call Søksys directly via this function.

export default async function handler(req, res) {
  const { path = [] } = req.query;
  const upstreamPath = Array.isArray(path) ? path.join('/') : path;

  // Forward original query string (minus the catch-all 'path' param)
  const qs = new URLSearchParams(req.query);
  qs.delete('path');
  const qsStr = qs.toString();

  const url = `https://pub.soksys.no/api/map/${upstreamPath}${qsStr ? '?' + qsStr : ''}`;

  try {
    const upstream = await fetch(url, {
      headers: { 'User-Agent': 'oslo-roadworks-proxy/0.1' },
    });

    const data = await upstream.text();

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    res.status(upstream.status).send(data);
  } catch (err) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(502).json({ error: String(err) });
  }
}
