// Vercel serverless function — proxies Søksys API requests to bypass CORS
// Called as: /api/soksys?endpoint=soksys-plans&extent=...&filter=...

export default async function handler(req, res) {
  const { endpoint, extent, filter } = req.query;

  if (!endpoint || !extent || !filter) {
    res.status(400).json({ error: 'Missing required params: endpoint, extent, filter' });
    return;
  }

  const url = `https://pub.soksys.no/api/map/${endpoint}?extent=${encodeURIComponent(extent)}&filter=${encodeURIComponent(filter)}`;

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
