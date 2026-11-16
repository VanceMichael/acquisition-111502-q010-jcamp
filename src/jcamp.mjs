// JCAMP-DX 光谱表只读解释器。
// 输入原始文本，输出光谱块、逐点观测与问题清单；不做峰识别，也不下材料结论。
// 差分压缩的跨行检查点按 JCAMP 规则复核并重新锚定，不重复计入观测；
// 遇到不支持的表格表达或损坏子块时保留原表达与影响范围，不猜造数值凑点。

const SQZ_DIGITS = { '@': 0, A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, I: 9, a: -1, b: -2, c: -3, d: -4, e: -5, f: -6, g: -7, h: -8, i: -9 };
const DIF_DIGITS = { '%': 0, J: 1, K: 2, L: 3, M: 4, N: 5, O: 6, P: 7, Q: 8, R: 9, j: -1, k: -2, l: -3, m: -4, n: -5, o: -6, p: -7, q: -8, r: -9 };
const DUP_COUNTS = { S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9 };

const BLOCK_LABELS = new Set(['TITLE', 'JCAMP-DX', 'DATA TYPE', 'XUNITS', 'YUNITS', 'XFACTOR', 'YFACTOR', 'FIRSTX', 'LASTX', 'NPOINTS', 'DELTAX', 'XYDATA', 'XYPOINTS', 'END']);
const ENVELOPE_LABELS = new Set(['TITLE', 'JCAMP-DX', 'DATA TYPE', 'BLOCKS', 'END']);

const MAX_ISSUES = 200;
const MAX_OBSERVATIONS = 100000;
const MAX_EXCERPT = 1000;

// ---- 十进制精确缩放 ----
// 采集读数与 XFACTOR/YFACTOR 都是来源给出的十进制数，乘积也按十进制正确舍入，
// 避免引入二进制浮点噪声（例如 14 × 0.1 必须得到精确的 1.4）。

function decimalParts(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const text = String(Object.is(value, -0) ? 0 : value);
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match) return null;
  let digits = (match[2] + (match[3] || '')).replace(/^0+(?=\d)/, '');
  let exponent = (match[4] ? Number(match[4]) : 0) - (match[3] ? match[3].length : 0);
  const trimmed = digits.replace(/0+$/, '');
  exponent += digits.length - trimmed.length;
  digits = trimmed || '0';
  return { negative: match[1] === '-', mantissa: BigInt(digits), exponent };
}

function partsToNumber(negative, mantissa, exponent) {
  if (mantissa === 0n) return 0;
  const signed = negative ? -mantissa : mantissa;
  if (mantissa.toString().length <= 15 && Math.abs(exponent) <= 22) {
    const base = Number(signed);
    return exponent >= 0 ? base * 10 ** exponent : base / 10 ** -exponent;
  }
  return Number(signed) * 10 ** exponent;
}

export function decimalScale(value, factor) {
  const a = decimalParts(value);
  const b = decimalParts(factor);
  if (!a || !b) return value * factor;
  return partsToNumber(a.negative !== b.negative, a.mantissa * b.mantissa, a.exponent + b.exponent);
}

export function decimalAdd(left, right) {
  const a = decimalParts(left);
  const b = decimalParts(right);
  if (!a || !b || Math.abs(a.exponent - b.exponent) > 600) return left + right;
  const exponent = Math.min(a.exponent, b.exponent);
  const av = a.mantissa * 10n ** BigInt(a.exponent - exponent) * (a.negative ? -1n : 1n);
  const bv = b.mantissa * 10n ** BigInt(b.exponent - exponent) * (b.negative ? -1n : 1n);
  const sum = av + bv;
  return partsToNumber(sum < 0n, sum < 0n ? -sum : sum, exponent);
}

