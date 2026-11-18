// 自动解释编排的纯逻辑：识别交付索引、解析链接、调用 JCAMP 读数。
// 所有解释结果必须带 receiptId，以便把记录和问题都绑回真实原文收件。
import { parseJcamp } from './jcamp.mjs';

export function isJcampText(bytes) {
  return /(^|\n)##[A-Za-z]/.test(bytes.toString('utf8'));
}

// delivery 索引：roots 是需处理的独立入口，resources 是同包可领取资源。
export function deliveryLinks(value, base) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.roots)) return null;
  const links = [];
  const add = (href) => {
    if (typeof href !== 'string' || !href) return;
    const url = new URL(href, base);
    if (!links.includes(url.href)) links.push(url.href);
  };
  for (const root of value.roots) add(root && root.href);
  for (const resource of value.resources || []) add(resource && resource.href);
  return { deliveryId: value.deliveryId, links };
}

export function interpretJcamp(bytes, receiptId) {
  return parseJcamp(bytes, receiptId);
}
