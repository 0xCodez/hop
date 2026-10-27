// Local stand-in for Vercel: serves the static site and runs api/*.js the way Vercel does.
//   DASHBOARD_PASSWORD=test node dev-server.js   ->   http://localhost:5319/dashboard
// Without Upstash env vars the API uses the in-memory store.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT) || 5319;
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml' };

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const api = url.pathname.match(/^\/api\/([a-z]+)$/);
    if (api) {
      const file = path.join(root, 'api', `${api[1]}.js`);
      if (!fs.existsSync(file)) {
        res.statusCode = 404;
        return res.end();
      }
      const { default: handler } = await import(pathToFileURL(file).href);
      return handler(req, res);
    }
    // cleanUrls: /dashboard -> dashboard.html
    let file = path.join(root, decodeURIComponent(url.pathname));
    if (!path.relative(root, file).startsWith('..')) {
      if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
      else if (!path.extname(file)) file += '.html';
      if (fs.existsSync(file)) {
        res.setHeader('content-type', types[path.extname(file)] || 'application/octet-stream');
        return fs.createReadStream(file).pipe(res);
      }
    }
    res.statusCode = 404;
    res.end('Not found');
  })
  .listen(port, () => console.log(`http://localhost:${port}`));