function nearlyEqual(a, b) {
  if (a === b) return true;
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

// ---- 数字编码（AFFN / PAC / SQZ / DIF / DUP）----

function parseAffn(text) {
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eEdD][+-]?\d+)?$/.test(text)) return null;
  const value = Number(text.replace(/[dD]/g, 'e'));
  return Number.isFinite(value) ? value : null;
}

// 绝对值：AFFN、PAC（显式符号）或 SQZ（@/A-I/a-i 加尾随数字）。
function decodeAbsolute(token) {
  const affn = parseAffn(token);
  if (affn !== null) return affn;
  const first = token[0];
  if (first && Object.hasOwn(SQZ_DIGITS, first)) {
    const rest = token.slice(1);
    if (rest === '' || /^(\d+(\.\d*)?|\.\d+)$/.test(rest)) {
      const digit = SQZ_DIGITS[first];
      const magnitude = Number(String(Math.abs(digit)) + rest);
      return digit < 0 ? -magnitude : magnitude;
    }
  }
  return null;
}

// 差分值：%/J-R/j-r 加尾随数字，表示相对前一值的差。
function decodeDif(token) {
  const first = token[0];
  if (first && Object.hasOwn(DIF_DIGITS, first)) {
    const rest = token.slice(1);
    if (rest === '' || /^\d+$/.test(rest)) {
      const digit = DIF_DIGITS[first];
      const magnitude = Number(String(Math.abs(digit)) + rest);
      return digit < 0 ? -magnitude : magnitude;
    }
  }
  return null;
}

// 重复标记：S-Z 表示前一值再重复 2-9 次。
function decodeDup(token) {
  if (token.length === 1 && Object.hasOwn(DUP_COUNTS, token)) return DUP_COUNTS[token];
  return null;
}

// ---- 表格解码 ----

// (X++(Y..Y))：每行以 X 检查点开头；续行首个 Y 是跨行检查点（前一点绝对值），
// 复核差分链并重新锚定，本身不计入观测。差分状态跨行延续。
function decodeXppY(ldr, context, addIssue, observations) {
  const { firstX, deltaX } = context;
  let lastValue = null;
  let isFirstLine = true;
  let limitNoted = false;

  const emit = (rawY, location) => {
    if (observations.length >= MAX_OBSERVATIONS) {
      if (!limitNoted) {
        limitNoted = true;
        addIssue({ reason: 'observation_limit_reached', location, detail: `观测超过 ${MAX_OBSERVATIONS} 条，后续数据未解释` });
      }
      return false;
    }
    const x = decimalAdd(firstX, decimalScale(observations.length, deltaX));
    observations.push({ x, rawY, location });
    return true;
  };

  for (const { line, text } of ldr.dataLines) {
    const trimmed = text.trim();
    if (!trimmed) continue;
    const tokens = trimmed.split(/\s+/);
    const yTokens = tokens.slice(1);
    const expectedX = decimalAdd(firstX, decimalScale(Math.max(observations.length - 1, 0), deltaX));
    const xCheckpoint = decodeAbsolute(tokens[0]);
    if (xCheckpoint === null) {
      addIssue({ reason: 'invalid_x_checkpoint', location: `line:${line},token:1`, detail: `X 检查点无法解析：${tokens[0]}` });
    } else if (!nearlyEqual(xCheckpoint, expectedX)) {
      addIssue({ reason: 'x_checkpoint_mismatch', location: `line:${line},token:1`, detail: `X 检查点 ${xCheckpoint}，按 FIRSTX/DELTAX 应为 ${expectedX}` });
    }
    if (yTokens.length === 0) {
      addIssue({ reason: 'missing_y_values', location: `line:${line}`, detail: '数据行只有 X 检查点，缺少 Y 值' });
      continue;
    }
    yTokens.forEach((token, offset) => {
      const location = `line:${line},token:${offset + 2}`;
      if (!isFirstLine && offset === 0) {
        const checkpoint = decodeAbsolute(token);
        if (checkpoint !== null) {
          if (lastValue !== null && !nearlyEqual(checkpoint, lastValue)) {
            addIssue({ reason: 'checkpoint_mismatch', location, detail: `Y 检查点 ${checkpoint}，跨行延续值 ${lastValue}` });
          }
          lastValue = checkpoint;
          return;
        }
        addIssue({ reason: 'checkpoint_not_absolute', location, detail: `续行首值应为绝对检查点：${token}` });
      }
      const absolute = decodeAbsolute(token);
      if (absolute !== null) {
        lastValue = absolute;
        emit(absolute, location);
        return;
      }
      const dif = decodeDif(token);
      if (dif !== null) {
        if (lastValue === null) {
          addIssue({ reason: 'dif_without_base', location, detail: `差分值缺少基准：${token}` });
          return;
        }
        lastValue = decimalAdd(lastValue, dif);
        emit(lastValue, location);
        return;
      }
      const dup = decodeDup(token);
      if (dup !== null) {
        if (lastValue === null) {
          addIssue({ reason: 'dup_without_base', location, detail: `重复标记缺少基准：${token}` });
          return;
        }
        for (let i = 0; i < dup; i++) if (!emit(lastValue, location)) break;
        return;
      }
      addIssue({ reason: 'undecodable_token', location, detail: `无法解释的编码：${token}` });
      lastValue = null;
    });
    isFirstLine = false;
  }
}

