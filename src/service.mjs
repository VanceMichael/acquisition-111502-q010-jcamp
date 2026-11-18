import { createServer } from 'node:http';
import { Archive, identifier } from './archive.mjs';
import { retrieve } from './transport.mjs';
import { summarize } from './summary.mjs';
import { deliveryLinks, interpretJcamp, isJcampText } from './interpret.mjs';

export function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

async function requestBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 24 * 1024 * 1024) throw Object.assign(new Error('request_too_large'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('invalid_json'), { status: 400 });
  }
}

export async function createService({ directory, allowedOrigin }) {
  const archive = new Archive(directory);
  await archive.initialize();
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/health') return json(response, 200, { status: 'ok' });
      if (request.method === 'GET' && url.pathname === '/collections') return json(response, 200, await archive.list());
      const collection = url.pathname.match(/^\/collections\/([a-zA-Z0-9_.-]+)$/);
      if (collection && request.method === 'GET') return json(response, 200, await archive.collection(collection[1]));
      const records = url.pathname.match(/^\/collections\/([a-zA-Z0-9_.-]+)\/records$/);
      if (records && request.method === 'POST') return json(response, 201, await archive.addRecord(records[1], await requestBody(request)));
      const blob = url.pathname.match(/^\/receipts\/([a-f0-9]{64})\/body$/);
      if (blob && request.method === 'GET') {
        const receipt = await archive.receipt(blob[1]);
        response.writeHead(200, { 'content-type': receipt.mediaType });
        return response.end(await archive.body(blob[1]));
      }
      const receipt = url.pathname.match(/^\/receipts\/([a-f0-9]{64})$/);
      if (receipt && request.method === 'GET') return json(response, 200, await archive.receipt(receipt[1]));
      if (request.method === 'POST' && url.pathname === '/intakes') {
        const body = await requestBody(request);
        if (typeof body.contentBase64 !== 'string') throw Object.assign(new Error('missing_content'), { status: 400 });
        const bytes = Buffer.from(body.contentBase64, 'base64');
        const result = await archive.receive({ ...body, bytes, summary: summarize(bytes, body.mediaType || 'application/octet-stream') });
        return json(response, 201, result);
      }
      if (request.method === 'POST' && url.pathname === '/acquisitions') {
        const body = await requestBody(request);
        if (typeof body.entry !== 'string') throw Object.assign(new Error('missing_entry'), { status: 400 });
        const collectionId = identifier(body.collectionId);
        const receiptIds = [];
        const issues = [];

        // 先领取入口原文，再按交付索引领取每个链接；每个依赖都留下真实原文收件。
        const acquire = async (entry) => {
          const result = await retrieve(entry, allowedOrigin);
          const receipt = await archive.receive({
            collectionId, sourceKey: entry, revision: result.revision,
            mediaType: result.mediaType, bytes: result.bytes,
            summary: summarize(result.bytes, result.mediaType)
          });
          if (!receiptIds.includes(receipt.receiptId)) receiptIds.push(receipt.receiptId);
          return { receipt, bytes: result.bytes };
        };

        const interpret = async (bytes, receipt) => {
          if (!isJcampText(bytes)) return;
          try {
            const parsed = interpretJcamp(bytes, receipt.receiptId);
            for (const record of parsed.records) await archive.addRecord(collectionId, record);
            issues.push(...parsed.issues);
          } catch (error) {
            issues.push({
              receiptId: receipt.receiptId,
              reason: 'interpretation-failed:' + (error?.message || 'unknown'),
              location: 'byte:0-' + Math.max(bytes.length - 1, 0)
            });
          }
        };

        const entry = await acquire(body.entry);
        let links = null;
        try {
          links = deliveryLinks(JSON.parse(entry.bytes.toString('utf8')), body.entry);
        } catch {}
        if (links) {
          for (const link of links.links) {
            try {
              const acquired = await acquire(link);
              await interpret(acquired.bytes, acquired.receipt);
            } catch (error) {
              issues.push({
                reason: 'dependency-retrieval-failed:' + (error?.message || 'unknown'),
                location: link
              });
            }
          }
        } else {
          await interpret(entry.bytes, entry.receipt);
        }
        await archive.addIssues(collectionId, issues);
        return json(response, 201, { collectionId, receiptIds });
      }
      return json(response, 404, { error: 'not_found' });
    } catch (error) {
      json(response, error.status || 500, { error: error.status ? error.message : 'internal_error' });
    }
  });
  return { server, archive };
}
