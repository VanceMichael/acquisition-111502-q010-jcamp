import { retrieve } from './transport.mjs';
import { summarize } from './summary.mjs';
import { parseJcamp } from './jcamp.mjs';

// 领取入口内容并接入自动解释：交付索引（delivery）逐个领取 roots，
// 每个自动取得的依赖都登记真实原文收件，再解释成 records 与 issues。

export function parseDelivery(bytes) {
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    if (value && typeof value === 'object' && typeof value.deliveryId === 'string' && Array.isArray(value.roots)) return value;
  } catch {}
  return null;
}

export function looksLikeJcamp(bytes) {
  return /^##[^=\r\n]*=/m.test(bytes.subarray(0, 65536).toString('utf8'));
}

async function safeRecord(archive, collectionId, record, receiptId) {
  try {
    await archive.addRecord(collectionId, record);
  } catch (error) {
    if (error.status === 409) {
      await archive.addIssues(collectionId, [{ reason: 'record_conflict', location: record.key, receiptId, detail: '同一键已存在不同内容，保留先归档版本' }]);
      return;
    }
    throw error;
  }
}

export async function interpretReceipt(archive, collectionId, receipt, bytes) {
  if (!looksLikeJcamp(bytes)) {
    await archive.addIssues(collectionId, [{ reason: 'unsupported_content', location: receipt.sourceKey, receiptId: receipt.receiptId, detail: '内容不是可识别的 JCAMP-DX 文本，未做解释' }]);
    return;
  }
  let parsed;
  try {
    parsed = parseJcamp(bytes.toString('utf8'));
  } catch (error) {
    await archive.addIssues(collectionId, [{ reason: 'interpretation_failed', location: receipt.sourceKey, receiptId: receipt.receiptId, detail: String((error && error.message) || error) }]);
    return;
  }
  for (const block of parsed.blocks) {
    const base = `${receipt.sourceKey}#block:${block.ordinal}`;
    await safeRecord(archive, collectionId, {
      kind: 'spectrum-block',
      key: base,
      value: block.value,
      provenance: [{ receiptId: receipt.receiptId, location: `lines:${block.startLine}-${block.endLine}` }]
    }, receipt.receiptId);
    for (const point of block.points) {
      await safeRecord(archive, collectionId, {
        kind: 'spectral-point',
        key: `${base}#${point.index}`,
        value: { block: block.value.title, index: point.index, x: point.x, y: point.y, position: point.location },
        provenance: [{ receiptId: receipt.receiptId, location: point.location }]
      }, receipt.receiptId);
    }
  }
  if (parsed.issues.length) {
    await archive.addIssues(collectionId, parsed.issues.map(issue => ({ ...issue, receiptId: receipt.receiptId })));
  }
}

export async function acquire(archive, collectionId, entry, allowedOrigin) {
  const first = await retrieve(entry, allowedOrigin);
  const receipt = await archive.receive({ collectionId, sourceKey: entry, revision: first.revision,
    mediaType: first.mediaType, bytes: first.bytes, summary: summarize(first.bytes, first.mediaType) });
  const receiptIds = [receipt.receiptId];
  const delivery = parseDelivery(first.bytes);
  if (!delivery) {
    await interpretReceipt(archive, collectionId, receipt, first.bytes);
    return { receiptIds };
  }
  for (const root of delivery.roots) {
    const href = root && typeof root === 'object' && typeof root.href === 'string' ? root.href : null;
    if (!href) {
      await archive.addIssues(collectionId, [{ reason: 'invalid_delivery_root', location: `${entry}#roots`, receiptId: receipt.receiptId, detail: '交付根条目缺少 href' }]);
      continue;
    }
    const target = new URL(href, entry).toString();
    let fetched;
    try {
      fetched = await retrieve(target, allowedOrigin);
    } catch (error) {
      await archive.addIssues(collectionId, [{ reason: 'source_unavailable', location: target, receiptId: receipt.receiptId, detail: `来源领取失败：${error.message}` }]);
      continue;
    }
    const rootReceipt = await archive.receive({ collectionId, sourceKey: target, revision: fetched.revision,
      mediaType: fetched.mediaType, bytes: fetched.bytes, summary: summarize(fetched.bytes, fetched.mediaType) });
    if (!receiptIds.includes(rootReceipt.receiptId)) receiptIds.push(rootReceipt.receiptId);
    try {
      await interpretReceipt(archive, collectionId, rootReceipt, fetched.bytes);
    } catch (error) {
      await archive.addIssues(collectionId, [{ reason: 'interpretation_failed', location: target, receiptId: rootReceipt.receiptId, detail: String((error && error.message) || error) }]);
    }
  }
  return { receiptIds };
}