// (XY..XY)：每行是若干 "X,Y" 对，X、Y 均为绝对值，分别按 XFACTOR/YFACTOR 缩放。
function decodeXyXy(ldr, context, addIssue, observations) {
  const { xFactor } = context;
  let limitNoted = false;
  for (const { line, text } of ldr.dataLines) {
    const trimmed = text.trim();
    if (!trimmed) continue;
    const tokens = trimmed.split(/\s+/);
    for (let offset = 0; offset < tokens.length; offset++) {
      const token = tokens[offset];
      const location = `line:${line},token:${offset + 1}`;
      if (observations.length >= MAX_OBSERVATIONS) {
        if (!limitNoted) {
          limitNoted = true;
          addIssue({ reason: 'observation_limit_reached', location, detail: `观测超过 ${MAX_OBSERVATIONS} 条，后续数据未解释` });
        }
        break;
      }
      const parts = token.split(',');
      if (parts.length !== 2) {
        addIssue({ reason: 'invalid_xy_pair', location, detail: `XY 对无法解析：${token}` });
        continue;
      }
      const x = decodeAbsolute(parts[0]);
      const y = decodeAbsolute(parts[1]);
      if (x === null || y === null) {
        addIssue({ reason: 'undecodable_token', location, detail: `无法解释的编码：${token}` });
        continue;
      }
      observations.push({ x: decimalScale(x, xFactor), rawY: y, location });
    }
  }
}

// ---- 结构切分 ----

function splitLdrs(lines) {
  const ldrs = [];
  let current = null;
  lines.forEach((text, index) => {
    const line = index + 1;
    const match = /^##([^=]*?)(?:=(.*))?$/.exec(text);
    if (match) {
      current = { label: match[1], normalized: match[1].trim().toUpperCase(), value: match[2] ?? '', line, dataLines: [] };
      ldrs.push(current);
    } else if (current) {
      current.dataLines.push({ line, text });
    } else {
      current = { label: null, normalized: '', value: '', line, dataLines: [{ line, text }] };
      ldrs.push(current);
    }
  });
  return ldrs;
}

function ldrText(ldr) {
  let text = `##${ldr.label}=${ldr.value}`;
  for (const data of ldr.dataLines) text += `\n${data.text}`;
  return text;
}

function capText(text) {
  return text.length > MAX_EXCERPT ? `${text.slice(0, MAX_EXCERPT)}\n…[原文共 ${text.length} 字符，截断留存]` : text;
}

