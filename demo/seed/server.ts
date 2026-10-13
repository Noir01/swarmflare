import { createServer } from 'node:http';
import { handleSeedRequest } from './index';

const port = Number(process.env.PORT ?? 4173);
const server = createServer(async (incoming, outgoing) => {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
  const request = new Request(`http://127.0.0.1:${port}${incoming.url ?? '/'}`, {
    method: incoming.method,
    headers: Object.fromEntries(Object.entries(incoming.headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
    body: incoming.method === 'GET' || incoming.method === 'HEAD' ? undefined : Buffer.concat(chunks),
  });
  const response = await handleSeedRequest(request);
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => { responseHeaders[key] = value; });
  outgoing.writeHead(response.status, responseHeaders);
  outgoing.end(Buffer.from(await response.arrayBuffer()));
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Demo seed listening at http://127.0.0.1:${port}`);
});