function blockFromPending(pending, endLine) {
  const meaningful = pending.filter(ldr => ldr.label !== null);
  if (!meaningful.length) return null;
  const titleLdr = meaningful.find(ldr => ldr.normalized === 'TITLE');
  return {
    title: titleLdr ? titleLdr.value.trim() : null,
    startLine: meaningful[0].line,
    endLine,
    ldrs: meaningful.filter(ldr => ldr !== titleLdr && ldr.normalized !== 'END')
  };
}

// LINK 信封与独立光谱块共用一套切分：DATA TYPE=LINK 之前的标签属于信封，
// 之后每个 ##TITLE= 开启一段独立上下文；##END= 依次闭合块与信封。
function segmentBlocks(ldrs, addIssue, totalLines) {
  const blocks = [];
  let pending = [];
  let current = null;
  let link = false;
  let declaredBlocks = null;

  const flushEnvelope = () => {
    for (const ldr of pending) {
      if (!ENVELOPE_LABELS.has(ldr.normalized)) {
        addIssue({ reason: 'unhandled_label', location: `line:${ldr.line}`, detail: capText(ldrText(ldr)) });
      }
      if (ldr.normalized === 'BLOCKS') {
        const raw = ldr.value.trim();
        if (/^\d+$/.test(raw)) declaredBlocks = Number(raw);
        else addIssue({ reason: 'invalid_label_value', location: `line:${ldr.line}`, detail: `##${ldr.label}=${raw} 不是整数` });
      }
    }
    pending = [];
  };

  const noteContentAfterEnd = (ldr) => {
    const extra = ldr.dataLines.find(data => data.text.trim());
    if (extra) addIssue({ reason: 'content_after_end', location: `line:${extra.line}`, detail: '##END= 之后仍有内容' });
  };

  for (const ldr of ldrs) {
    if (ldr.label === null) {
      addIssue({ reason: 'unlabeled_content', location: `line:${ldr.line}`, detail: capText(ldr.dataLines.map(data => data.text).join('\n')) });
      continue;
    }
    const name = ldr.normalized;
    if (current) {
      if (name === 'END') {
        noteContentAfterEnd(ldr);
        current.endLine = ldr.line;
        current = null;
        continue;
      }
      if (name === 'TITLE') {
        addIssue({ reason: 'unclosed_block', location: `lines:${current.startLine}-${ldr.line - 1}`, detail: '下一段 TITLE 出现前缺少 ##END=' });
        current.endLine = ldr.line - 1;
        current = { title: ldr.value.trim(), startLine: ldr.line, endLine: ldr.line, ldrs: [] };
        blocks.push(current);
        continue;
      }
      current.ldrs.push(ldr);
      current.endLine = ldr.dataLines.length ? ldr.dataLines[ldr.dataLines.length - 1].line : ldr.line;
      continue;
    }
    if (name === 'TITLE') {
      if (link) {
        flushEnvelope();
        current = { title: ldr.value.trim(), startLine: ldr.line, endLine: ldr.line, ldrs: [] };
        blocks.push(current);
      } else if (pending.some(entry => entry.normalized === 'TITLE')) {
        const previous = blockFromPending(pending, ldr.line - 1);
        if (previous) {
          addIssue({ reason: 'unclosed_block', location: `lines:${previous.startLine}-${previous.endLine}`, detail: '下一段 TITLE 出现前缺少 ##END=' });
          blocks.push(previous);
        }
        pending = [];
        current = { title: ldr.value.trim(), startLine: ldr.line, endLine: ldr.line, ldrs: [] };
        blocks.push(current);
      } else {
        pending.push(ldr);
      }
      continue;
    }
    if (name === 'DATA TYPE' && ldr.value.trim().toUpperCase() === 'LINK' && blocks.length === 0 && !link) {
      link = true;
      pending.push(ldr);
      continue;
    }
    if (name === 'END') {
      noteContentAfterEnd(ldr);
      if (link) {
        flushEnvelope();
        if (declaredBlocks !== null && declaredBlocks !== blocks.length) {
          addIssue({ reason: 'block_count_mismatch', location: `line:${ldr.line}`, detail: `##BLOCKS= 声明 ${declaredBlocks} 段，实际 ${blocks.length} 段` });
        }
        declaredBlocks = null;
        link = false;
        continue;
      }
      if (pending.length) {
        const block = blockFromPending(pending, ldr.line);
        if (block) blocks.push(block);
        pending = [];
        continue;
      }
      addIssue({ reason: 'stray_end', location: `line:${ldr.line}`, detail: '没有可闭合的块或信封' });
      continue;
    }
    pending.push(ldr);
  }
  if (current) {
    addIssue({ reason: 'truncated_block', location: `lines:${current.startLine}-${totalLines}`, detail: '文件结束时块未闭合（缺少 ##END=）' });
    current.endLine = totalLines;
  } else if (link) {
    addIssue({ reason: 'truncated_envelope', location: `lines:1-${totalLines}`, detail: 'LINK 信封在文件结束时未闭合' });
    flushEnvelope();
  }
  if (pending.length && !link) {
    const block = blockFromPending(pending, totalLines);
    if (block) blocks.push(block);
  }
  blocks.forEach((block, ordinal) => { block.ordinal = ordinal; });
  return blocks;
}

// ---- 块解释：每段使用自己的单位与缩放上下文，互不串扰 ----

function interpretBlock(block, addIssue) {
  const known = new Map();
  const unhandled = [];
  for (const ldr of block.ldrs) {
    if (BLOCK_LABELS.has(ldr.normalized)) {
      if (known.has(ldr.normalized)) addIssue({ reason: 'duplicate_label', location: `line:${ldr.line}`, detail: `重复标签：##${ldr.label}=` });
      else known.set(ldr.normalized, ldr);
    } else {
      unhandled.push({ line: ldr.line, text: capText(ldrText(ldr)) });
    }
  }

  const textOf = (name) => {
    const ldr = known.get(name);
    return ldr ? ldr.value.trim() : null;
  };
  const numberOf = (name) => {
    const ldr = known.get(name);
    if (!ldr) return null;
    const value = parseAffn(ldr.value.trim());
    if (value === null) {
      addIssue({ reason: 'invalid_label_value', location: `line:${ldr.line}`, detail: `##${ldr.label}=${ldr.value.trim()} 不是数值` });
      return null;
    }
    return value;
  };

  const xFactorLabel = numberOf('XFACTOR');
  const yFactorLabel = numberOf('YFACTOR');
  const xFactor = xFactorLabel === null ? 1 : xFactorLabel;
  const yFactor = yFactorLabel === null ? 1 : yFactorLabel;
  const firstX = numberOf('FIRSTX');
  const lastX = numberOf('LASTX');
  const deltaX = numberOf('DELTAX');
  let declaredPoints = null;
  const npointsLdr = known.get('NPOINTS');
  if (npointsLdr) {
    const raw = npointsLdr.value.trim();
    if (/^\d+$/.test(raw)) declaredPoints = Number(raw);
    else addIssue({ reason: 'invalid_label_value', location: `line:${npointsLdr.line}`, detail: `##${npointsLdr.label}=${raw} 不是整数点数` });
  }

  const observations = [];
  const tableSummaries = [];
  const tables = block.ldrs.filter(ldr => ldr.normalized === 'XYDATA' || ldr.normalized === 'XYPOINTS');
  for (const ldr of tables) {
    const format = ldr.value.trim();
    const normalizedFormat = format.replace(/\s+/g, '').toUpperCase();
    const endLine = ldr.dataLines.length ? ldr.dataLines[ldr.dataLines.length - 1].line : ldr.line;
    const range = endLine === ldr.line ? `line:${ldr.line}` : `lines:${ldr.line}-${endLine}`;
    tableSummaries.push({ label: ldr.normalized, format, line: ldr.line });
    const hasData = ldr.dataLines.some(data => data.text.trim());
    if (ldr.normalized === 'XYDATA' && normalizedFormat === '(X++(Y..Y))') {
      if (!hasData) {
        addIssue({ reason: 'empty_table', location: range, detail: 'XYDATA 没有数据行' });
        continue;
      }
      let spacing = deltaX;
      if (spacing === null && firstX !== null && lastX !== null && declaredPoints !== null && declaredPoints > 1) {
        spacing = (lastX - firstX) / (declaredPoints - 1);
      }
      if (firstX === null || spacing === null) {
        addIssue({ reason: 'missing_x_spacing', location: range, detail: '缺少 FIRSTX 或 DELTAX，且无法由 LASTX/NPOINTS 推导；未猜造 X 位置' });
        continue;
      }
      decodeXppY(ldr, { firstX, deltaX: spacing }, addIssue, observations);
      continue;
    }
    if (ldr.normalized === 'XYPOINTS' && normalizedFormat === '(XY..XY)') {
      if (!hasData) {
        addIssue({ reason: 'empty_table', location: range, detail: 'XYPOINTS 没有数据行' });
        continue;
      }
      decodeXyXy(ldr, { xFactor }, addIssue, observations);
      continue;
    }
    addIssue({ reason: 'unsupported_table_format', location: range, detail: `不支持的表格表达：##${ldr.label}=${format}`, excerpt: capText(ldrText(ldr)) });
  }

  if (tables.length && !npointsLdr) {
    addIssue({ reason: 'missing_label', location: `lines:${block.startLine}-${block.endLine}`, detail: '缺少 ##NPOINTS=，无法核对声明点数' });
  }

  const points = [];
  for (const observation of observations) {
    const y = decimalScale(observation.rawY, yFactor);
    if (!Number.isFinite(observation.x) || !Number.isFinite(y)) {
      addIssue({ reason: 'non_finite_value', location: observation.location, detail: '缩放后得到非有限数值，未纳入观测' });
      continue;
    }
    points.push({ index: points.length, x: observation.x, y, location: observation.location });
  }

  if (declaredPoints !== null && declaredPoints !== points.length) {
    addIssue({ reason: 'point_count_mismatch', location: `lines:${block.startLine}-${block.endLine}`, detail: `声明 ${declaredPoints} 点，实收 ${points.length} 点` });
  }

  const value = {
    title: block.title,
    dataType: textOf('DATA TYPE'),
    xUnits: textOf('XUNITS'),
    yUnits: textOf('YUNITS'),
    xFactor,
    yFactor,
    firstX,
    lastX,
    deltaX,
    declaredPoints,
    receivedPoints: points.length,
    tables: tableSummaries
  };
  if (unhandled.length) value.unhandledLabels = unhandled;
  return { ordinal: block.ordinal, title: block.title, startLine: block.startLine, endLine: block.endLine, value, points };
}

// 解析一份 JCAMP-DX 文本，返回 { blocks, issues }。
// blocks[].value 是 spectrum-block 记录内容，blocks[].points 是逐点观测（含原编码位置）；
// issues 每项含 reason、location（原行/记号范围），并尽量保留原表达。
export function parseJcamp(text) {
  const issues = [];
  let limitNoted = false;
  const addIssue = (issue) => {
    if (issues.length >= MAX_ISSUES) {
      if (!limitNoted) {
        limitNoted = true;
        issues.push({ reason: 'issue_limit_reached', location: 'file', detail: `问题超过 ${MAX_ISSUES} 条，后续不再逐条记录` });
      }
      return;
    }
    issues.push(issue);
  };
  const lines = String(text).split(/\r?\n/);
  const ldrs = splitLdrs(lines);
  const rawBlocks = segmentBlocks(ldrs, addIssue, lines.length);
  const blocks = rawBlocks.map(block => interpretBlock(block, addIssue));
  return { blocks, issues };
}
